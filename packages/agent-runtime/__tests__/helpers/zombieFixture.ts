// Test-only shell owner: hold the child on fd3 until its parent has exec'd
// sleep. A fast child can otherwise be reaped by the shell before that exec.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { ownedOnce } from './ownedCleanup.js'

interface Identity { pid: number; state: string; parent: number; group: number; start: string }

export function processIdentity(pid: number): Identity | null {
  let stat: string
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (!fields[0] || !/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[1] ?? '') || !/^\d+$/.test(fields[2] ?? '')) {
    throw new Error(`invalid stat for owned pid ${pid}`)
  }
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]! }
}

const live = (identity: Identity | null) => identity !== null && !['Z', 'X'].includes(identity.state)
const same = (a: Identity | null, b: Identity | null) => a !== null && b !== null && a.pid === b.pid && a.start === b.start && a.group === b.group
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5000)
    })])
  } finally { clearTimeout(timer) }
}

export class ZombieFixture {
  readonly child: ChildProcess
  readonly gate: Duplex
  readonly exited: Promise<void>
  readonly closed: Promise<void>
  readonly gateClosed: Promise<void>
  readonly stdoutClosed: Promise<void>
  private readonly once = ownedOnce<void>()
  private readonly sleep = realpathSync('/bin/sleep')
  private leaderIdentity: Identity | null = null
  private helperIdentity: Identity | null = null
  private released = false
  private spawnError: Error | null = null
  private cancelRead: (() => void) | null = null
  helper = 0
  didClose = false

  constructor(mode: 'gated' | 'reaped' = 'gated') {
    if (realpathSync('/bin/sh') === this.sleep) throw new Error('canonical shell and sleep must differ')
    const script = mode === 'gated'
      ? '(read -r release <&3) & p=$!; printf "%s\\n" "$p"; exec /bin/sleep 30'
      : '(exec true) & p=$!; wait "$p"; printf "%s\\n" "$p"; exec /bin/sleep 30'
    this.child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] })
    this.gate = this.child.stdio[3] as Duplex
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve())
      this.child.on('error', (error) => { this.spawnError = error; if (!this.child.pid) resolve() })
    })
    this.closed = new Promise((resolve) => this.child.once('close', () => { this.didClose = true; resolve() }))
    this.gateClosed = new Promise((resolve) => this.gate.once('close', () => resolve()))
    this.stdoutClosed = new Promise((resolve) => this.child.stdout!.once('close', () => resolve()))
    this.gate.on('error', () => {}) // write callbacks report EPIPE; cleanup still owns close
  }

  get leader(): number { return this.child.pid ?? 0 }
  private get leaderExited(): boolean {
    return this.spawnError !== null || this.child.exitCode !== null || this.child.signalCode !== null
  }

  private readPid(): Promise<number> {
    return new Promise((resolve, reject) => {
      let out = ''
      const finish = (error?: Error, pid?: number) => {
        clearTimeout(timer)
        this.child.stdout!.off('data', data).off('end', eof).off('error', failed)
        this.child.off('exit', early).off('error', failed)
        this.cancelRead = null
        if (error) reject(error)
        else resolve(pid!)
      }
      const failed = (error: Error) => finish(error)
      const eof = () => finish(new Error('helper PID EOF'))
      const early = () => finish(new Error('fixture leader exited before helper PID'))
      const data = (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.length > 32 || (out.includes('\n') && !/^[1-9]\d*\n$/.test(out))) return finish(new Error('invalid helper PID record'))
        if (!out.endsWith('\n')) return
        const pid = Number(out.trim())
        if (!Number.isSafeInteger(pid) || pid === this.leader) return finish(new Error('invalid helper PID'))
        finish(undefined, pid)
      }
      const timer = setTimeout(() => finish(new Error('helper PID deadline')), 5000)
      this.cancelRead = () => finish(new Error('helper PID read cancelled by cleanup'))
      this.child.stdout!.on('data', data).once('end', eof).once('error', failed)
      this.child.once('exit', early).once('error', failed)
      if (this.spawnError) finish(this.spawnError)
      else if (this.leaderExited) early()
    })
  }

  async setup(): Promise<void> {
    if (!Number.isSafeInteger(this.leader) || this.leader <= 0) throw new Error('fixture never spawned')
    this.leaderIdentity = processIdentity(this.leader)
    if (!live(this.leaderIdentity) || this.leaderIdentity!.group !== this.leader) throw new Error('missing owned leader identity')
    this.helper = await this.readPid()
    const helper = processIdentity(this.helper)
    if (helper && helper.parent === this.leader && helper.group === this.leader) this.helperIdentity = helper
    const deadline = Date.now() + 5000
    while (readlinkSync(`/proc/${this.leader}/exe`) !== this.sleep) {
      this.checkLeader()
      if (Date.now() > deadline) throw new Error('leader not exec\'d before deadline')
      await delay()
    }
    this.checkLeader()
  }

  private checkLeader(): void {
    if (this.leaderExited || !same(processIdentity(this.leader), this.leaderIdentity)) throw new Error('owned leader identity changed or exited')
  }

  /** Also used once by completed adverse-order setup; no poll hides rejection. */
  validateReady(): Identity {
    this.checkLeader()
    if (readlinkSync(`/proc/${this.leader}/exe`) !== this.sleep) throw new Error('leader not exec\'d')
    const helper = processIdentity(this.helper)
    if (!live(helper)) throw new Error('helper missing or nonlive before release')
    if (!same(helper, this.helperIdentity) || helper!.parent !== this.leader || helper!.group !== this.leader) {
      throw new Error('owned helper identity changed before release')
    }
    return helper!
  }

  async zombie(): Promise<{ leader: number; zombie: number }> {
    const helper = this.validateReady()
    this.released = true // no longer use the gate as a cleanup pin once write starts
    await bounded(new Promise<void>((resolve, reject) => this.gate.write('\n', (error) => error ? reject(error) : resolve())), 'gate release deadline')
    this.gate.end()
    const deadline = Date.now() + 5000
    for (;;) {
      this.checkLeader()
      const current = processIdentity(this.helper)
      if (!same(current, helper)) throw new Error('owned helper identity disappeared or changed after release')
      if (current!.state === 'Z') return { leader: this.leader, zombie: this.helper }
      if (Date.now() > deadline) throw new Error(`pid ${this.helper} never became a zombie (state ${current!.state})`)
      await delay()
    }
  }

  cleanup(): Promise<void> { return this.once.run(() => this.stop()) }

  private async stop(): Promise<void> {
    const errors: unknown[] = []
    const attempt = async (body: () => void | Promise<void>) => {
      try { await body() } catch (error) { errors.push(error) }
    }
    // Keep the blocked helper alive until the signal. Closing fd3 first can
    // empty a leaderless group and make its number reusable.
    await attempt(() => {
      const helper = this.helperIdentity && processIdentity(this.helper)
      const gatedPin = !this.released && live(helper) && same(helper, this.helperIdentity) && helper!.group === this.leader
      if (gatedPin) process.kill(-this.leader, 'SIGKILL')
      else if (!this.leaderExited && this.leader > 0) {
        // This check versus Bun's native reap is not an OS-level atomic pin.
        if (this.released) {
          this.checkLeader()
          process.kill(-this.leader, 'SIGKILL')
        } else this.child.kill('SIGKILL') // no verified helper: only direct ownership
      }
    })
    this.cancelRead?.()
    this.gate.destroy()
    await Promise.all([
      attempt(() => bounded(this.exited, 'owned leader exit did not join')),
      attempt(() => bounded(this.closed, 'owned process close did not join')),
      attempt(() => bounded(this.gateClosed, 'owned gate close did not join')),
      attempt(() => bounded(this.stdoutClosed, 'owned stdout close did not join')),
      attempt(async () => {
        const deadline = Date.now() + 5000
        for (;;) {
          const helper = this.helperIdentity && processIdentity(this.helper)
          if (!helper || !same(helper, this.helperIdentity) || !live(helper)) return
          if (Date.now() > deadline) throw new Error('owned helper still live after cleanup')
          await delay()
        }
      }),
    ])
    if (errors.length) throw new AggregateError(errors, 'zombie fixture cleanup failed')
  }
}

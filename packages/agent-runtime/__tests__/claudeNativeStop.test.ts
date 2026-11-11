// @reads: packages/agent-runtime/__tests__/fixtures/**
// The stop's native account on the production composition (task 4.1 A3, R4
// bindings B1-B6): the real ClaudeSession, the pinned SDK's query(), the
// owned spawner and the fake CLI. Nothing here mocks the SDK.
//
// - O1: a CLI exits 3 on its own, and an external supervisor that awaited
//   the exit record then kills. The pre-stop native evidence must survive.
//   The stop fails with a NativeExitFailure for that generation, after the
//   leader, group and jobs are all joined. No SDK error class is required.
// - The delayed-projection witness: the exit recorder requests stop
//   synchronously without awaiting it. An external owner observes the same
//   terminal outcome.
// - B6: a recorder that requests stop on the spawn record, inside query(),
//   still finds the process owned. Stop terminates, joins and accounts it.
// - O2-O4: an owned SIGTERM and a native exit 0 stop cleanly. A CLI that
//   traps SIGTERM and exits 3 is an unknown end, so the stop fails.
// - F1: a spawn that fails (an existing executable, a nonexistent absolute
//   cwd) leaves the owner's original error E; the failed stop keeps E itself,
//   whatever replacement the SDK reported.
// - F2: a stderr tail whose EOF comes after the leader is gone (a helper in
//   its own session holds the pipe until released) and a recorder that throws
//   only for that tail. The stop stays pending while that producer is live,
//   and after release it fails with E kept, everything joined.
// - G1: a helper in its own session holds stderr (and, in the protocol
//   variant, the CLI's fd 3, the real stdout pipe) past killMs. The recording
//   is cut off; the stop fails with the cutoff error and the earlier recorder
//   error by identity, and only after the SDK-facing stdout has ended and
//   closed and the SDK's reader has detached. Nothing records after the stop.
// Every fixture helper is reaped through its own release file and recorded
// pid, awaited to its end on every path (HELPER-CLEANUP lines in the output).
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { ClaudeSession } from '../src/claude/session.js'
import type { ProcessExitReceipt } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { WireFrame } from '../src/options.js'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import { liveGroupMembers } from '../src/process/processGroup.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const sessions: ClaudeSession[] = []
afterAll(async () => {
  await Promise.allSettled(sessions.map((s) => s.kill()))
})

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Settles within `ms`, else rejects: a hanging stop must fail the test, not stall the suite. */
function within<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
}

async function stopFailure(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await within(promise)
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected the stop to fail')
}

type Observer = (s: ClaudeSession, event: string, frame: WireFrame) => void

interface Options {
  /** Launch cwd relative to the fake home root (it need not exist). */
  cwd?: string
  /** The recorder throws what this returns for a frame (null: it records). */
  throwOn?(frame: WireFrame): Error | null
}

interface Owned {
  pid: number
  exited: unknown
  evidence: { exit: { kind: string; error?: Error } } | null
  stdout: Readable
  observerFailures: unknown[]
}

/** A session on the fake CLI whose recorder hands each lifecycle event to `observe`. */
function session(observe: Observer = () => {}, options: Options = {}) {
  const home = fakeClaudeHome()
  const frames: WireFrame[] = []
  const launch = { ...home.launch(), ...(options.cwd ? { cwd: join(home.root, options.cwd) } : {}) }
  const s: ClaudeSession = new ClaudeSession({
    launch,
    callbacks: { onEvent: () => {}, onTurnResult: () => {}, onProcessEnd: () => {} },
    wire: {
      record: (f) => {
        frames.push(f)
        if (f.direction === 'lifecycle') observe(s, (JSON.parse(f.text) as { event: string }).event, f)
        const thrown = options.throwOn?.(f)
        if (thrown) throw thrown
      },
    },
    terminate: { graceMs: 300, killMs: 3000 },
  })
  sessions.push(s)
  const owners = () => (s as unknown as { generations: Array<{ owned: Owned | null }> }).generations.map((g) => g.owned)
  return { s, frames, owners, root: home.root }
}

/** Whether `target` is `root` or nested anywhere under its causes, by identity. */
function inCauseGraph(root: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (root === target) return true
  if (typeof root !== 'object' || root === null || seen.has(root)) return false
  seen.add(root)
  const nested = [...((root as { causes?: unknown[] }).causes ?? []), (root as { cause?: unknown }).cause]
  return nested.some((cause) => inCauseGraph(cause, target, seen))
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await tick(10)
  }
}

/** Whether `done` holds within `ms`. */
async function reached(done: () => boolean, ms: number): Promise<boolean> {
  try {
    await until(done, ms)
    return true
  } catch {
    return false
  }
}

/**
 * Join a fixture helper through its own handles only, on every path: write
 * its release file, take its pid as known or as recorded in its pid file,
 * await its end, and SIGKILL that one pid only if it outlives the bound. The
 * outcome is logged; a helper that cannot be shown ended fails the test.
 */
async function reapHelper(label: string, pidFile: string, release: string, known: number | null): Promise<void> {
  if (!existsSync(release)) writeFileSync(release, '')
  const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null
  const pid = known ?? recorded
  const outcome: Record<string, unknown> = { label, pid, source: known !== null ? 'known' : recorded !== null ? 'pid-file' : 'none' }
  try {
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
      outcome.result = 'no-recorded-pid'
      return
    }
    if (await reached(() => !alive(pid), 2000)) {
      outcome.result = 'exited-on-release'
      return
    }
    process.kill(pid, 'SIGKILL')
    if (await reached(() => !alive(pid), 2000)) {
      outcome.result = 'killed'
      return
    }
    outcome.result = 'still-alive'
    throw new Error(`fixture helper ${pid} outlived its release and SIGKILL`)
  } finally {
    console.log(`HELPER-CLEANUP ${JSON.stringify(outcome)}`)
  }
}

const natives = (error: AgentRuntimeError) => error.causes.filter((c): c is NativeExitFailure => c instanceof NativeExitFailure)

/** Every owned leader has exited and its group has no live member; no job is left. */
function joined(h: ReturnType<typeof session>) {
  for (const owned of h.owners()) {
    expect(owned).not.toBeNull()
    expect(owned!.exited).not.toBeNull()
    expect(alive(owned!.pid)).toBe(false)
    expect(liveGroupMembers(owned!.pid)).toEqual([])
  }
  expect(h.s.lifecycle.jobs.size).toBe(0)
}

describe('the stop accounts native evidence (A3)', () => {
  test('O1: an exit 3 an external supervisor saw before its kill fails the stop with that native fact', async () => {
    let sawExit!: () => void
    const exitRecorded = new Promise<void>((resolve) => (sawExit = resolve))
    const h = session((_s, event) => event === 'exit' && sawExit())
    await h.s.start()
    void (await h.s.send('crash')).result.catch(() => {})
    // The supervisor's own continuation, after the exit record, is the first stop.
    const stop = exitRecorded.then(() => h.s.kill())
    const error = await stopFailure(stop)
    expect(error.category).toBe('stop')
    const [native, ...more] = natives(error)
    expect(more).toEqual([])
    expect(native!.facts).toMatchObject({ generation: 1, code: 3, signal: null, observedBeforeStop: true })
    joined(h)
  })

  test('delayed projection: the exit recorder requests stop without awaiting; an external owner sees the same outcome', async () => {
    let inner: Promise<ProcessExitReceipt> | null = null
    const h = session((s, event) => {
      if (event !== 'exit' || inner) return
      inner = s.kill()
      inner.catch(() => {})
    })
    await h.s.start()
    void (await h.s.send('crash')).result.catch(() => {})
    while (!inner) await tick(5)
    const error = await stopFailure(h.s.kill())
    expect(natives(error).map((n) => n.facts)).toEqual([{ generation: 1, pid: h.owners()[0]!.pid, code: 3, signal: null, observedBeforeStop: true }])
    // The recorder's own call shares the terminal outcome, or was refused as an in-job caller.
    const own = await stopFailure(inner!)
    expect(own === error || own.category === 'internal').toBe(true)
    joined(h)
  })

  test('B6: a stop requested by the spawn record inside query() still terminates, joins and accounts the created process', async () => {
    let inner: Promise<ProcessExitReceipt> | null = null
    const h = session((s, event) => {
      if (event !== 'spawn' || inner) return
      inner = s.kill()
      inner.catch(() => {})
    })
    const start = h.s.start()
    start.catch(() => {})
    while (!inner) await tick(5)
    const receipt = await within(h.s.kill())
    expect(receipt.processes).toHaveLength(1)
    expect(receipt.processes[0]).toMatchObject({ generation: 1, state: 'exited', groupCleared: true })
    expect((await stopFailure(start)).category).toBe('stopped')
    joined(h)
    // Nothing was created after the stop won.
    expect(h.owners()).toHaveLength(1)
    expect(h.frames.filter((f) => f.direction === 'lifecycle' && f.text.startsWith('{"event":"spawn"'))).toHaveLength(1)
  })

  test('O2: an owned SIGTERM ends a hung CLI and the stop succeeds', async () => {
    const h = session()
    await h.s.start()
    void (await h.s.send('hang')).result.catch(() => {})
    const receipt = await within(h.s.kill())
    expect(receipt.processes[0]).toMatchObject({ generation: 1, state: 'exited', code: null, signal: 'SIGTERM', escalated: false })
    joined(h)
  })

  test('O3: a native exit 0 before the stop is clean and the stop succeeds', async () => {
    const h = session()
    await h.s.start()
    await (await h.s.send('quit')).result
    while (!h.owners()[0]!.exited) await tick(5)
    const receipt = await within(h.s.kill())
    expect(receipt.processes[0]).toMatchObject({ generation: 1, state: 'exited', code: 0, signal: null })
    joined(h)
  })

  test('O4: a CLI that traps the owned SIGTERM and exits 3 is an unknown end; the stop fails', async () => {
    const h = session()
    await h.s.start()
    await (await h.s.send('trap3')).result
    const error = await stopFailure(h.s.kill())
    expect(error.category).toBe('stop')
    expect(natives(error).map((n) => n.facts)).toEqual([{ generation: 1, pid: h.owners()[0]!.pid, code: 3, signal: null, observedBeforeStop: false }])
    joined(h)
  })

  test('F1: a spawn failure keeps the owner\'s original error by identity in the failed stop', async () => {
    const h = session(() => {}, { cwd: 'missing-cwd' })
    const startError = await stopFailure(h.s.start())
    expect(startError.category).toBe('dependency')
    const [owned, ...more] = h.owners()
    expect(more).toEqual([])
    expect(owned!.pid).toBeNull()
    expect(owned!.evidence!.exit.kind).toBe('spawn-failed')
    const original = owned!.evidence!.exit.error!
    expect(original).toBeInstanceOf(Error)
    const stop = await stopFailure(h.s.kill())
    expect(stop.category).toBe('stop')
    expect(inCauseGraph(stop, original)).toBe(true)
    expect(natives(stop)).toEqual([])
    expect(h.s.lifecycle.jobs.size).toBe(0)
  })

  test('F2: a late stderr tail whose recording throws holds the stop until that producer closes, then the error is kept', async () => {
    const tailError = new Error('the recorder refused the stderr tail')
    const h = session(() => {}, { throwOn: (f) => (f.direction === 'stderr' && f.text === 'TAIL' ? tailError : null) })
    const pidFile = join(h.root, 'tail-helper.pid')
    const release = join(h.root, 'release')
    let helper: number | null = null
    try {
      await h.s.start()
      await (await h.s.send(`stderr-tail ${h.root}`)).result
      helper = Number(readFileSync(pidFile, 'utf8'))
      expect(alive(helper)).toBe(true)
      let settled = false
      const stop = h.s.kill()
      void stop.then(() => (settled = true), () => (settled = true))
      await until(() => h.owners()[0]!.exited !== null)
      await tick(300)
      // The leader is gone; the stderr producer is still live, so the stop has not settled.
      expect([settled, h.s.state, alive(h.owners()[0]!.pid), alive(helper)]).toEqual([false, 'stopping', false, true])
      writeFileSync(release, '')
      const error = await stopFailure(stop)
      expect(error.category).toBe('stop')
      expect(error.causes).toContain(tailError)
      expect(natives(error)).toEqual([])
      joined(h)
      await until(() => !alive(helper!))
    } finally {
      await reapHelper('F2', pidFile, release, helper)
    }
  })

  for (const mode of ['stderr', 'protocol'] as const) {
    test(`G1 (${mode}): a holder past killMs cuts the recording off; the stop fails with that cause and the earlier one after the SDK-facing stdout is terminal`, async () => {
      const earlyError = new Error('the recorder refused the held stderr line')
      const h = session(() => {}, { throwOn: (f) => (f.direction === 'stderr' && f.text === 'HELD' ? earlyError : null) })
      const file = (name: string) => join(h.root, name)
      const rejections: unknown[] = []
      const onRejection = (reason: unknown) => rejections.push(reason)
      process.on('unhandledRejection', onRejection)
      let helper: number | null = null
      let reaped = false
      try {
        await h.s.start()
        const owned = h.owners()[0]!
        // The SDK reads the owner's stdout (the recording wrapper), not the raw pipe.
        const sdkStdout = owned.stdout
        const order: string[] = []
        for (const event of ['end', 'close', 'error'] as const) sdkStdout.once(event, () => order.push(event))
        await (await h.s.send(`pipes-hold ${h.root} ${mode}`)).result
        helper = Number(readFileSync(file('hold-helper.pid'), 'utf8'))
        await until(() => existsSync(file('helper-fds.json')) && h.frames.some((f) => f.direction === 'stderr' && f.text === 'HELD'))
        // The wrapper runs the CLI with 3>&1 1>/dev/null: the protocol pipe is fd 3.
        const leaderFds = JSON.parse(readFileSync(file('leader-fds.json'), 'utf8')) as Record<string, string | null>
        const helperFds = JSON.parse(readFileSync(file('helper-fds.json'), 'utf8')) as Record<string, string | null>
        expect(leaderFds.fd3).not.toBeNull()
        expect(leaderFds.fd1).not.toBe(leaderFds.fd3)
        expect(helperFds.fd2).toBe(leaderFds.fd2!)
        // An ignored slot is /dev/null, still open: compare identities, not presence.
        expect(helperFds.fd3 === leaderFds.fd3).toBe(mode === 'protocol')
        // The SDK's line reader is attached to that stdout.
        expect(sdkStdout.listenerCount('data')).toBeGreaterThan(0)
        const stop = h.s.kill()
        void stop.then(() => order.push('settled'), () => order.push('settled'))
        await until(() => owned.exited !== null)
        await tick(300)
        // The leader is gone and the helper still holds its pipes: the stop waits on the bound.
        expect([order.includes('settled'), alive(owned.pid), alive(helper)]).toEqual([false, false, true])
        // Only a held protocol pipe keeps the SDK-facing stdout from ending.
        expect(sdkStdout.readableEnded).toBe(mode === 'stderr')
        const error = await stopFailure(stop)
        const recorded = h.frames.length
        expect(error.category).toBe('stop')
        // The owner's failures: the earlier recorder error, then the cutoff, both kept by identity.
        const [early, cutoff, ...more] = owned.observerFailures
        expect(more).toEqual([])
        expect(early).toBe(earlyError)
        expect(cutoff).toBeInstanceOf(AgentRuntimeError)
        expect((cutoff as AgentRuntimeError).message).toBe(`agent process ${owned.pid} kept its stdio open 3000 ms after exit; its recording was cut off`)
        expect(error.causes).toContain(earlyError)
        expect(error.causes).toContain(cutoff)
        expect(natives(error)).toEqual([])
        // The SDK-facing stdout ended and closed before the stop settled, and its reader let go.
        expect(order).toEqual(['end', 'close', 'settled'])
        expect(sdkStdout.listenerCount('data')).toBe(0)
        joined(h)
        await reapHelper(`G1-${mode}`, file('hold-helper.pid'), file('release'), helper)
        reaped = true
        // The helper wrote LATE on release: nothing was recorded after the stop, and nothing rejected unhandled.
        await tick(100)
        expect(h.frames.length).toBe(recorded)
        expect(rejections).toEqual([])
      } finally {
        process.off('unhandledRejection', onRejection)
        if (!reaped) await reapHelper(`G1-${mode}`, file('hold-helper.pid'), file('release'), helper)
      }
    })
  }
})

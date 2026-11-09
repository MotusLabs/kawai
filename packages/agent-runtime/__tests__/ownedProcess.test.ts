// @reads: packages/agent-runtime/__tests__/fixtures/**
// Owned spawner oracles on real child processes (task 2.1): the exact
// environment and cwd (P02-P04/I3, control M-env), launch validation (P01),
// actual-exit stop receipts (L11-L16/I1, control M-join), the never-started
// fact, memoized terminate, the optional recorder, native evidence (A3:
// ownership before publication, evidence frozen before settlement, recorder
// throws kept), and the Claude SDK adapter.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntimeError } from '../src/errors.js'
import type { WireFrame } from '../src/options.js'
import { createOwnedClaudeSpawn } from '../src/process/claudeSpawn.js'
import { resolveExecutable, resolveLaunch, type ResolvedLaunch } from '../src/process/launch.js'
import { spawnOwned, type OwnedProcess } from '../src/process/ownedProcess.js'

const FIXTURES = join(import.meta.dir, 'fixtures')
const BUN = process.execPath
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-owned-')))
const spawned: OwnedProcess[] = []

afterAll(async () => {
  await Promise.allSettled(spawned.map((p) => p.terminate({ graceMs: 100, killMs: 2000 })))
})

function launch(childEnv: Record<string, string> = { AR_ONLY: '1' }): ResolvedLaunch {
  return resolveLaunch({ cwd: root, childEnv, homeDir: join(root, 'home'), cacheDir: join(root, 'cache'), tempDir: join(root, 'tmp') })
}

function run(fixture: string, args: string[] = [], env?: Record<string, string>, recorder?: { record(f: WireFrame): void }): OwnedProcess {
  const owned = spawnOwned({ command: BUN, args: [join(FIXTURES, fixture), ...args], launch: launch(env), generation: 1, ...(recorder ? { recorder } : {}) })
  spawned.push(owned)
  return owned
}

/** The first stdout line; the stream keeps flowing afterwards (nothing is destroyed). */
function firstLine(owned: OwnedProcess): Promise<string> {
  return new Promise((resolve) => {
    let buffer = ''
    owned.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline !== -1) resolve(buffer.slice(0, newline))
    })
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // A zombie has exited; it counts as dead.
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

const settled = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true, () => true), Bun.sleep(ms).then(() => false)])

describe('environment and cwd (P02-P04, I3)', () => {
  test('the child receives exactly the launch map and cwd, with poisoned host variables absent', async () => {
    process.env.AR_POISON_TOKEN = 'host-secret'
    try {
      const env = { AR_ONLY: '1', ANTHROPIC_BASE_URL: 'http://proxy.invalid' }
      const owned = run('printEnv.ts', [], env)
      const report = JSON.parse(await firstLine(owned)) as { env: Record<string, string>; cwd: string }
      expect(report.env).toEqual(env)
      expect(report.cwd).toBe(root)
      expect(process.env.AR_POISON_TOKEN).toBe('host-secret')
      expect((await owned.leaderExit).kind).toBe('exited')
    } finally {
      delete process.env.AR_POISON_TOKEN
    }
  })

  test('the frozen launch map is not mutated by spawning', () => {
    const resolved = launch({ A: '1' })
    expect(Object.isFrozen(resolved.childEnv)).toBe(true)
    run('printEnv.ts', [], { A: '1' })
    expect(resolved.childEnv).toEqual({ A: '1' })
  })
})

describe('launch validation (P01)', () => {
  const base = { cwd: '/w', childEnv: {}, homeDir: '/h', cacheDir: '/c', tempDir: '/t' }
  const cases: Array<[string, unknown]> = [
    ['missing childEnv', { ...base, childEnv: undefined }],
    ['array childEnv', { ...base, childEnv: [] }],
    ['non-string env value', { ...base, childEnv: { A: 1 } }],
    ['relative cwd', { ...base, cwd: 'w' }],
    ['missing homeDir', { ...base, homeDir: '' }],
    ['relative executablePath', { ...base, executablePath: 'claude' }],
    ['throwing callback', () => { throw new Error('catalog unavailable') }],
  ]
  for (const [name, input] of cases) {
    test(`${name} is a configuration error`, () => {
      try {
        resolveLaunch(input as never)
        throw new Error('accepted')
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRuntimeError)
        expect((error as AgentRuntimeError).category).toBe('configuration')
      }
    })
  }

  test('executables resolve through the launch PATH only, never the host PATH', () => {
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'fake-agent'), '#!/bin/sh\n')
    chmodSync(join(bin, 'fake-agent'), 0o755)
    expect(resolveExecutable(launch({ PATH: bin }), 'fake-agent')).toBe(join(bin, 'fake-agent'))
    try {
      resolveExecutable(launch({ PATH: '' }), 'sh')
      throw new Error('resolved through the host PATH')
    } catch (error) {
      expect((error as AgentRuntimeError).category).toBe('dependency')
    }
  })
})

describe('stop receipts (L11-L16, I1)', () => {
  test('a cooperative child yields an exited fact with its own code and no escalation', async () => {
    const owned = run('exitOnTerm.ts')
    expect(await firstLine(owned)).toBe('ready')
    const fact = await owned.terminate({ graceMs: 2000, killMs: 2000 })
    expect(fact).toEqual({ generation: 1, state: 'exited', pid: owned.pid!, code: 7, signal: null, escalated: false, groupCleared: true })
    expect(alive(owned.pid!)).toBe(false)
  })

  // Control M-join: a receipt on signal acknowledgement would settle while the child lives.
  test('terminate stays pending while a SIGTERM-ignoring child is alive, then escalates', async () => {
    const owned = run('holdAlive.ts')
    expect(await firstLine(owned)).toBe('ready')
    const stop = owned.terminate({ graceMs: 400, killMs: 2000 })
    expect(await settled(stop, 250)).toBe(false)
    expect(alive(owned.pid!)).toBe(true)
    const fact = await stop
    expect(fact).toMatchObject({ state: 'exited', signal: 'SIGKILL', escalated: true, groupCleared: true })
    expect(alive(owned.pid!)).toBe(false)
  })

  test('terminate is memoized: concurrent callers share one outcome', async () => {
    const owned = run('exitOnTerm.ts')
    expect(await firstLine(owned)).toBe('ready')
    const first = owned.terminate()
    expect(owned.terminate({ graceMs: 1 })).toBe(first)
    expect((await first).state).toBe('exited')
  })

  test('an already-exited leader is reported without signalling', async () => {
    const owned = run('printEnv.ts')
    await owned.leaderExit
    expect(await owned.terminate()).toMatchObject({ state: 'exited', code: 0, signal: null, escalated: false })
  })

  test('a spawn that never created a process reports never-started', async () => {
    const owned = spawnOwned({ command: join(root, 'missing-agent'), args: [], launch: launch(), generation: 3 })
    expect(owned.pid).toBeNull()
    expect((await owned.leaderExit).kind).toBe('spawn-failed')
    expect(await owned.terminate()).toEqual({ generation: 3, state: 'never-started' })
  })
})

describe('optional recorder', () => {
  test('records lifecycle and lines in both directions, never the environment', async () => {
    const frames: WireFrame[] = []
    const owned = run('exitOnTerm.ts', [], { AR_SECRET: 'sk-never-recorded' }, { record: (f) => frames.push(f) })
    expect(await firstLine(owned)).toBe('ready')
    owned.stdin.write('hello\n')
    await Bun.sleep(100)
    await owned.terminate()
    const lines = frames.map((f) => `${f.direction}:${f.text}`)
    expect(lines[0]).toStartWith('lifecycle:{"event":"spawn"')
    expect(lines).toContain('out:hello')
    expect(lines).toContain('in:echo:hello')
    expect(lines.at(-1)).toBe('lifecycle:{"event":"exit","code":7,"signal":null}')
    expect(frames.every((f) => f.generation === 1 && !f.text.includes('sk-never-recorded'))).toBe(true)
  })
})

describe('native evidence (A3, R4 B1/B6)', () => {
  const HANG = ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"]

  test('ownership precedes publication, and the evidence is frozen before the exit is recorded or settled', async () => {
    const order: string[] = []
    let owned!: OwnedProcess
    let atExit: { evidence: OwnedProcess['evidence']; exited: OwnedProcess['exited'] } | null = null
    const recorder = {
      record(f: WireFrame) {
        if (f.direction !== 'lifecycle') return
        const event = (JSON.parse(f.text) as { event: string }).event
        order.push(`record:${event}:${owned === undefined ? 'unowned' : 'owned'}`)
        if (event === 'exit') atExit = { evidence: owned.evidence, exited: owned.exited }
      },
    }
    spawnOwned({ command: BUN, args: HANG, launch: launch(), generation: 1, recorder, onCreated: (o) => {
      owned = o
      order.push('created')
      spawned.push(o)
    } })
    expect(order).toEqual(['created', 'record:spawn:owned'])
    expect(await firstLine(owned)).toBe('ready')
    owned.markTermination()
    const fact = await owned.terminate({ graceMs: 2000, killMs: 2000 })
    expect(fact).toMatchObject({ state: 'exited', code: null, signal: 'SIGTERM', escalated: false, groupCleared: true })
    const frozen = owned.evidence!
    expect(frozen).toEqual({ exit: { kind: 'exited', code: null, signal: 'SIGTERM' }, marked: true, sentAfterMark: ['SIGTERM'], errors: [] })
    expect([Object.isFrozen(frozen), Object.isFrozen(frozen.sentAfterMark), Object.isFrozen(frozen.errors)]).toEqual([true, true, true])
    // The exit record saw the evidence and the settled exit already in place.
    expect(atExit!.evidence).toBe(frozen)
    expect(atExit!.exited).toEqual(frozen.exit)
    // Later cleanup cannot rewrite it.
    owned.signal('SIGKILL')
    owned.markTermination()
    expect(owned.evidence).toBe(frozen)
    expect(frozen.sentAfterMark).toEqual(['SIGTERM'])
    expect(owned.observerFailures).toEqual([])
  })

  test('an exit before any mark is frozen unmarked, with no sends', async () => {
    const owned = run('printEnv.ts')
    await owned.leaderExit
    expect(owned.evidence).toEqual({ exit: { kind: 'exited', code: 0, signal: null }, marked: false, sentAfterMark: [], errors: [] })
    owned.markTermination()
    expect((await owned.terminate()).state).toBe('exited')
    expect(owned.evidence!.marked).toBe(false)
  })

  test('a throwing recorder never skips settlement or group cleanup; every throw is kept by identity', async () => {
    const thrown = new Error('recorder threw')
    const owned = run('exitOnTerm.ts', [], undefined, {
      record() {
        throw thrown
      },
    })
    expect(await firstLine(owned)).toBe('ready')
    owned.markTermination()
    const fact = await owned.terminate({ graceMs: 2000, killMs: 2000 })
    expect(fact).toMatchObject({ state: 'exited', code: 7, signal: null, groupCleared: true })
    expect(owned.evidence).toEqual({ exit: { kind: 'exited', code: 7, signal: null }, marked: true, sentAfterMark: ['SIGTERM'], errors: [] })
    expect(alive(owned.pid!)).toBe(false)
    // At least the spawn and exit records threw; each is the recorder's own error.
    expect(owned.observerFailures.length).toBeGreaterThanOrEqual(2)
    expect(owned.observerFailures.every((e) => e === thrown)).toBe(true)
  })
})

describe('Claude SDK spawner adapter', () => {
  test('ignores the SDK-proposed env and cwd, reports exit, and terminates on abort', async () => {
    const owneds: OwnedProcess[] = []
    const spawnFn = createOwnedClaudeSpawn({ launch: launch({ AR_ONLY: '1' }), generation: 2, onSpawn: (o) => owneds.push(o) })
    const abort = new AbortController()
    const child = spawnFn({
      command: BUN,
      args: [join(FIXTURES, 'printEnv.ts')],
      cwd: '/',
      env: { AR_ONLY: '1', AR_SDK_AMBIENT: 'leak', PATH: '/usr/bin' },
      signal: abort.signal,
    })
    spawned.push(...owneds)
    const exit = new Promise<[number | null, string | null]>((resolve) => child.once('exit', (code, signal) => resolve([code, signal])))
    let text = ''
    for await (const chunk of child.stdout) text += chunk.toString()
    expect(JSON.parse(text)).toEqual({ env: { AR_ONLY: '1' }, cwd: root })
    expect(await exit).toEqual([0, null])
    expect(child.exitCode).toBe(0)

    const held = createOwnedClaudeSpawn({ launch: launch(), generation: 3, onSpawn: (o) => owneds.push(o) })
    const abort2 = new AbortController()
    const second = held({ command: BUN, args: [join(FIXTURES, 'exitOnTerm.ts')], env: {}, signal: abort2.signal })
    spawned.push(owneds[1]!)
    const secondExit = new Promise<number | null>((resolve) => second.once('exit', (code) => resolve(code)))
    await firstLine(owneds[1]!)
    abort2.abort()
    expect(await secondExit).toBe(7)
    expect((await owneds[1]!.terminate()).state).toBe('exited')
    abort.abort()
  })
})

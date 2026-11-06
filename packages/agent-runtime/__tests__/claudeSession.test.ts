// @reads: packages/agent-runtime/__tests__/fixtures/**
// The first real Claude composition (tasks 2.2/2.4): the pinned SDK's query()
// on the owned spawner through the lifecycle core, against a process-level
// fake CLI speaking stream-json (no credentials, no model calls). Covers
// L01/L04/L06/L08/L10-L14/L17/L21 and P03 on the real path; the M-join
// (EOF as exit) and M-env (ambient merge) controls must fail here.
import { afterAll, describe, expect, test } from 'bun:test'
import { ClaudeSession } from '../src/claude/session.js'
import type { AgentEvent } from '../src/events.js'
import type { ProcessEndReport, ProcessExitReceipt, TurnResult } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { WireFrame } from '../src/options.js'
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

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected a rejection')
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await tick(10)
  }
}

interface Harness {
  s: ClaudeSession
  home: ReturnType<typeof fakeClaudeHome>
  events: AgentEvent[]
  results: TurnResult[]
  ends: ProcessEndReport[]
  frames: WireFrame[]
  spawned(): number[]
}

/** Settles within `ms`, else rejects: a hanging stop must fail the test, not stall the suite. */
function within<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
}

function harness(options: { env?: Record<string, string>; executablePath?: string; onTurnResult?(s: ClaudeSession, r: TurnResult): void } = {}): Harness {
  const home = fakeClaudeHome()
  const events: AgentEvent[] = []
  const results: TurnResult[] = []
  const ends: ProcessEndReport[] = []
  const frames: WireFrame[] = []
  const launch = { ...home.launch(options.env), ...(options.executablePath ? { executablePath: options.executablePath } : {}) }
  const s: ClaudeSession = new ClaudeSession({
    launch,
    callbacks: {
      onEvent: (e) => events.push(e),
      onTurnResult: (r) => {
        results.push(r)
        options.onTurnResult?.(s, r)
      },
      onProcessEnd: (r) => ends.push(r),
    },
    wire: { record: (f) => frames.push(f) },
    terminate: { graceMs: 300, killMs: 3000 },
  })
  sessions.push(s)
  /** Generations the spawner launched, from its lifecycle frames. */
  const spawned = () =>
    frames.filter((f) => f.direction === 'lifecycle').flatMap((f) => {
      const event = JSON.parse(f.text) as { event: string }
      return event.event === 'spawn' ? [f.generation] : []
    })
  return { s, home, events, results, ends, frames, spawned }
}

const exited = (receipt: ProcessExitReceipt) => receipt.processes.map((p) => (p.state === 'exited' ? p.pid : null))

describe('claude session on the owned spawner', () => {
  // @covers: agent-runtime › Session start and turn results are distinct › Successful turn
  test('L01/L17: start readies the session without a prompt, then a turn succeeds', async () => {
    const h = harness()
    const start = h.s.start()
    expect(h.s.state).toBe('starting')
    await start
    expect(h.s.state).toBe('idle')
    expect(h.home.received().map((f) => f.type)).toEqual(['control_request'])
    const handle = await h.s.send('hello', { messageUuid: '00000000-0000-4000-8000-000000000001' })
    const result = await handle.result
    expect(result).toMatchObject({ turnId: handle.turnId, messageUuid: handle.messageUuid, outcome: 'success', finalText: 'echo: hello', model: 'fake-model', error: null })
    expect(h.results).toEqual([result])
    expect(h.events.map((e) => e.type)).toEqual(['turn_started', 'user_message', 'turn_completed'])
    expect(h.events.map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(h.s.state).toBe('idle')
  })

  test('L04: concurrent start calls share one generation', async () => {
    const h = harness()
    const a = h.s.start()
    const b = h.s.start()
    expect(b).toBe(a)
    await Promise.all([a, b])
    await h.s.start()
    expect(h.s.lifecycle.generation).toBe(1)
    expect(h.spawned()).toEqual([1])
  })

  test('L06: a send while starting waits for readiness, then runs', async () => {
    const h = harness()
    void h.s.start()
    const handle = await h.s.send('early')
    expect((await handle.result).finalText).toBe('echo: early')
  })

  test('L01: a missing executable rejects start with dependency and restores unstarted', async () => {
    const h = harness({ env: { PATH: '/nonexistent-agent-runtime-bin' } })
    expect((await rejection(h.s.start())).category).toBe('dependency')
    expect(h.s.state).toBe('unstarted')
    expect(h.spawned()).toEqual([])
  })

  test('P03/M-env: the CLI sees exactly the launch environment, never the host or SDK additions', async () => {
    const marker = 'AR_POISONED_HOST_MARKER'
    process.env[marker] = 'leaked'
    try {
      const h = harness({ env: { AR_EXPLICIT: 'given' } })
      await h.s.start()
      const handle = await h.s.send(`env ${marker} AR_EXPLICIT CLAUDE_CODE_ENTRYPOINT NODE_OPTIONS`)
      const result = await handle.result
      expect(JSON.parse(result.finalText!)).toEqual({ [marker]: null, AR_EXPLICIT: 'given', CLAUDE_CODE_ENTRYPOINT: null, NODE_OPTIONS: null })
      // The recorder never carries the environment.
      expect(h.frames.some((f) => f.direction === 'lifecycle' && f.text.includes('AR_EXPLICIT'))).toBe(false)
    } finally {
      delete process.env[marker]
    }
  })

  test('L08: a new turn while one is active is refused busy', async () => {
    const h = harness()
    await h.s.start()
    await h.s.send('hang')
    expect(h.s.state).toBe('active')
    expect((await rejection(h.s.send('second'))).category).toBe('busy')
  })

  test('L21: a queued message runs as the next turn without an idle state in between', async () => {
    const h = harness()
    await h.s.start()
    const first = await h.s.send('one')
    const second = await h.s.send('two', { continuation: 'queue' })
    const [a, b] = await Promise.all([first.result, second.result])
    expect([a.finalText, b.finalText]).toEqual(['echo: one', 'echo: two'])
    expect(h.results.map((r) => r.turnId)).toEqual([first.turnId, second.turnId])
    expect(h.events.filter((e) => e.type === 'turn_started').map((e) => (e as { turnId: string }).turnId)).toEqual([first.turnId, second.turnId])
    expect(h.s.state).toBe('idle')
  })

  // @covers: agent-runtime › Cooperative interrupt is distinct from forced stop › Interrupt then continue
  test('L10: interrupt settles the active turn at once, claims no exit, and the conversation continues', async () => {
    const h = harness()
    await h.s.start()
    const hung = await h.s.send('hang')
    const receipt = await h.s.interrupt()
    expect(receipt).toEqual({ outcome: 'requested', processExit: false })
    expect(h.s.state).toBe('idle')
    const result = await hung.result
    expect(result.outcome).toBe('interrupted')
    await until(() => h.home.received().some((f) => (f.request as { subtype?: string } | undefined)?.subtype === 'interrupt'))
    await tick(50)
    const next = await h.s.send('after')
    expect((await next.result).finalText).toBe('echo: after')
    const types = h.events.filter((e) => 'turnId' in e && e.turnId === hung.turnId).map((e) => e.type)
    expect(types).toEqual(['turn_started', 'user_message', 'turn_interrupted'])
    expect(h.results.filter((r) => r.turnId === hung.turnId)).toHaveLength(1)
    expect(h.ends).toEqual([])
  })

  test('L11: kill during a turn settles it as stopped and resolves only after the actual exit', async () => {
    const h = harness()
    await h.s.start()
    const hung = await h.s.send('hang')
    const receipt = await h.s.kill()
    expect((await hung.result)).toMatchObject({ outcome: 'interrupted', error: { category: 'stopped' } })
    expect(receipt).toMatchObject({ scope: 'agent-processes', mode: 'kill', js: 'settled' })
    expect(receipt.processes).toHaveLength(1)
    expect(receipt.processes[0]).toMatchObject({ generation: 1, state: 'exited', groupCleared: true })
    for (const pid of exited(receipt)) expect(alive(pid!)).toBe(false)
    expect(h.s.state).toBe('stopped')
    expect(h.ends).toEqual([])
    expect(h.s.lifecycle.jobs.size).toBe(0)
  })

  // @covers: agent-runtime › Forced stop has an actual exit boundary › Delayed process exit
  test('L11: a CLI that ignores SIGTERM keeps kill pending until escalation proves the exit', async () => {
    const h = harness()
    await h.s.start()
    await (await h.s.send('ignore-term')).result
    const kill = h.s.kill()
    let settled = false
    void kill.then(() => (settled = true), () => (settled = true))
    await tick(150)
    expect(settled).toBe(false)
    expect(h.s.state).toBe('stopping')
    const receipt = await kill
    expect(receipt.processes[0]).toMatchObject({ state: 'exited', signal: 'SIGKILL', escalated: true, groupCleared: true })
    for (const pid of exited(receipt)) expect(alive(pid!)).toBe(false)
  })

  test('shutdown: closing the input lets the CLI exit on its own within the grace bound', async () => {
    const h = harness()
    await h.s.start()
    const receipt = await h.s.shutdown()
    expect(receipt.mode).toBe('shutdown')
    expect(receipt.processes[0]).toMatchObject({ state: 'exited', code: 0, signal: null, escalated: false })
  })

  // @covers: agent-runtime › Forced stop has an actual exit boundary › Repeated stop and retired generation
  test('L12/L13: concurrent stops share one receipt across a retired generation; later calls are refused', async () => {
    const h = harness()
    await h.s.start()
    await (await h.s.send('crash')).result
    expect(h.s.state).toBe('exited')
    await h.s.start()
    expect(h.s.lifecycle.generation).toBe(2)
    const [a, b] = await Promise.all([h.s.kill(), h.s.shutdown()])
    expect(b).toBe(a)
    expect(a.mode).toBe('kill')
    expect(a.processes.map((p) => p.generation)).toEqual([1, 2])
    expect(a.processes.every((p) => p.state === 'exited')).toBe(true)
    expect(await h.s.kill()).toBe(a)
    expect((await rejection(h.s.send('late'))).category).toBe('stopped')
    expect((await rejection(h.s.start())).category).toBe('stopped')
  })

  // @covers: agent-runtime › Unexpected process end is reported › Crash during a turn
  test('L14: a crash mid-turn reports one process end and one process-ended result; start respawns', async () => {
    const h = harness()
    await h.s.start()
    const crashed = await h.s.send('crash')
    const result = await crashed.result
    expect(result).toMatchObject({ outcome: 'process-ended', error: { category: 'transport' } })
    await until(() => h.ends.length > 0)
    expect(h.ends).toEqual([{ generation: 1, code: 3, signal: null, reason: null }])
    expect(h.events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(h.events.filter((e) => e.type === 'turn_completed').map((e) => (e as { subtype: string }).subtype)).toEqual(['process_ended'])
    expect(h.s.state).toBe('exited')
    await h.s.start()
    expect((await (await h.s.send('again')).result).finalText).toBe('echo: again')
    await tick(50)
    expect(h.ends).toHaveLength(1)
  })

  test('M-join: a CLI that closes its stream but keeps running is not reported as exited', async () => {
    const h = harness()
    await h.s.start()
    const handle = await h.s.send('eof-alive')
    // The SDK reads EOF; the process lives on.
    await tick(600)
    expect(h.s.state).toBe('active')
    expect(h.ends).toEqual([])
    const receipt = await h.s.kill()
    expect((await handle.result).outcome).toBe('interrupted')
    expect(receipt.processes[0]).toMatchObject({ state: 'exited', groupCleared: true })
    expect(h.ends).toEqual([])
  })

  test('L11/I1: stop from inside a callback is refused for that caller while the stop completes', async () => {
    let inner: Promise<ProcessExitReceipt> | null = null
    const h = harness({
      onTurnResult: (s) => {
        inner ??= s.kill()
        inner.catch(() => {})
      },
    })
    await h.s.start()
    await (await h.s.send('hello')).result
    expect((await rejection(inner!)).category).toBe('internal')
    const receipt = await h.s.kill()
    expect(receipt.processes[0]).toMatchObject({ state: 'exited' })
    expect(h.s.state).toBe('stopped')
  })

  test('L11/L13: kill while initialization is still loading the SDK spawns nothing and completes', async () => {
    const h = harness()
    const start = h.s.start()
    start.catch(() => {})
    const receipt = await within(h.s.kill())
    expect((await rejection(start)).category).toBe('stopped')
    expect(receipt.processes).toEqual([])
    expect(h.spawned()).toEqual([])
    expect(h.s.state).toBe('stopped')
  })

  test('L11/I1: a throwing turn-result callback during kill still terminates, settles the turn and reports the failure', async () => {
    const thrown = new Error('callback failed')
    const h = harness({
      onTurnResult: () => {
        throw thrown
      },
    })
    await h.s.start()
    const hung = await h.s.send('hang')
    const error = await rejection(within(h.s.kill()))
    expect(error.category).toBe('stop')
    expect(error.causes).toContain(thrown)
    expect((await within(hung.result)).outcome).toBe('interrupted')
    const pid = (h.s as unknown as { generations: Array<{ owned: { pid: number } }> }).generations[0]!.owned.pid
    expect(alive(pid)).toBe(false)
    expect(h.s.lifecycle.jobs.size).toBe(0)
  })
})

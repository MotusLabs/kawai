// The Codex driver's lifecycle rows (design "Lifecycle decision table",
// L01-L26) through the public factory, the default transport and the owned
// fake app-server: start categories and readiness, repeated start, sends
// while unstarted/starting, interrupt, repeated and terminal stop, the
// unexpected exit (with a restart that resumes the same thread), late and
// foreign results, steering and agent-started turns.
import { afterEach, describe, expect, test } from 'bun:test'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import type { AgentRuntimeError } from '../src/errors.js'
import { codexDriver, codexRoot, deferred, refusal, sent, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

describe('Codex lifecycle: start (L01-L04, L17)', () => {
  const cases: Array<[string, () => ReturnType<typeof codexDriver>, string]> = [
    ['configuration (relative cwd)', () => codexDriver({ launch: { ...codexRoot().launch(), cwd: 'relative' } }), 'configuration'],
    ['dependency (missing executable)', () => codexDriver({ launch: { ...codexRoot().launch(), executablePath: '/nonexistent/codex' } }), 'dependency'],
    ['authentication (initialize unauthorized)', () => codexDriver({ env: { FAKE_CODEX_INIT: 'unauthorized' } }), 'authentication'],
    ['authentication (thread/start HTTP 401)', () => codexDriver({ env: { FAKE_CODEX_START: 'unauthorized' } }), 'authentication'],
    ['resume (thread refused)', () => codexDriver({ env: { FAKE_CODEX_RESUME: 'refuse' }, resume: { runtime: 'codex', runtimeSessionId: 'thr-saved' } }), 'resume'],
    ['transport (process exits during initialize)', () => codexDriver({ env: { FAKE_CODEX_INIT: 'exit' } }), 'transport'],
  ]
  for (const [name, make, category] of cases) {
    test(`L01: a failed start is ${name} and restores unstarted (an exit while starting is L14)`, async () => {
      const h = make()
      const error = await refusal(h.driver.start())
      expect(error.category).toBe(category as AgentRuntimeError['category'])
      // L14: a process that exits while starting leaves the driver exited, with one process end.
      expect(h.driver.state).toBe(name.startsWith('transport') ? 'exited' : 'unstarted')
      expect(h.ends).toHaveLength(name.startsWith('transport') ? 1 : 0)
      expect(sent(h.root, 'thread/start')).toHaveLength(category === 'authentication' && name.includes('thread/start') ? 1 : 0)
      expect(sent(h.root, 'turn/start')).toEqual([])
    })
  }

  // @covers: agent-runtime › Shutdown preserves resumability › Missing or invalid resume identity
  test('L01/R10: a resume answered with another thread fails resume and never adopts or falls back to a fresh thread', async () => {
    const h = codexDriver({ env: { FAKE_CODEX_RESUME: 'substitute' }, resume: { runtime: 'codex', runtimeSessionId: 'thr-saved' } })
    expect((await refusal(h.driver.start())).category).toBe('resume')
    expect((await refusal(h.driver.start())).category).toBe('resume')
    expect(sent(h.root, 'thread/resume').map((m) => m.params.threadId)).toEqual(['thr-saved', 'thr-saved'])
    expect(sent(h.root, 'thread/start')).toEqual([])
    expect(h.checkpoints).toEqual([])
    expect((await refusal(h.driver.send('x'))).category).toBe('not-ready')
  })

  test('L03/L04: concurrent starts share one initialization; a start while idle is a no-op', async () => {
    const h = codexDriver()
    const [a, b] = [h.driver.start(), h.driver.start()]
    await Promise.all([a, b])
    await h.driver.start()
    expect(sent(h.root, 'initialize')).toHaveLength(1)
    expect(h.states).toEqual(['starting', 'idle'])
  })

  test('L17/R10: readiness waits for the checkpoint persistence; a send meanwhile is acknowledged only after it', async () => {
    const persisted = deferred()
    const h = codexDriver({ callbacks: { onCheckpoint: () => persisted.promise } })
    let ready = false
    const start = h.driver.start().then(() => (ready = true))
    await waitFor(() => h.checkpoints.length === 1)
    const sending = h.driver.send('after')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ready).toBe(false)
    expect(h.driver.state).toBe('starting')
    expect(sent(h.root, 'turn/start')).toEqual([])
    persisted.resolve()
    await start
    expect((await (await sending).result).finalText).toBe('codex:retfa|seen=')
  })

  test('R10: a rejected persistence fails start with category checkpoint, refuses sends and stops the driver', async () => {
    const h = codexDriver({ callbacks: { onCheckpoint: () => Promise.reject(new Error('store down')) } })
    expect((await refusal(h.driver.start())).category).toBe('checkpoint')
    expect(h.events.some((e) => e.type === 'error' && e.error.category === 'checkpoint')).toBe(true)
    await waitFor(() => h.driver.state === 'stopped' || h.driver.state === 'stopping')
    expect(['stopping', 'stopped']).toContain(h.driver.state)
  })

  test('L17: start() inside onCheckpoint is refused internal instead of waiting on itself', async () => {
    let inner: Promise<unknown> | null = null
    const h = codexDriver({ callbacks: { onCheckpoint: () => void (inner = h.driver.start()) } })
    await h.driver.start()
    expect((await refusal(inner!)).category).toBe('internal')
  })

  test('L26: an app-server turn while starting opens nothing', async () => {
    const persisted = deferred()
    const h = codexDriver({ env: { FAKE_CODEX_START: 'agent' }, callbacks: { onCheckpoint: () => persisted.promise } })
    const start = h.driver.start()
    await waitFor(() => h.root.received().some((m) => m.method === 'thread/start'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    persisted.resolve()
    await start
    expect(h.types().filter((t) => t.startsWith('turn_'))).toEqual([])
    expect(h.results).toEqual([])
  })
})

describe('Codex lifecycle: sends and interrupt (L05-L10)', () => {
  test('L05: a send before start is refused not-ready with nothing sent', async () => {
    const h = codexDriver()
    expect((await refusal(h.driver.send('x'))).category).toBe('not-ready')
    expect(h.events).toEqual([])
  })

  test('L06: a send while starting waits and is admitted once idle', async () => {
    const h = codexDriver()
    const start = h.driver.start()
    const handle = await h.driver.send('wait')
    await start
    expect((await handle.result).outcome).toBe('success')
  })

  test('L09: interrupt while idle is no-active-turn and claims no exit', async () => {
    const h = codexDriver()
    await h.driver.start()
    expect(await h.driver.interrupt()).toEqual({ outcome: 'no-active-turn', processExit: false })
  })

  // @covers: agent-runtime › Cooperative interrupt is distinct from forced stop › Interrupt then continue
  test('L10: interrupt settles the active turn once as interrupted, asks Codex to stop that native turn, and the next turn works', async () => {
    const h = codexDriver()
    await h.driver.start()
    const held = await h.driver.send('/hold')
    await waitFor(() => h.root.received().some((m) => m.method === 'turn/start'))
    expect(await h.driver.interrupt()).toEqual({ outcome: 'requested', processExit: false })
    expect(await held.result).toMatchObject({ outcome: 'interrupted', error: { category: 'stopped' } })
    expect(h.driver.state).toBe('idle')
    await waitFor(() => sent(h.root, 'turn/interrupt').length === 1)
    expect(sent(h.root, 'turn/interrupt')[0]!.params.turnId).toBe('turn-1')
    const next = await (await h.driver.send('next')).result
    expect(next.finalText).toBe('codex:txen|seen=')
    expect(h.types().filter((t) => t === 'turn_interrupted')).toHaveLength(1)
    expect(h.results.map((r) => r.outcome)).toEqual(['interrupted', 'success'])
  })
})

describe('Codex lifecycle: stop and exit (L11-L16)', () => {
  test('L12/L13: kill and shutdown share one terminal outcome; everything after is refused stopped', async () => {
    const h = codexDriver()
    await h.driver.start()
    const a = h.driver.kill()
    const b = h.driver.shutdown()
    expect(await a).toEqual(await b)
    for (const call of [h.driver.start(), h.driver.send('x'), h.driver.interrupt()]) expect((await refusal(call)).category).toBe('stopped')
  })

  // @covers: agent-runtime › Unexpected process end is reported › Crash during a turn
  test('L14/L02: a crash during a turn ends it process-ended with one error and one onProcessEnd; start again resumes the same thread', async () => {
    const h = codexDriver()
    await h.driver.start()
    await (await h.driver.send('first')).result
    const crashed = await h.driver.send('/exit 3')
    const result = await crashed.result
    expect(result).toMatchObject({ outcome: 'process-ended', error: { category: 'transport' } })
    await waitFor(() => h.ends.length === 1)
    expect(h.ends).toEqual([{ generation: 1, code: 3, signal: null, reason: null }])
    expect(h.driver.state).toBe('exited')
    expect(h.events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(h.events.filter((e) => e.type === 'turn_completed' && e.subtype === 'process_ended')).toHaveLength(1)
    await h.driver.start()
    const threadId = h.checkpoints[0]!.runtimeSessionId
    expect(sent(h.root, 'thread/resume').map((m) => m.params.threadId)).toEqual([threadId])
    const again = await (await h.driver.send('again')).result
    expect(again).toMatchObject({ outcome: 'success', finalText: 'codex:niaga|seen=first' })
    // The generation that died before the stop fails it with its native evidence (L15/I1).
    const stop = await refusal(h.driver.kill())
    const natives = stop.causes.filter((c): c is NativeExitFailure => c instanceof NativeExitFailure)
    expect(natives.map((n) => n.facts)).toEqual([expect.objectContaining({ generation: 1, code: 3, observedBeforeStop: true })])
    expect(h.ends).toHaveLength(1)
  })
})

describe('Codex lifecycle: results and native turns (L19-L26, R03)', () => {
  test('L19/L20/R03: a duplicate and a foreign turn/completed complete nothing', async () => {
    const h = codexDriver()
    await h.driver.start()
    const result = await (await h.driver.send('/late')).result
    expect(result.finalText).toBe('codex:etal|seen=')
    const next = await (await h.driver.send('two')).result
    expect(next.finalText).toBe('codex:owt|seen=late')
    expect(h.results).toHaveLength(2)
    expect(h.events.filter((e) => e.type === 'turn_completed')).toHaveLength(2)
  })

  test('L19: a turn completed before the turn/start reply binds by turn/started and resolves once', async () => {
    const h = codexDriver()
    await h.driver.start()
    const result = await (await h.driver.send('/early')).result
    expect(result).toMatchObject({ outcome: 'success', finalText: 'codex:ylrae|seen=' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.results).toHaveLength(1)
  })

  test('L22: a steered message joins the active turn; its handle shares the result whose messageUuid is the opening message', async () => {
    const h = codexDriver()
    await h.driver.start()
    const opening = await h.driver.send('/hold')
    await waitFor(() => sent(h.root, 'turn/start').length === 1)
    const steered = await h.driver.send('more', { continuation: 'steer' })
    expect(steered.turnId).toBe(opening.turnId)
    expect(steered.messageUuid).not.toBe(opening.messageUuid)
    const [a, b] = await Promise.all([opening.result, steered.result])
    expect(a).toBe(b)
    expect(a).toMatchObject({ outcome: 'success', messageUuid: opening.messageUuid, finalText: 'steered:more' })
    expect(sent(h.root, 'turn/steer')[0]!.params).toMatchObject({ expectedTurnId: 'turn-1', clientUserMessageId: steered.messageUuid })
    expect(h.results).toHaveLength(1)
    expect(h.events.filter((e) => e.type === 'user_message').map((e) => (e as { messageUuid: string }).messageUuid)).toEqual([opening.messageUuid, steered.messageUuid])
  })

  test('L22/L07: steer while idle opens a new turn', async () => {
    const h = codexDriver()
    await h.driver.start()
    const handle = await h.driver.send('idle', { continuation: 'steer' })
    expect((await handle.result).finalText).toBe('codex:eldi|seen=')
    expect(sent(h.root, 'turn/steer')).toEqual([])
  })

  // @covers: agent-runtime › Agent-started turns are reported › Background completion wakes an idle driver
  test('L24: an app-server turn while idle is agent-started: its own identity, no user message or handle, one result', async () => {
    const h = codexDriver()
    await h.driver.start()
    await (await h.driver.send('/agent')).result
    await waitFor(() => h.results.length === 2)
    const agent = h.results[1]!
    expect(agent).toMatchObject({ messageUuid: null, outcome: 'success', finalText: 'agent-started reply' })
    const started = h.events.filter((e) => e.type === 'turn_started')
    expect(started).toHaveLength(2)
    expect(started[1]).toMatchObject({ turnId: agent.turnId, trigger: { kind: 'resumed' } })
    expect(h.events.filter((e) => e.type === 'user_message')).toHaveLength(1)
    expect(h.driver.state).toBe('idle')
  })

  // @covers: agent-runtime › Agent-started turns are reported › No phantom or late agent-started turn
  test('L25: another app-server turn while active binds to the current turn: no second turn_started or result', async () => {
    const h = codexDriver()
    await h.driver.start()
    const result = await (await h.driver.send('/foreign')).result
    expect(result.finalText).toBe('codex:ngierof|seen=')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    expect(h.results).toHaveLength(1)
  })
})

// @reads: packages/agent-runtime/__tests__/fixtures/**
// The Claude driver's turn binding beyond the 56 pairs (task 4.1): queued
// continuations (L21, L23), agent-started turns (L24 with M-native), results
// that name a previous, duplicate or unknown prompt (R03, the M-bind
// target), a repeated result frame (A1), and a headless driver with no host
// additions (P09). I6 over seeded streams is in claudeTurnStreams.test.ts.
// Everything runs on the production ClaudeSession; only the SDK's query() is
// controlled.
import { describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import { driver, type Driver } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function idle(): Promise<Driver> {
  const f = driver()
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

const started = (f: Driver) => f.events.filter((e): e is Extract<AgentEvent, { type: 'turn_started' }> => e.type === 'turn_started')

describe('Claude driver: continuations (L21, L23)', () => {
  test('L21: a queued message the CLI merged into the active turn shares its one result', async () => {
    const f = await idle()
    const a = await f.d.send('first')
    const q = await f.d.send('more', { continuation: 'queue' })
    expect(q.turnId).not.toBe(a.turnId)
    await tick()
    expect(f.q().prompts.map((p): string | undefined => p.uuid)).toEqual([a.messageUuid, q.messageUuid])
    expect(started(f)).toHaveLength(1) // the queued turn has not opened
    f.q().push(frames.text('both'), frames.result([a.messageUuid, q.messageUuid], 'both'))
    const [ra, rq] = await Promise.all([a.result, q.result])
    expect(rq).toBe(ra)
    expect(ra).toMatchObject({ turnId: a.turnId, outcome: 'success', finalText: 'both' })
    expect(f.results).toEqual([ra])
    expect(f.d.state).toBe('idle')
    expect(await f.d.send('next')).toBeTruthy() // the queue count was withdrawn
    await f.d.kill()
  })

  test('L21: a queued message the CLI ran next opens as its own turn with no idle in between', async () => {
    const f = await idle()
    const a = await f.d.send('first')
    const q = await f.d.send('second', { continuation: 'queue' })
    const mark = f.states.length
    f.q().push(frames.result([a.messageUuid], 'one'))
    expect((await a.result).finalText).toBe('one')
    await f.q().drain()
    expect(f.d.state).toBe('active')
    expect(f.d.lifecycle.activeTurnId).toBe(q.turnId)
    expect(f.states.slice(mark)).not.toContain('idle')
    expect(started(f).map((e) => e.turnId)).toEqual([a.turnId, q.turnId])
    const messages = f.events.filter((e) => e.type === 'user_message').map((e) => e.type === 'user_message' && [e.turnId, e.messageUuid])
    expect(messages).toEqual([[a.turnId, a.messageUuid], [q.turnId, q.messageUuid]])
    f.q().push(frames.result([q.messageUuid], 'two'))
    expect(await q.result).toMatchObject({ turnId: q.turnId, messageUuid: q.messageUuid, finalText: 'two' })
    expect(f.results.map((r) => r.turnId)).toEqual([a.turnId, q.turnId])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('L23: an unsupported continuation mode is refused before anything is sent', async () => {
    const f = await idle()
    await f.d.send('first')
    const before = f.events.length
    let error: unknown
    try {
      await f.d.send('steer me', { continuation: 'steer' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect((error as AgentRuntimeError).category).toBe('unsupported')
    await tick()
    expect([f.q().prompts.length, f.events.length]).toEqual([1, before])
    await f.d.kill()
  })
})

describe('Claude driver: result binding (R03, M-bind)', () => {
  test('R03: a previous turn\'s, a duplicate or an unknown UUID never completes the current turn', async () => {
    const f = await idle()
    const a = await f.d.send('first')
    const first = frames.result([a.messageUuid], 'one')
    f.q().push(first)
    await a.result
    const b = await f.d.send('second')
    f.q().push(
      frames.result([a.messageUuid], 'stale'), // a previous turn's prompt
      first, // the very same frame again
      frames.result(['00000000-0000-4000-8000-00000000beef'], 'unknown'),
    )
    await f.q().drain()
    expect(await Promise.race([b.result, tick(10).then(() => 'pending')])).toBe('pending')
    expect(f.results.map((r) => r.turnId)).toEqual([a.turnId])
    expect(f.d.state).toBe('active')
    f.q().push(frames.result([b.messageUuid], 'two'))
    expect((await b.result).finalText).toBe('two')
    expect(f.events.filter((e) => e.type === 'turn_completed')).toHaveLength(2)
    await f.d.kill()
  })

  test('R03: a result for an interrupted turn arriving after the next send binds to nothing', async () => {
    const f = await idle()
    const a = await f.d.send('first')
    f.q().push(frames.init())
    await f.q().drain()
    await f.d.interrupt()
    expect((await a.result).outcome).toBe('interrupted')
    const b = await f.d.send('second')
    f.q().push(frames.text('late text'), frames.result([a.messageUuid], 'late'))
    await f.q().drain()
    expect(await Promise.race([b.result, tick(10).then(() => 'pending')])).toBe('pending')
    f.q().push(frames.init(), frames.text('fresh'), frames.result([b.messageUuid], 'fresh'))
    expect(await b.result).toMatchObject({ turnId: b.turnId, finalText: 'fresh' })
    await f.d.kill()
  })
})

const pendingAfter = (handle: { result: Promise<unknown> }) => Promise.race([handle.result.then(() => 'settled'), tick(10).then(() => 'pending')])

describe('Claude driver: a result frame binds once (A1)', () => {
  test('the same UUID-less result R that finished A cannot finish the later prompted B, on this or a new generation', async () => {
    for (const respawn of [false, true]) {
      const f = await idle()
      const a = await f.d.send('A')
      const r = frames.result([], 'A done') // out of contract: a prompted result without a uuid
      f.q().push(r)
      expect((await a.result).finalText).toBe('A done')
      if (respawn) {
        f.q().exit()
        while (f.d.state !== 'exited') await tick()
        const again = f.d.start()
        while (f.queries.length < 2) await tick()
        f.q().ready()
        await again
      }
      const b = await f.d.send('B')
      f.q().push(r)
      await f.q().drain()
      expect(await pendingAfter(b)).toBe('pending')
      expect(f.results.map((x) => x.turnId)).toEqual([a.turnId])
      f.q().push(frames.result([b.messageUuid], 'B done'))
      expect(await b.result).toMatchObject({ turnId: b.turnId, finalText: 'B done' })
      await f.d.kill()
    }
  })

  test('the same UUID-less result R that finished agent-started N cannot finish the next agent-started turn', async () => {
    const f = await idle()
    const r = frames.result([], 'N done')
    f.q().push(frames.init(), r)
    await f.q().drain()
    f.q().push(frames.init(), r)
    await f.q().drain()
    expect(started(f)).toHaveLength(2)
    expect(f.results).toHaveLength(1)
    expect(f.d.state).toBe('active')
    // A fresh UUID-less result is the second turn's own.
    f.q().push(frames.result([], 'N2 done'))
    await f.q().drain()
    expect(f.results.map((x) => [x.turnId, x.finalText])).toEqual([[started(f)[0]!.turnId, 'N done'], [started(f)[1]!.turnId, 'N2 done']])
    await f.d.kill()
  })

  test('no window: after 1500 later results and an unknown-uuid flood, the replayed R still finishes neither a prompted nor a native B', async () => {
    for (const successor of ['prompted', 'native'] as const) {
      const f = await idle()
      const r = frames.result([], 'first')
      f.q().push(frames.init(), r)
      await f.q().drain()
      expect(f.results).toHaveLength(1)
      // 750 more agent-started turns, each finished by its own fresh result, then 750 unknown-uuid frames.
      for (let i = 0; i < 750; i++) f.q().push(frames.init(), frames.result([], `n${i}`))
      for (let i = 0; i < 750; i++) f.q().push(frames.result([crypto.randomUUID()], `unknown${i}`))
      await f.q().drain()
      expect(f.results).toHaveLength(751)
      const b = successor === 'prompted' ? await f.d.send('B') : null
      if (!b) f.q().push(frames.init())
      f.q().push(r)
      await f.q().drain()
      expect([f.results.length, f.d.state]).toEqual([751, 'active'])
      if (b) expect(await pendingAfter(b)).toBe('pending')
      await f.d.kill()
    }
  })

  test('a result frame without its own uuid has no identity: it is refused and logged, never completing a turn', async () => {
    const f = await idle()
    const a = await f.d.send('A')
    const anonymous = frames.result([a.messageUuid], 'anonymous') as unknown as Record<string, unknown>
    delete anonymous.uuid
    f.q().push(anonymous as never)
    await f.q().drain()
    expect(await pendingAfter(a)).toBe('pending')
    expect(f.warnings.map(([message]) => message)).toContain('claude_result_without_frame_uuid')
    f.q().push(frames.result([a.messageUuid], 'identified'))
    expect((await a.result).finalText).toBe('identified')
    await f.d.kill()
  })

  test('a different UUID-less frame still completes a prompted turn, and an unread prompt is still carried', async () => {
    const f = await idle()
    const a = await f.d.send('A')
    f.q().push(frames.result([], 'startup failure'))
    expect((await a.result).outcome).toBe('success')
    // A's prompt was never named: the CLI still holds it, so the next turn takes it over.
    const b = await f.d.send('B')
    f.q().push(frames.result([a.messageUuid], 'ran A for B'))
    await f.q().drain()
    expect(await pendingAfter(b)).toBe('settled')
    expect(await b.result).toMatchObject({ turnId: b.turnId, finalText: 'ran A for B' })
    await f.d.kill()
  })
})

describe('Claude driver: agent-started turns (L24, M-native)', () => {
  test('L24: an init while idle opens one turn with a task trigger and no user message; its result arrives once', async () => {
    const f = await idle()
    f.q().push(frames.taskNotification('t-9', 'completed', 'built'), frames.init(), frames.text('report'), frames.result([], 'report'))
    await f.q().drain()
    const [turn] = started(f)
    expect(turn).toMatchObject({ trigger: { kind: 'task', tasks: [{ taskId: 't-9', status: 'completed', summary: 'built' }] } })
    expect(f.types()).toEqual(['turn_started', 'assistant_text', 'turn_completed'])
    expect(f.results).toEqual([expect.objectContaining({ turnId: turn!.turnId, messageUuid: null, outcome: 'success', finalText: 'report' })])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('L24: a send while an agent-started turn is active is busy; the turn ends on stop as interrupted', async () => {
    const f = await idle()
    f.q().push(frames.init())
    await f.q().drain()
    let error: unknown
    try {
      await f.d.send('x')
    } catch (e) {
      error = e
    }
    expect((error as AgentRuntimeError).category).toBe('busy')
    await f.d.kill()
    expect(f.results.map((r) => [r.messageUuid, r.outcome])).toEqual([[null, 'interrupted']])
  })
})

describe('Claude driver: headless (P09)', () => {
  test('P09: with no host tools, context or wire the turn works and nothing extra is configured', async () => {
    const f = await idle()
    const options = f.q().options as Record<string, unknown>
    expect(options.mcpServers).toBeUndefined()
    expect(options.settingSources).toEqual([])
    const a = await f.d.send('hi')
    f.q().push(frames.text('hello'), frames.result([a.messageUuid], 'hello'))
    expect((await a.result).finalText).toBe('hello')
    await f.d.kill()
  })
})

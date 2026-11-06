// @reads: packages/agent-runtime/__tests__/fixtures/**
// The Claude driver's turn binding beyond the 56 pairs (task 4.1): queued
// continuations (L21, L23), agent-started turns (L24 with M-native), results
// that name a previous, duplicate or unknown prompt (R03, the M-bind
// target), a headless driver with no host additions (P09), and I6 over
// seeded streams of duplicated and reordered frames. Everything runs on the
// production ClaudeSession; only the SDK's query() is controlled.
import { describe, expect, test } from 'bun:test'
import type { TurnHandle, TurnResult } from '../src/contract.js'
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
    expect(f.q().prompts.map((p) => p.uuid)).toEqual([a.messageUuid, q.messageUuid])
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

// --- I6: seeded streams ---------------------------------------------------

type Op = 'send' | 'queue' | 'result' | 'merged' | 'stale' | 'duplicate' | 'unknown' | 'init' | 'text' | 'task' | 'interrupt' | 'restart'
const OPS: Op[] = ['send', 'send', 'queue', 'result', 'result', 'merged', 'stale', 'duplicate', 'unknown', 'init', 'text', 'task', 'interrupt', 'restart']

interface Completion {
  result: TurnResult
  frame: unknown
  query: number
}

async function stream(seed: number): Promise<string[]> {
  let state = seed >>> 0
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) >>> 0
    return (state >>> 8) % n
  }
  const completions: Completion[] = []
  const f: Driver = driver({ onTurnResult: (result) => completions.push({ result, frame: f.q().yielded, query: f.queries.length - 1 }) })
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  const handles: TurnHandle[] = []
  const sent = new Map<string, number>() // prompt uuid -> query index it was sent on
  const results: unknown[] = []
  const pending = () => handles.filter((h) => !f.results.some((r) => r.turnId === h.turnId)).map((h) => h.messageUuid)
  const length = 8 + next(25)
  for (let i = 0; i < length; i++) {
    const op = OPS[next(OPS.length)]!
    const q = f.q()
    const push = (frame: unknown) => {
      results.push(frame)
      q.push(frame as never)
    }
    try {
      if (op === 'send' || op === 'queue') {
        const handle = await f.d.send(`m${i}`, op === 'queue' ? { continuation: 'queue' } : {})
        handles.push(handle)
        sent.set(handle.messageUuid, f.queries.length - 1)
      } else if (op === 'result' || op === 'merged') {
        const live = pending()
        push(frames.result(op === 'merged' ? live : live.slice(0, 1), `r${i}`, next(4) === 0 ? 'error_during_execution' : 'success'))
      } else if (op === 'stale') {
        const done = handles.filter((h) => !pending().includes(h.messageUuid))
        if (done.length > 0) push(frames.result([done[next(done.length)]!.messageUuid]))
      } else if (op === 'duplicate') {
        const old = results.filter((r) => (r as { type: string }).type === 'result')
        if (old.length > 0) q.push(old[next(old.length)] as never)
      } else if (op === 'unknown') push(frames.result([crypto.randomUUID()]))
      else if (op === 'init') push(frames.init(`sess-${seed}`))
      else if (op === 'text') push(frames.text(`t${i}`))
      else if (op === 'task') push(frames.taskNotification(`task-${i}`))
      else if (op === 'interrupt') await f.d.interrupt()
      else if (op === 'restart') {
        q.exit()
        while (f.d.state !== 'exited') await tick()
        const again = f.d.start()
        while (f.queries.at(-1) === q) await tick()
        f.q().ready()
        await again
      }
    } catch (error) {
      if (!(error instanceof AgentRuntimeError) || !['busy', 'not-ready'].includes(error.category)) throw error
    }
    await f.q().drain()
  }
  await f.d.kill()
  await Promise.all(handles.map((h) => h.result))

  const violations: string[] = []
  const ids = new Set<string>()
  const lastSequence = new Map<string, number>()
  for (const event of f.events) {
    if (JSON.stringify(JSON.parse(JSON.stringify(event))) !== JSON.stringify(event)) violations.push(`not lossless: ${event.type}`)
    if (ids.has(event.id)) violations.push(`duplicate id ${event.id}`)
    ids.add(event.id)
    const previous = lastSequence.get(event.streamId) ?? 0
    if (event.sequence !== previous + 1) violations.push(`sequence ${previous} -> ${event.sequence}`)
    lastSequence.set(event.streamId, event.sequence)
  }
  const turnIds = f.results.map((r) => r.turnId)
  if (new Set(turnIds).size !== turnIds.length) violations.push('a turn had two results')
  // A result frame completes a turn only through a prompt it names that was
  // sent on the current generation and that no earlier completing frame named.
  // A prompt no result named is still unread by the CLI and may legitimately
  // complete a later turn (the binder carries it), so a turn's own UUID is
  // not consumed by a completion that did not name it.
  const consumed = new Set<string>()
  for (const { result, frame, query } of completions) {
    if (result.outcome !== 'success' && result.outcome !== 'failed') continue
    const uuids = ((frame as { user_message_uuids?: string[] } | null)?.user_message_uuids ?? []) as string[]
    if ((frame as { type?: string } | null)?.type !== 'result') violations.push(`completion outside a result frame`)
    if (uuids.length > 0 && !uuids.some((uuid) => sent.get(uuid) === query && !consumed.has(uuid))) {
      violations.push(`turn ${result.turnId} completed by a stale or foreign result`)
    }
    for (const uuid of uuids) consumed.add(uuid)
  }
  return violations
}

describe('Claude driver: I6 over seeded streams', () => {
  // 0xA606, 300 streams, in six slices so each test stays within its timeout.
  for (let slice = 0; slice < 6; slice++) {
    test(`I6: events are lossless, unique and ordered, and no stale result finishes a turn (streams ${slice * 50}-${slice * 50 + 49})`, async () => {
      const failures: string[] = []
      for (let i = slice * 50; i < slice * 50 + 50; i++) {
        const violations = await stream(0xa606 + i * 7919)
        if (violations.length > 0) failures.push(`stream ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
    })
  }
})

// @reads: packages/agent-runtime/__tests__/fixtures/**
// I6 for Codex over seeded streams (task 5.1; R03/R07): the production
// session, binder, emitter and transport, with the fake app-server served
// in-process behind the transport's private spawn seam (inProcessCodex.ts;
// Lead decision e5492858). The owned-stdio witnesses of each wiring guard
// stay on the real process (oldFrame, codexUsageFacts, codexDriver*). Each turn is one `/script` whose notes mix the
// turn's own deltas and tool items (ids repeated) with duplicated and
// reordered source frames: a repeated turn/started, turn/completed frames
// naming an earlier turn of the generation (completed or failed), an unknown
// turn id, and tool items naming an earlier or unknown turn. The turn then
// completes, fails, is held and interrupted, or its process exits; a restart
// is a new generation whose app-server numbers its turns from turn-1 again,
// so the earlier generation's native ids recur.
//
// The reference below is told only what was sent. Every handle must resolve
// with the outcome its end names and the count of its own distinct tool ids;
// onTurnResult reports each handle once, in order; each handle opens exactly
// one turn_started, in order, and no other turn is opened; every turn-bound
// event names a handle's turn, and a turn's tool calls are exactly its own
// distinct ids. Events stay lossless, unique and ordered per stream.
// M-bind (a turn/completed settling the active turn whatever id it names)
// must fail the outcome assertion.
import { afterEach, describe, expect, test } from 'bun:test'
import type { TurnHandle, TurnOutcome, TurnResult } from '../src/contract.js'
import { codexDriver, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

type Note = { method: string; params?: Record<string, unknown> }
const NOTES = ['delta', 'tool', 'tool', 'stale', 'staleFailed', 'unknown', 'duplicateStarted', 'foreignTool'] as const
const ENDS = ['completed', 'completed', 'failed', 'hold', 'exit'] as const

const random = (seed: number) => {
  let state = seed >>> 0
  return (n: number) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0
  }
}

const commandItem = (id: string, turnId?: string): Note[] => {
  const item = { type: 'commandExecution', id, command: 'ls', cwd: '/', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }
  const where = turnId === undefined ? {} : { turnId }
  return [{ method: 'item/started', params: { ...where, item } }, { method: 'item/completed', params: { ...where, item } }]
}
const completion = (id: string, failed: boolean): Note => ({
  method: 'turn/completed',
  params: { turn: { id, status: failed ? 'failed' : 'completed', items: [], error: failed ? { message: 'stale failure', codexErrorInfo: 'other', additionalDetails: null } : null } },
})

/** The hazards the streams reached (for the coverage check). */
const seen = new Set<string>()
const CLASSES = ['stale:earlier', 'staleFailed:earlier', 'foreignTool:earlier', 'stale:reused-after-restart', 'duplicateStarted', 'unknown', 'tool:repeated', 'end:completed', 'end:failed', 'end:hold', 'end:exit']

const LATE = Symbol('late')
/** A driver step bounded by a deadline: a step that never settles is a named violation, not a hung test. */
async function within<T>(step: Promise<T>, ms = 10_000): Promise<T | typeof LATE> {
  let timer!: ReturnType<typeof setTimeout>
  const late = new Promise<typeof LATE>((resolve) => (timer = setTimeout(() => resolve(LATE), ms)))
  try {
    return await Promise.race([step, late])
  } finally {
    clearTimeout(timer)
  }
}

const OUTCOME: Record<(typeof ENDS)[number], TurnOutcome> = { completed: 'success', failed: 'failed', hold: 'interrupted', exit: 'process-ended' }

async function stream(seed: number): Promise<string[]> {
  const next = random(seed)
  const h = codexDriver({ inProcess: true })
  await h.driver.start()
  const violations: string[] = []
  const handles: TurnHandle[] = []
  const settled: TurnResult[] = []
  const expected = new Map<string, { outcome: TurnOutcome; tools: string[] }>()
  // The reference: the fake numbers each generation's turns turn-1, turn-2, ...
  let sends = 0
  let finished: string[] = []
  /** Native ids an earlier generation already used. */
  const retired = new Set<string>()
  const turns = 2 + next(6)
  for (let t = 0; t < turns; t++) {
    const native = `turn-${++sends}`
    const tools = new Set<string>()
    const notes: Note[] = []
    const length = next(8)
    for (let i = 0; i < length; i++) {
      const op = NOTES[next(NOTES.length)]!
      const earlier = finished.length > 0 ? finished[next(finished.length)]! : null
      if (earlier && (op === 'stale' || op === 'staleFailed' || op === 'foreignTool')) seen.add(`${op}:earlier`)
      if (earlier && op === 'stale' && retired.has(earlier)) seen.add('stale:reused-after-restart')
      if (op === 'duplicateStarted' || op === 'unknown') seen.add(op)
      if (op === 'delta') notes.push({ method: 'item/agentMessage/delta', params: { itemId: `m${t}`, delta: `d${i}` } })
      else if (op === 'tool') {
        const id = ['cmd-a', 'cmd-b', 'cmd-c'][next(3)]!
        if (tools.has(id)) seen.add('tool:repeated')
        tools.add(id)
        notes.push(...commandItem(id))
      } else if (op === 'stale' || op === 'staleFailed') notes.push(completion(earlier ?? 'turn-none', op === 'staleFailed'))
      else if (op === 'unknown') notes.push(completion(`turn-x${next(1000)}`, next(2) === 0))
      else if (op === 'duplicateStarted') notes.push({ method: 'turn/started', params: { turn: { id: native, status: 'inProgress', items: [], error: null } } })
      else notes.push(...commandItem(`cmd-f${i}`, earlier ?? 'turn-none'))
    }
    const end = ENDS[next(ENDS.length)]!
    seen.add(`end:${end}`)
    // An interrupt settles the turn at once (L09), so a held turn's notes must be read first: a sentinel delta ends them.
    const sentinel = `held-${seed}-${t}`
    if (end === 'hold') notes.push({ method: 'item/agentMessage/delta', params: { itemId: `m${t}`, delta: sentinel } })
    const wire = end === 'failed' ? 'failed:"other"' : end === 'exit' ? 'exit:0' : end
    const handle = await within(h.driver.send(`/script ${JSON.stringify({ notes, end: wire })}`))
    if (handle === LATE) {
      violations.push(`turn ${t}: send never admitted`)
      break
    }
    handles.push(handle)
    expected.set(handle.turnId, { outcome: OUTCOME[end], tools: [...tools].sort() })
    if (end === 'hold') {
      if (!(await waitFor(() => h.events.some((e) => e.type === 'assistant_delta' && e.delta === sentinel)))) violations.push(`turn ${t}: the held turn's last delta never reached it (did it settle early?)`)
      await within(h.driver.interrupt())
    }
    const result = await within(handle.result)
    if (result === LATE) {
      violations.push(`turn ${t}: never settled (expected ${OUTCOME[end]})`)
      break
    }
    settled.push(result)
    finished.push(native)
    if (end === 'exit') {
      for (const id of finished) retired.add(id)
      sends = 0
      finished = []
      if ((await within(h.driver.start())) === LATE) {
        violations.push(`turn ${t}: the restart never became ready`)
        break
      }
    }
  }
  const stop = await within(h.driver.kill().then(() => null, (error: unknown) => error), 15_000)
  if (stop === LATE) violations.push('the stop never completed')
  else if (stop !== null) violations.push(`the stop failed: ${stop instanceof Error ? stop.message : String(stop)}`)
  if (violations.length > 0) return violations

  if (new Set(handles.map((handle) => handle.turnId)).size !== handles.length) violations.push('a turn id was reused')
  for (const [i, result] of settled.entries()) {
    const want = expected.get(handles[i]!.turnId)!
    const actual = { turnId: result.turnId, outcome: result.outcome, toolCallCount: result.toolCallCount }
    const wanted = { turnId: handles[i]!.turnId, outcome: want.outcome, toolCallCount: want.tools.length }
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) violations.push(`turn ${i}: ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`)
  }
  const reported = JSON.stringify(h.results.map((r) => [r.turnId, r.outcome]))
  if (reported !== JSON.stringify(settled.map((r) => [r.turnId, r.outcome]))) violations.push(`onTurnResult ${reported}`)
  const opened = h.events.filter((e) => e.type === 'turn_started').map((e) => (e as { turnId: string }).turnId)
  if (JSON.stringify(opened) !== JSON.stringify(handles.map((handle) => handle.turnId))) violations.push(`opened ${opened.length} turns for ${handles.length} sends`)
  const known = new Set(handles.map((handle) => handle.turnId))
  for (const event of h.events) {
    const turnId = (event as { turnId?: string | null }).turnId
    if (typeof turnId === 'string' && !known.has(turnId)) violations.push(`${event.type} names an unknown turn`)
  }
  for (const handle of handles) {
    const calls = h.events.filter((e) => e.type === 'tool_call' && e.turnId === handle.turnId).map((e) => (e as { toolCallId: string }).toolCallId)
    if (JSON.stringify([...calls].sort()) !== JSON.stringify(expected.get(handle.turnId)!.tools)) violations.push(`tool calls ${JSON.stringify(calls)} for ${JSON.stringify(expected.get(handle.turnId)!.tools)}`)
  }

  const ids = new Set<string>()
  const lastSequence = new Map<string, number>()
  for (const event of h.events) {
    if (JSON.stringify(JSON.parse(JSON.stringify(event))) !== JSON.stringify(event)) violations.push(`not lossless: ${event.type}`)
    if (ids.has(event.id)) violations.push(`duplicate id ${event.id}`)
    ids.add(event.id)
    const previous = lastSequence.get(event.streamId) ?? 0
    if (event.sequence !== previous + 1) violations.push(`sequence ${previous} -> ${event.sequence}`)
    lastSequence.set(event.streamId, event.sequence)
  }
  return violations
}

describe('Codex driver: I6 over seeded streams', () => {
  // 0xA606, 300 streams (mulberry32), in slices so each test stays within its timeout.
  for (let slice = 0; slice < 15; slice++) {
    test(`I6: every outcome, count, opening and event matches the reference; events are lossless, unique and ordered (streams ${slice * 20}-${slice * 20 + 19})`, async () => {
      const failures: string[] = []
      for (let i = slice * 20; i < slice * 20 + 20; i++) {
        const violations = await stream(0xa606 + i * 7919)
        if (violations.length > 0) {
          failures.push(`stream ${i}: ${violations.join('; ')}`)
          break // the first failing stream is the evidence; the rest of the slice would only repeat it
        }
      }
      expect(failures).toEqual([])
    })
  }
  test('the 300 streams reached every hazard class', () => {
    expect(CLASSES.filter((c) => !seen.has(c))).toEqual([])
  })
})

describe('Codex driver: the binding guard on the owned process (real stdio witness)', () => {
  test('a stale failed turn/completed naming the earlier turn, one naming an unknown turn, and a tool item naming the earlier turn reach nothing: the current turn succeeds with its own text and no tool call', async () => {
    const h = codexDriver()
    await h.driver.start()
    const first = await (await h.driver.send('one')).result
    expect(first.outcome).toBe('success')
    const notes = [completion('turn-1', true), completion('turn-x7', true), ...commandItem('cmd-f', 'turn-1'), { method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'own' } }]
    const handle = await h.driver.send(`/script ${JSON.stringify({ notes })}`)
    const result = await handle.result
    expect({ turnId: result.turnId, outcome: result.outcome, finalText: result.finalText, tools: result.toolCallCount }).toEqual({ turnId: handle.turnId, outcome: 'success', finalText: 'codex:tpircs|seen=one', tools: 0 })
    expect(h.events.filter((e) => e.type === 'tool_call')).toEqual([])
    expect(h.results.map((r) => r.outcome)).toEqual(['success', 'success'])
    expect(h.events.filter((e) => e.type === 'error')).toEqual([])
  })
})

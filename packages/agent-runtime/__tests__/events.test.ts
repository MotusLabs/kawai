// @reads: packages/agent-runtime/__tests__/fixtures/**
// The one ordered JSON event stream (task 5.1; R07/I6) through both public
// factories and their default owned processes (the fake Claude CLI and the
// fake Codex app-server), plus the Claude controlled query for values no
// JSON wire can carry.
// - A driver resuming a saved conversation is a new stream: its events never
//   collide with the archived stream's ids, its sequence starts at 1, and the
//   archive keeps its ids and order through a JSONL round-trip. M-bind (an
//   emitter reusing the previous stream identity) fails the collision check.
// - Original ids (turn, message UUID, tool call) are kept as given.
// - Any value a frame or host hands an event is a JSON value at the boundary:
//   the event equals its own JSONL round-trip, whatever its input held.
// - F1: every own JSON key of a native tool input is kept, `__proto__`
//   included at any depth, as data (no prototype change), through both
//   public factories over their default owned processes.
import { afterEach, describe, expect, test } from 'bun:test'
import { createClaudeDriver } from '../src/claude/index.js'
import type { AgentDriver, ResumeCheckpoint } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import { driver } from './helpers/claudeDriverHarness.js'
import { codexDriver, codexRoot, stopDrivers } from './helpers/codexDriverHarness.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
const claudeDrivers: AgentDriver[] = []
afterEach(async () => {
  await Promise.allSettled(claudeDrivers.splice(0).map((d) => d.kill()))
  await stopDrivers()
})
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Violations of R07 over archived streams followed by later ones: ids, identity, order, losslessness. */
function streamViolations(streams: AgentEvent[][]): string[] {
  const violations: string[] = []
  const ids = new Set<string>()
  const identities = new Set<string>()
  for (const [index, events] of streams.entries()) {
    const archived = events.map((e) => JSON.stringify(e)).join('\n')
    const replayed = archived.split('\n').map((line) => JSON.parse(line) as AgentEvent)
    if (JSON.stringify(replayed) !== JSON.stringify(events)) violations.push(`stream ${index}: not lossless`)
    const own = new Set(events.map((e) => e.streamId))
    if (own.size !== 1) violations.push(`stream ${index}: ${own.size} stream identities`)
    for (const identity of own) {
      if (identities.has(identity)) violations.push(`stream ${index}: reuses stream identity ${identity}`)
      identities.add(identity)
    }
    events.forEach((event, i) => {
      if (event.sequence !== i + 1) violations.push(`stream ${index}: sequence ${event.sequence} at ${i + 1}`)
      if (ids.has(event.id)) violations.push(`stream ${index}: event id ${event.id} collides`)
      ids.add(event.id)
    })
  }
  return violations
}

describe('one ordered JSON event stream per driver (R07)', () => {
  // @covers: agent-runtime › Events are ordered serializable values › JSONL and resumed stream
  test('Claude: a resumed driver is a new stream that never collides with the archive; original ids are kept', async () => {
    const home = fakeClaudeHome()
    const launch = home.launch({ FAKE_CLAUDE_SESSIONS: '1' })
    const run = async (resume: ResumeCheckpoint | null, prompt: string) => {
      const events: AgentEvent[] = []
      const saved: ResumeCheckpoint[] = []
      const d = createClaudeDriver({
        launch, logger, permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: [] },
        callbacks: { onEvent: (e) => void events.push(e), onCheckpoint: (c) => void saved.push(c) },
        ...(resume ? { resume } : {}),
      })
      claudeDrivers.push(d)
      await d.start()
      const handle = await d.send(prompt, { messageUuid: crypto.randomUUID() })
      await handle.result
      await d.shutdown()
      return { events, saved, handle }
    }
    const first = await run(null, 'one')
    const second = await run(first.saved[0]!, 'two')
    expect(streamViolations([first.events, second.events])).toEqual([])
    for (const { events, handle } of [first, second]) {
      expect(events.find((e) => e.type === 'user_message')).toMatchObject({ turnId: handle.turnId, messageUuid: handle.messageUuid })
      expect(events.filter((e) => 'turnId' in e && e.turnId !== handle.turnId)).toEqual([])
    }
  })

  // @covers: agent-runtime › Events are ordered serializable values › JSONL and resumed stream
  test('Codex: a resumed driver is a new stream that never collides with the archive; original ids are kept', async () => {
    const root = codexRoot()
    const first = codexDriver({ root })
    await first.driver.start()
    const one = await first.driver.send('one')
    await one.result
    await first.driver.shutdown()
    const second = codexDriver({ root, resume: first.checkpoints[0]! })
    await second.driver.start()
    const two = await second.driver.send('two')
    await two.result
    await second.driver.shutdown()
    expect(streamViolations([first.events, second.events])).toEqual([])
    expect(second.events.filter((e) => 'turnId' in e && e.turnId !== two.turnId)).toEqual([])
    expect(first.events.find((e) => e.type === 'user_message')).toMatchObject({ turnId: one.turnId, messageUuid: one.messageUuid })
  })

  test('an event is a JSON value whatever its source handed it, and keeps the original tool call id', async () => {
    const f = driver({ resume: null })
    const start = f.d.start()
    while (f.queries.length === 0) await tick()
    f.q().ready()
    await start
    const handle = await f.d.send('go')
    const input: Record<string, unknown> = { keep: 'x', gone: undefined, nan: Number.NaN, big: 10n, when: new Date(0), list: [undefined, () => 1, Infinity], fn: () => 2 }
    input.self = input
    f.q().push({ type: 'assistant', uuid: 'a-json', session_id: 'sess-1', parent_tool_use_id: null, message: { id: 'msg-json', role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 'toolu_original', name: 'Read', input }] } } as never)
    await f.q().drain()
    const call = f.events.find((e) => e.type === 'tool_call')!
    expect(JSON.parse(JSON.stringify(call))).toEqual(call)
    expect(call).toMatchObject({ turnId: handle.turnId, toolCallId: 'toolu_original', tool: 'Read' })
    expect((call as { input: unknown }).input).toEqual({ keep: 'x', nan: null, big: '10', when: '1970-01-01T00:00:00.000Z', list: [null, null, null], self: null })
    expect(streamViolations([f.events])).toEqual([])
    await f.d.kill()
  })

  // A tool input whose own keys include __proto__ at two depths and other Object.prototype names.
  const SPECIAL = '{"__proto__":{"sentinel":"original","__proto__":{"deep":1}},"constructor":{"name":"c"},"toString":"t","ordinary":7}'
  const keepsSpecialKeys = (input: unknown) => {
    const value = input as Record<string, unknown>
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(value.sentinel).toBeUndefined()
    const nested = Object.getOwnPropertyDescriptor(value, '__proto__')!.value as Record<string, unknown>
    expect(Object.hasOwn(nested, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype)
    expect(JSON.stringify(value)).toBe(JSON.stringify(JSON.parse(SPECIAL)))
    // The JSONL round-trip keeps them too.
    const replayed = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    expect(Object.hasOwn(replayed, '__proto__')).toBe(true)
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(value))
  }

  test('Codex: a native tool input keeps its own __proto__, constructor and toString keys at every depth through the owned process', async () => {
    const h = codexDriver()
    await h.driver.start()
    const item = { type: 'mcpToolCall', id: 'tool-json-key', server: 's', tool: 't', arguments: JSON.parse(SPECIAL), status: 'inProgress', result: null, error: null }
    const result = await (await h.driver.send(`/script ${JSON.stringify({ notes: [{ method: 'item/started', params: { item } }] })}`)).result
    expect(result.outcome).toBe('success')
    const call = h.events.find((e) => e.type === 'tool_call') as { input: unknown; toolCallId: string } | undefined
    expect(call?.toolCallId).toBe('tool-json-key')
    keepsSpecialKeys(call!.input)
    expect(streamViolations([h.events])).toEqual([])
  })

  test('Claude: a native tool_use input keeps its own __proto__, constructor and toString keys at every depth through the owned CLI', async () => {
    const events: AgentEvent[] = []
    const d = createClaudeDriver({ launch: fakeClaudeHome().launch(), logger, permissions: { mode: 'default', enabledTools: [], disallowedTools: [] }, callbacks: { onEvent: (e) => void events.push(e) } })
    claudeDrivers.push(d)
    await d.start()
    const frame = { type: 'assistant', uuid: 'a-special', parent_tool_use_id: null, message: { id: 'msg-special', role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 'toolu_special', name: 'Read', input: JSON.parse(SPECIAL) }] } }
    const result = await (await d.send(`script ${JSON.stringify({ frames: [frame] })}`)).result
    expect(result.outcome).toBe('success')
    const call = events.find((e) => e.type === 'tool_call') as { input: unknown; toolCallId: string } | undefined
    expect(call?.toolCallId).toBe('toolu_special')
    keepsSpecialKeys(call!.input)
    expect(streamViolations([events])).toEqual([])
  })
})

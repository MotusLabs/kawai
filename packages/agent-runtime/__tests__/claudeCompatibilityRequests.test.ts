// GAP13 (task-98101592 A9, design §2's eighth exception): native tool-call
// identity on Claude requests, on the production ClaudeSession over a
// controlled query. The SDK's canUseTool `toolUseID`, when it is a nonempty
// string, is copied unchanged onto the request before it is registered: the
// request event, the onRequest copy and every pending-list view carry it as
// `toolCallId`, beside the runtime's own distinct `requestId`, which alone
// settles. A missing, empty or non-string ID is omitted, never derived from
// the tool, input, order or request id. Views stay detached copies.
import { afterEach, describe, expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, PendingRequest } from '../src/events.js'
import { CompatibilityCleanup } from './helpers/claudeCompatibilityCleanup.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every driver this file started; the shared owner stops and joins all of them, then rethrows unasserted failures. */
const cleanup = new CompatibilityCleanup()
afterEach(() => cleanup.finishAll())

async function idle(hooks: DriverHooks = {}): Promise<Driver> {
  const f = driver(hooks)
  cleanup.track(f)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

function ask(f: Driver, tool: string, input: Record<string, unknown>, toolUseID: unknown, signal = new AbortController().signal): Promise<PermissionResult | null> {
  return f.q().options.canUseTool!(tool, input, { signal, suggestions: [], toolUseID } as never)
}

type RequestEvent = Extract<AgentEvent, { type: 'question_request' | 'approval_request' }>
const requestEvents = (f: Driver) => f.events.filter((e): e is RequestEvent => e.type === 'question_request' || e.type === 'approval_request')
const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }

describe('Claude requests carry the native tool-call ID (GAP13)', () => {
  // @covers: agent-runtime › Requests can be answered immediately › Native tool-call identity on requests
  test('two concurrent equal approvals keep their own native IDs on the event, the callback and the list; reversed settlement follows requestId', async () => {
    const seen: PendingRequest[] = []
    const f = await idle({ unansweredRequests: 'wait', onRequest: (request) => void seen.push(request) })
    const first = ask(f, 'Bash', { command: 'ls' }, 'toolu_A')
    const second = ask(f, 'Bash', { command: 'ls' }, 'toolu_B')
    await tick()
    const events = requestEvents(f)
    expect(events.map((e) => [e.type, e.toolCallId])).toEqual([['approval_request', 'toolu_A'], ['approval_request', 'toolu_B']])
    expect(seen.map((r) => r.toolCallId)).toEqual(['toolu_A', 'toolu_B'])
    expect(f.d.pendingRequests().map((r) => r.toolCallId)).toEqual(['toolu_A', 'toolu_B'])
    const [a, b] = events.map((e) => e.requestId)
    expect(new Set([a, b, 'toolu_A', 'toolu_B']).size).toBe(4)
    // Views are detached: mutating one changes no later view.
    seen[0]!.toolCallId = 'mutated'
    f.d.pendingRequests()[0]!.toolCallId = 'mutated'
    expect(f.d.pendingRequests().map((r) => r.toolCallId)).toEqual(['toolu_A', 'toolu_B'])
    // B first: the decision follows the request id, not the order or the native id.
    expect(f.d.resolveApproval(b!, 'deny')).toEqual({ ok: true })
    expect(await second).toMatchObject({ behavior: 'deny' })
    expect(f.d.pendingRequests().map((r) => [r.requestId, r.toolCallId])).toEqual([[a, 'toolu_A']])
    expect(f.d.resolveApproval(a!, 'allow')).toEqual({ ok: true })
    expect(await first).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('a question carries its native ID too', async () => {
    const f = await idle({ unansweredRequests: 'wait' })
    void ask(f, 'AskUserQuestion', QUESTION, 'toolu_Q')
    await tick()
    expect(requestEvents(f).map((e) => [e.type, e.toolCallId])).toEqual([['question_request', 'toolu_Q']])
    expect(f.d.pendingRequests()).toMatchObject([{ kind: 'question', toolCallId: 'toolu_Q' }])
  })

  test('a missing, empty or non-string native ID is omitted, never derived; an ID is kept exactly as given', async () => {
    const f = await idle({ unansweredRequests: 'wait' })
    const ids: unknown[] = [undefined, '', 42, null, { id: 'x' }, '  toolu_spaced  ']
    for (const id of ids) void ask(f, 'Bash', { command: 'ls' }, id)
    await tick()
    expect(requestEvents(f).map((e) => ('toolCallId' in e ? e.toolCallId : 'absent'))).toEqual(['absent', 'absent', 'absent', 'absent', 'absent', '  toolu_spaced  '])
    expect(f.d.pendingRequests().map((r) => ('toolCallId' in r ? r.toolCallId : 'absent'))).toEqual(['absent', 'absent', 'absent', 'absent', 'absent', '  toolu_spaced  '])
  })
})

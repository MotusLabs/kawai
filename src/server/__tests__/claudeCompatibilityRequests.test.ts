// GAP13 (task-98101592 A9): Kawai's denied- and cancelled-card audit names
// the native tool-call ID through the production composition
// (createChatDriver -> claudeRuntime.ts -> the accepted package) over a
// scripted CLI. The request's native `toolCallId` comes first; the stream's
// tool_use map is the fallback only when the runtime gave none. A
// callback-only request (no preceding tool_use frame) keeps its true ID, and
// two concurrent equal-tool, equal-input cards keep theirs whatever order
// they settle in.
import { afterEach, describe, expect, test } from 'bun:test'
import type { OutboundAuditSink } from '../outbound/observer'
import { compatibilityAdapter, finishAll, initFrame, settle, until, type Harness } from './helpers/claudeCompatibilityHarness'

afterEach(async () => {
  await finishAll()
})

function audited() {
  const denied: Array<{ toolUseId: string; reason?: string }> = []
  const sink: OutboundAuditSink = {
    onPreToolUse: () => {},
    onPostToolUse: () => {},
    onPostToolUseFailure: () => {},
    onPermissionDenied: () => {},
    onDeniedCard: (use) => void denied.push({ toolUseId: use.toolUseId, ...(use.reason === undefined ? {} : { reason: use.reason }) }),
    onSpawnEnd: () => {},
  }
  return { h: compatibilityAdapter({ outbound: sink }), denied }
}

async function turn(h: Harness): Promise<void> {
  h.driver.send('go')
  await until(() => h.scripts[0]?.prompts.length === 1)
  h.scripts[0]!.push(initFrame())
  await until(() => h.events.some((e) => e.type === 'turn_started'))
}

const ask = (h: Harness, toolUseID: string | undefined, signal = new AbortController().signal) =>
  h.scripts[0]!.options.canUseTool!('Bash', { command: 'git push' }, { signal, toolUseID, requestId: `sdk-${toolUseID ?? 'none'}` } as never)

const cardIds = (h: Harness) => h.events.flatMap((e) => (e.type === 'approval_request' ? [e.requestId] : []))

describe("Claude card audit names the request's native tool-call ID (GAP13)", () => {
  // The parent's original oracle: an interrupt-cancelled card stays denied, with detail interrupted (CC round 3).
  test('an interrupt-cancelled card stays denied, with detail interrupted (CC round 3)', async () => {
    const { h, denied } = audited()
    await turn(h)
    const controller = new AbortController()
    const cancelled = ask(h, 'toolu_cancel', controller.signal)
    await until(() => cardIds(h).length === 1)
    controller.abort()
    expect(await cancelled).toMatchObject({ behavior: 'deny', interrupt: true })
    await settle()
    expect(denied).toEqual([{ toolUseId: 'toolu_cancel', reason: 'interrupted' }])
  })

  test('two concurrent equal cards with no tool_use frame keep their own IDs, settled in reverse', async () => {
    const { h, denied } = audited()
    await turn(h)
    const controllerA = new AbortController()
    const a = ask(h, 'toolu_A', controllerA.signal)
    const b = ask(h, 'toolu_B')
    await until(() => cardIds(h).length === 2)
    const [cardA, cardB] = cardIds(h)
    expect(cardA).not.toBe(cardB)
    expect(h.driver.resolveApproval(cardB!, 'deny')).toEqual({ ok: true })
    expect(await b).toMatchObject({ behavior: 'deny' })
    controllerA.abort()
    expect(await a).toMatchObject({ behavior: 'deny', interrupt: true })
    await settle()
    expect(denied).toEqual([{ toolUseId: 'toolu_B' }, { toolUseId: 'toolu_A', reason: 'interrupted' }])
  })

  test("with no native ID the stream's tool_use is the fallback; with both, the native ID wins", async () => {
    const { h, denied } = audited()
    await turn(h)
    h.scripts[0]!.push({ type: 'assistant', message: { id: 'msg_t', role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_stream', name: 'Bash', input: { command: 'git push' } }] } })
    await until(() => h.driver.getSeenToolCallIds().has('toolu_stream'))
    const fallback = ask(h, undefined)
    const native = ask(h, 'toolu_native')
    await until(() => cardIds(h).length === 2)
    const [first, second] = cardIds(h)
    h.driver.resolveApproval(first!, 'deny')
    h.driver.resolveApproval(second!, 'deny')
    await Promise.all([fallback, native])
    await settle()
    expect(denied).toEqual([{ toolUseId: 'toolu_stream' }, { toolUseId: 'toolu_native' }])
  })
})

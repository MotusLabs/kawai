// GAP7 (task-98101592 A1): capability-aware interrupts through Kawai's
// production composition (createChatDriver -> claudeRuntime.ts -> the
// accepted package) over a scripted CLI. A generation counts
// interrupt_cancel_queued_v1 as supported until an init reports a
// capabilities array, which replaces the answer; an absent or non-array
// field keeps it. Supported: Stop sends { cancelQueued: true }. Unsupported:
// a plain interrupt, and Stop logs claude_cli_contract_violation with
// interrupt-cancel-queued-unsupported. Kill sends no interrupt and logs
// nothing. A raw interrupt failure reaches settled() once as the original
// object.
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import { logger } from '../logger'
import { CAPS, busy, compatibilityAdapter, finishAll, initFrame, settle, until } from './helpers/claudeCompatibilityHarness'

let warn: Mock<typeof logger.warn>
const violations = () => warn.mock.calls.filter(([name]) => name === 'claude_cli_contract_violation').map(([, data]) => (data as { reason?: string }).reason)
beforeEach(() => {
  warn = spyOn(logger, 'warn')
})
afterEach(async () => {
  try {
    await finishAll()
  } finally {
    warn.mockRestore()
  }
})

const UNSUPPORTED = 'interrupt-cancel-queued-unsupported'

describe('Claude interrupt capability through the production composition (GAP7)', () => {
  // The parent's original oracle: without the capability Stop sends a plain interrupt and logs the violation.
  test('without the capability Stop sends a plain interrupt and logs the violation', async () => {
    const h = compatibilityAdapter()
    await busy(h, ['interrupt_receipt_v1'])
    await h.driver.interrupt()
    await until(() => h.scripts[0]!.interrupts.length === 1)
    expect(h.scripts[0]!.interrupts).toEqual([undefined])
    expect(violations()).toEqual([UNSUPPORTED])
  })

  test('with the capability Stop sends cancelQueued and logs nothing', async () => {
    const h = compatibilityAdapter()
    await busy(h, CAPS)
    await h.driver.interrupt()
    await until(() => h.scripts[0]!.interrupts.length === 1)
    expect(h.scripts[0]!.interrupts).toEqual([{ cancelQueued: true }])
    expect(violations()).toEqual([])
  })

  test('before any init the capability counts as present', async () => {
    const h = compatibilityAdapter()
    h.driver.send('long job')
    await until(() => h.scripts[0]?.prompts.length === 1)
    await until(() => h.events.some((e) => e.type === 'turn_started'))
    await h.driver.interrupt()
    await until(() => h.scripts[0]!.interrupts.length === 1)
    expect(h.scripts[0]!.interrupts).toEqual([{ cancelQueued: true }])
    expect(violations()).toEqual([])
  })

  test('an init without a capabilities array keeps the earlier answer; a later array replaces it both ways', async () => {
    const h = compatibilityAdapter()
    const trace: unknown[] = []
    // [init capabilities pushed before the interrupt, ...]: each round is one busy turn, then Stop.
    const rounds: unknown[][] = [[undefined], [['interrupt_receipt_v1']], ['not-an-array'], [undefined], [CAPS], [{ 0: 'interrupt_cancel_queued_v1' }], [['interrupt_receipt_v1']]]
    for (const [index, [capabilities]] of rounds.entries()) {
      await busy(h, capabilities)
      await h.driver.interrupt()
      await until(() => h.scripts[0]!.interrupts.length === index + 1)
      // The interrupted turn's result: the next round's init must open a new turn, not absorb an owed one.
      const uuid = String(h.scripts[0]!.prompts.at(-1)!.uuid)
      h.scripts[0]!.push({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: 1, output_tokens: 1 }, user_message_uuid: uuid, user_message_uuids: [uuid] })
      await settle()
      h.events.length = 0
      trace.push(h.scripts[0]!.interrupts.at(-1))
    }
    const plain = undefined
    const cancel = { cancelQueued: true }
    expect(trace).toEqual([cancel, plain, plain, plain, cancel, cancel, plain])
    expect(violations()).toEqual([UNSUPPORTED, UNSUPPORTED, UNSUPPORTED, UNSUPPORTED])
  })

  test('a respawned process starts supported again: its first Stop sends cancelQueued', async () => {
    const h = compatibilityAdapter()
    await busy(h, ['interrupt_receipt_v1'])
    h.scripts[0]!.exit()
    await until(() => h.driver.isDead)
    h.driver.send('again')
    await until(() => h.scripts[1]?.prompts.length === 1)
    await until(() => h.events.filter((e) => e.type === 'turn_started').length === 2)
    await h.driver.interrupt()
    await until(() => h.scripts[1]!.interrupts.length === 1)
    expect([h.scripts[0]!.interrupts, h.scripts[1]!.interrupts]).toEqual([[], [{ cancelQueued: true }]])
    expect(violations()).toEqual([])
  })

  test("a plain interrupt's receipt still withdraws the prompts it cancelled", async () => {
    const h = compatibilityAdapter()
    const done = (uuid: string, tokens: number) => ({ type: 'result', subtype: 'success', is_error: false, result: 'r', num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: tokens, output_tokens: 1 }, user_message_uuid: uuid, user_message_uuids: [uuid] })
    // Turn 0 tells this generation the capability is missing, then ends.
    const zero = await busy(h, ['interrupt_receipt_v1'])
    h.scripts[0]!.push(done(String(zero.uuid), 3))
    await until(() => h.events.some((e) => e.type === 'turn_completed'))
    // A: read by the CLI, interrupted before its init; the plain interrupt's receipt cancels it.
    h.driver.send('cancel me')
    await until(() => h.scripts[0]!.prompts.length === 2)
    h.scripts[0]!.answers.push({ cancelled: [String(h.scripts[0]!.prompts[1]!.uuid)] })
    await h.driver.interrupt()
    await until(() => h.scripts[0]!.interrupts.length === 1)
    await settle()
    // A never ran, so it owes no result: C's init and frames are C's own.
    h.driver.send('fresh')
    await until(() => h.scripts[0]!.prompts.length === 3)
    const c = String(h.scripts[0]!.prompts[2]!.uuid)
    const turnC = (h.events.filter((e) => e.type === 'turn_started').at(-1) as { turnId: string }).turnId
    h.scripts[0]!.push(initFrame(['interrupt_receipt_v1']))
    h.scripts[0]!.push({ type: 'assistant', message: { id: 'msg_c', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'answer for C' }] } })
    h.scripts[0]!.push(done(c, 5))
    await until(() => h.events.filter((e) => e.type === 'turn_completed').length === 2)
    const texts = h.events.flatMap((e) => (e.type === 'assistant_text' ? [[(e as { turnId?: string }).turnId, (e as { text?: string }).text]] : []))
    expect(texts.filter(([turnId]) => turnId === turnC).length > 0).toBe(true)
    expect(h.scripts[0]!.interrupts).toEqual([undefined])
    expect(violations()).toEqual([UNSUPPORTED])
  })

  test('kill after an unsupported init sends no interrupt and logs nothing', async () => {
    const h = compatibilityAdapter()
    await busy(h, ['interrupt_receipt_v1'])
    const outcome = await h.finish()
    expect(outcome).toEqual({ resolved: true, closed: true })
    expect(h.scripts[0]!.interrupts).toEqual([])
    expect(violations()).toEqual([])
  })

  test('a plain interrupt\'s raw failure reaches settled() once as the original object', async () => {
    const h = compatibilityAdapter()
    await busy(h, ['interrupt_receipt_v1'])
    const boom = new Error('plain interrupt refused')
    h.scripts[0]!.answers.push(boom)
    await h.driver.interrupt()
    await until(() => h.scripts[0]!.interrupts.length === 1)
    await settle()
    // Exactly that one raw cause, as the original object: no extra cause.
    const outcome = await h.failed([boom])
    expect(outcome.closed).toBe(true)
    expect(h.scripts[0]!.interrupts).toEqual([undefined])
    expect(violations()).toEqual([UNSUPPORTED])
    // Reported once: a later join reports nothing again.
    await expect(h.driver.settled()).resolves.toBeUndefined()
  })
})

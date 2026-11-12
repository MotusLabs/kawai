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
import { CAPS, busy, causes, compatibilityAdapter, finishAll, initFrame, settle, until } from './helpers/claudeCompatibilityHarness'

let warn: Mock<typeof logger.warn>
const violations = () => warn.mock.calls.filter(([name]) => name === 'claude_cli_contract_violation').map(([, data]) => (data as { reason?: string }).reason)
beforeEach(() => {
  warn = spyOn(logger, 'warn')
})
afterEach(async () => {
  await finishAll()
  warn.mockRestore()
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
    const outcome = await h.finish()
    expect([outcome.resolved, outcome.closed, causes(outcome.error).filter((cause) => cause === boom).length]).toEqual([false, true, 1])
    expect(h.scripts[0]!.interrupts).toEqual([undefined])
    expect(violations()).toEqual([UNSUPPORTED])
    // Reported once: a later join reports nothing again.
    await expect(h.driver.settled()).resolves.toBeUndefined()
  })
})

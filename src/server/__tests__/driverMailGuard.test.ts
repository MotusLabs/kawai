// The driver-event mail guard's contract: a failure never escapes, every
// failure is logged under its own event, the settle is retried a bounded
// number of times on the injected schedule, a failing attempt joins the
// session's live chain and every settle in it is retried, and after the
// last failure the mail is left to mailbox recovery (one error log, no
// further scheduling). The default timer path is covered by the
// real-timeout tests at the end.
import { describe, expect, test } from 'bun:test'
import { DriverMailGuard, SETTLE_RETRIES, SETTLE_RETRY_DELAY_MS } from '../chat/driverMailGuard'

type LogFields = Record<string, unknown>

interface Harness {
  guard: DriverMailGuard
  /** Scheduled runs, oldest first; a test drains them by hand. */
  runs: Array<() => void>
  cancelled: Array<() => void>
  /** Log lines: `[event, fields]` in order. */
  logs: Array<[string, LogFields]>
  errors: Array<[string, LogFields]>
}

function harness(): Harness {
  const runs: Array<() => void> = []
  const cancelled: Array<() => void> = []
  const logs: Array<[string, LogFields]> = []
  const errors: Array<[string, LogFields]> = []
  const guard = new DriverMailGuard({
    log: (event, fields) => logs.push([event, fields]),
    logError: (event, fields) => errors.push([event, fields]),
    schedule: run => {
      runs.push(run)
      return () => { cancelled.push(run) }
    },
  })
  return { guard, runs, cancelled, logs, errors }
}

const boom = () => {
  throw new Error('database is locked')
}

describe('guard and guardResult', () => {
  test('a throwing step neither escapes nor goes unlogged', () => {
    const h = harness()
    expect(() => h.guard.guard('chat_mail_tool_call_failed', boom, { sessionId: 's1' })).not.toThrow()
    expect(h.logs).toEqual([['chat_mail_tool_call_failed', { sessionId: 's1', error: 'database is locked' }]])
  })

  test('a passing step logs nothing', () => {
    const h = harness()
    let ran = false
    h.guard.guard('evt', () => { ran = true })
    expect(ran).toBe(true)
    expect(h.logs).toEqual([])
  })

  test('guardResult returns the step value, or the fallback on a throw', () => {
    const h = harness()
    expect(h.guard.guardResult('ok', 'evt', () => 'ok')).toBe('ok')
    expect(h.guard.guardResult(false, 'evt', () => {
      throw new Error('busy')
    })).toBe(false)
    expect(h.logs).toEqual([['evt', { error: 'busy' }]])
  })
})

describe('settleRecipient retries', () => {
  test('a passing settle schedules nothing', () => {
    const h = harness()
    let settles = 0
    h.guard.settleRecipient('s1', () => { settles += 1 })
    expect(settles).toBe(1)
    expect(h.runs).toEqual([])
    expect(h.logs).toEqual([])
  })

  test('a failing settle is retried until it succeeds, each failure logged', () => {
    const h = harness()
    let attempts = 0
    const flaky = () => {
      attempts += 1
      if (attempts === 1) throw new Error('database is locked')
    }
    h.guard.settleRecipient('s1', flaky)
    expect(attempts).toBe(1)
    expect(h.logs).toEqual([['chat_mail_settle_failed', { sessionId: 's1', error: 'database is locked' }]])

    expect(h.runs).toHaveLength(1)
    h.runs.shift()!()
    expect(attempts).toBe(2)
    expect(h.runs).toHaveLength(0) // success: no further scheduling
    expect(h.errors).toEqual([])
  })

  test('the retries stay bounded; exhaustion is an error and stops scheduling', () => {
    const h = harness()
    let attempts = 0
    h.guard.settleRecipient('s1', () => {
      attempts += 1
      throw new Error('database is locked')
    })
    expect(attempts).toBe(1)
    for (let i = 0; i < SETTLE_RETRIES; i++) {
      expect(h.runs).toHaveLength(1)
      h.runs.shift()!()
    }
    // The synchronous attempt plus SETTLE_RETRIES timer runs, then no more.
    expect(attempts).toBe(1 + SETTLE_RETRIES)
    expect(h.runs).toHaveLength(0) // the exhausted chain armed nothing
    expect(h.errors).toEqual([['chat_mail_settle_exhausted', { sessionId: 's1', retries: SETTLE_RETRIES, unsettled: 1 }]])
    expect(h.logs.map(([event]) => event)).toEqual([
      'chat_mail_settle_failed',
      ...Array.from({ length: SETTLE_RETRIES }, () => 'chat_mail_settle_retry_failed'),
    ])
  })

  test('a failure while a chain is pending joins the chain and both settles are retried', () => {
    const h = harness()
    let first = 0
    let second = 0
    h.guard.settleRecipient('s1', () => {
      first += 1
      throw new Error('database is locked')
    })
    expect(h.runs).toHaveLength(1)
    // A second turn end fails too, before the first retry fires: its settle
    // joins the pending chain — its claims were captured after the first
    // attempt's snapshot, so dropping it would strand them.
    h.guard.settleRecipient('s1', () => {
      second += 1
      throw new Error('database is locked')
    })
    expect(h.runs).toHaveLength(1) // still one chain, no second timer
    h.runs.shift()!()
    // Each settle ran its inline attempt plus the chain's retry.
    expect(first).toBe(2)
    expect(second).toBe(2)
    // The failed pair re-arms as one chain for the next round.
    expect(h.runs).toHaveLength(1)
    expect(h.logs.map(([event]) => event)).toEqual([
      'chat_mail_settle_failed',
      'chat_mail_settle_failed',
      'chat_mail_settle_retry_failed',
      'chat_mail_settle_retry_failed',
    ])
  })

  test('a settle joining mid-chain inherits the remaining bound, never extends it', () => {
    const h = harness()
    const boomSettle = () => {
      throw new Error('database is locked')
    }
    h.guard.settleRecipient('s1', boomSettle)
    h.runs.shift()!() // round 1 (remaining 3 → 2)
    // A third attempt joins the re-armed chain: it gets the rounds the
    // chain has left, not a fresh bound.
    h.guard.settleRecipient('s1', boomSettle)
    expect(h.runs).toHaveLength(1)
    h.runs.shift()!() // round 2 (remaining 2 → 1): both run and fail
    h.runs.shift()!() // round 3 (remaining 1): exhausts
    expect(h.runs).toHaveLength(0)
    // The joiner ran only the rounds its chain had left; the exhaustion is
    // one error naming both unsettled settles.
    expect(h.errors).toEqual([
      ['chat_mail_settle_exhausted', { sessionId: 's1', retries: SETTLE_RETRIES, unsettled: 2 }],
    ])
  })

  test('sessions retry independently', () => {
    const h = harness()
    h.guard.settleRecipient('s1', boom)
    h.guard.settleRecipient('s2', boom)
    expect(h.runs).toHaveLength(2)
    expect(h.logs.map(([, fields]) => fields.sessionId)).toEqual(['s1', 's2'])
  })

  test('close cancels the pending retry via the schedule cancel', () => {
    const h = harness()
    h.guard.settleRecipient('s1', boom)
    h.guard.close()
    expect(h.cancelled).toHaveLength(1)
    expect(h.runs).toHaveLength(1) // captured, but the guard cancelled it
  })

  test('a settle after close runs nothing and arms no timer', () => {
    const h = harness()
    h.guard.close()
    let settles = 0
    h.guard.settleRecipient('s1', () => { settles += 1 })
    h.guard.settleRecipient('s1', boom)
    expect(settles).toBe(0)
    expect(h.runs).toHaveLength(0)
    expect(h.logs).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('the default timer path', () => {
  test('a real retry fires about a second later and stops on success', async () => {
    const logs: Array<[string, LogFields]> = []
    const guard = new DriverMailGuard({
      log: (event, fields) => logs.push([event, fields]),
      logError: (event, fields) => logs.push([`error:${event}`, fields]),
    })
    let attempts = 0
    guard.settleRecipient('s1', () => {
      attempts += 1
      if (attempts === 1) throw new Error('database is locked')
    })
    expect(attempts).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 1400))
    expect(attempts).toBe(2)
    expect(logs.map(([event]) => event)).toEqual(['chat_mail_settle_failed'])
    guard.close()
  })

  test('close cancels a real scheduled retry outright', async () => {
    let attempts = 0
    const guard = new DriverMailGuard()
    guard.settleRecipient('s1', () => {
      attempts += 1
      // The synchronous attempt runs (and fails); a second attempt would be
      // the cancelled timer firing.
      throw attempts === 1 ? new Error('database is locked') : new Error('must not run after close')
    })
    expect(attempts).toBe(1)
    guard.close()
    await new Promise(resolve => setTimeout(resolve, 1300))
    expect(attempts).toBe(1)
  })

  test('defaults are the documented bound (3 retries, 1 s apart)', () => {
    expect(SETTLE_RETRIES).toBe(3)
    expect(SETTLE_RETRY_DELAY_MS).toBe(1000)
  })
})

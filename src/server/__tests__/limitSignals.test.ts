import { describe, expect, test } from 'bun:test'
import { assistantLimitSignal, rejectedResetsAt, retryLimitSignal } from '../chat/limitSignals'

describe('limit signals', () => {
  test('retries count for limit classes or status 429', () => {
    expect(retryLimitSignal({ error: 'overloaded', error_status: 529 }, null)).toMatchObject({ kind: 'overloaded', final: false, status: 529 })
    expect(retryLimitSignal({ error: 'unknown', error_status: 429 }, 'r')).toMatchObject({ kind: 'unknown', status: 429, resetsAt: 'r' })
    expect(retryLimitSignal({ error: 'billing_error' }, null)).toMatchObject({ kind: 'billing_error', status: null })
    expect(retryLimitSignal({ error: 'server_error', error_status: 500 }, null)).toBeNull()
    expect(retryLimitSignal({}, null)).toBeNull()
  })

  test('failed assistant messages read the status from the error text', () => {
    expect(assistantLimitSignal('billing_error', 'API Error: 402 pay up', null))
      .toEqual({ kind: 'billing_error', final: true, status: 402, message: 'API Error: 402 pay up', resetsAt: null })
    expect(assistantLimitSignal('rate_limit', '  ', null)).toMatchObject({ status: null, message: null })
    expect(assistantLimitSignal('invalid_request', 'API Error: 429 x', null)).toMatchObject({ status: 429 })
    expect(assistantLimitSignal('invalid_request', 'API Error: 400 x', null)).toBeNull()
    expect(assistantLimitSignal(undefined, 'API Error: 429', null)).toBeNull()
  })

  test('only a rejected rate_limit_event with a time announces a reset', () => {
    expect(rejectedResetsAt({ status: 'rejected', resetsAt: 1_800_000_000 })).toBe(new Date(1_800_000_000_000).toISOString())
    expect(rejectedResetsAt({ status: 'allowed', resetsAt: 1_800_000_000 })).toBeNull()
    expect(rejectedResetsAt({ status: 'rejected', resetsAt: null })).toBeNull()
    expect(rejectedResetsAt({ status: 'rejected', resetsAt: Number.NaN })).toBeNull()
    expect(rejectedResetsAt(undefined)).toBeNull()
  })
})

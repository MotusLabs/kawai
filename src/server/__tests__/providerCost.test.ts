// The message_delta cost extractor (openrouter-provider D9): only a finite,
// non-negative number under a message_delta's usage object is a cost.
import { describe, expect, test } from 'bun:test'
import { messageDeltaCost } from '../chat/providerCost'

describe('messageDeltaCost', () => {
  test('a message_delta usage cost is returned as a number', () => {
    expect(messageDeltaCost({ type: 'message_delta', usage: { cost: 0.001064075 } })).toBe(0.001064075)
    expect(messageDeltaCost({ type: 'message_delta', usage: { output_tokens: 5, cost: 0 } })).toBe(0)
  })

  test('non-message_delta events are not costs', () => {
    expect(messageDeltaCost({ type: 'message_start', usage: { cost: 1 } })).toBeNull()
    expect(messageDeltaCost({ type: 'content_block_delta' })).toBeNull()
    expect(messageDeltaCost({})).toBeNull()
    expect(messageDeltaCost(null)).toBeNull()
    expect(messageDeltaCost('message_delta')).toBeNull()
  })

  test('a message_delta without a usage object is not a cost', () => {
    expect(messageDeltaCost({ type: 'message_delta' })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: null })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: 'cost: 1' })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: [] })).toBeNull()
  })

  test('only a finite, non-negative number under usage.cost counts', () => {
    expect(messageDeltaCost({ type: 'message_delta', usage: { cost: '0.01' } })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: { cost: Number.NaN } })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: { cost: Number.POSITIVE_INFINITY } })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: { cost: -0.01 } })).toBeNull()
    expect(messageDeltaCost({ type: 'message_delta', usage: {} })).toBeNull()
  })
})

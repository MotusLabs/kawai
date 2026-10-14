// Strategy content hashing (product-strategy design D2, review N3): the
// server-side SHA-256 over the shared canonical serialization — stable
// across key order, different across content, semantic about list order.
import { describe, expect, test } from 'bun:test'
import { normalizeStrategyContent } from '../../shared/productStrategy'
import { hashStrategyContent } from '../strategy/strategyHash'

const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  purpose: 'Supervised autonomous development',
  primaryUsers: 'Small platform teams',
  claims: [{ text: 'a claim', kind: 'owner_preference' }],
  ...overrides,
})

describe('hashStrategyContent', () => {
  test('stable across key order, different across content', () => {
    const a = normalizeStrategyContent(content())
    const reordered = normalizeStrategyContent({
      claims: content().claims,
      purpose: 'Supervised autonomous development',
      primaryUsers: 'Small platform teams',
    })
    expect(hashStrategyContent(a)).toBe(hashStrategyContent(reordered))
    const changed = normalizeStrategyContent(content({ purpose: 'A different purpose' }))
    expect(hashStrategyContent(a)).not.toBe(hashStrategyContent(changed))
  })

  test('list order is semantic: reordering changes the hash', () => {
    const a = normalizeStrategyContent({ boundaries: ['one', 'two'] })
    const b = normalizeStrategyContent({ boundaries: ['two', 'one'] })
    expect(hashStrategyContent(a)).not.toBe(hashStrategyContent(b))
  })

  test('produces a 64-char hex digest', () => {
    expect(hashStrategyContent(normalizeStrategyContent({}))).toMatch(/^[0-9a-f]{64}$/)
  })
})

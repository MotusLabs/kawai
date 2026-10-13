// Product strategy shared types (product-strategy 1.1): the template fills
// every section, content round-trips through the canonical shape, the hash
// is stable across key order but not across content, Unknown passes through
// for missing baselines/targets, and a validated observation without a
// source is named as an error.
import { describe, expect, test } from 'bun:test'
import {
  UNKNOWN,
  canonicalJson,
  normalizeStrategyContent,
  strategyContentErrors,
  type StrategyContent,
} from '../productStrategy'

const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  purpose: 'Supervised autonomous development',
  primaryUsers: 'Small platform teams',
  needsOutcomes: 'Ship without babysitting agents',
  productApproach: 'One operator directing a team of agents',
  useCases: [{
    userOrSituation: 'A lead reviewing a feature branch',
    trigger: 'A task is assigned',
    wantedOutcome: 'The change lands reviewed',
    currentObstacle: 'Manual review queue',
    desiredExperience: 'Agents draft, lead approves',
    successSignal: 'Review latency drops',
    constraints: 'No force-push to master',
  }],
  principles: [{ principle: 'Human decisions are runtime records', tradeoff: 'Slower than auto-approve' }],
  boundaries: ['No cross-repository scopes'],
  successMeasures: [
    { outcome: 'Direction stability', measure: 'Strategy revisions per month', baseline: UNKNOWN, target: UNKNOWN },
    { outcome: 'Review throughput', measure: 'Landed tasks per week', baseline: '3', target: '6' },
  ],
  claims: [
    { text: 'Leads want explicit approval gates', kind: 'owner_preference' },
    { text: 'Demand grows 20% monthly', kind: 'hypothesis', limitations: 'No data yet' },
    { text: '42% of sessions end archived', kind: 'validated_observation', source: 'agentboard.db counts 2026-10-01' },
  ],
  openQuestions: ['Who owns strategy for multi-team repos?'],
  decisions: [{ decision: 'SQLite over files', date: '2026-10-13', rationale: 'S09 enforceability' }],
  ...overrides,
})

describe('normalizeStrategyContent', () => {
  test('fills the full template: every section present, lists with stable refs', () => {
    const normalized = normalizeStrategyContent(content())
    expect(normalized.purpose).toBe('Supervised autonomous development')
    expect(normalized.useCases[0]).toMatchObject({ ref: 'uc1', successSignal: 'Review latency drops' })
    expect(normalized.principles[0]).toMatchObject({ ref: 'pr1', tradeoff: 'Slower than auto-approve' })
    expect(normalized.successMeasures.map(measure => measure.ref)).toEqual(['m1', 'm2'])
    expect(normalized.claims.map(claim => claim.ref)).toEqual(['c1', 'c2', 'c3'])
    expect(normalized.decisions[0]).toMatchObject({ ref: 'd1', date: '2026-10-13' })
    expect(Object.keys(normalized).sort()).toEqual([
      'boundaries', 'claims', 'decisions', 'needsOutcomes', 'openQuestions', 'primaryUsers',
      'principles', 'productApproach', 'purpose', 'successMeasures', 'useCases',
    ])
  })

  test('an empty input records every section as explicitly empty', () => {
    const normalized = normalizeStrategyContent(undefined)
    expect(normalized.purpose).toBe('')
    expect(normalized.useCases).toEqual([])
    expect(normalized.openQuestions).toEqual([])
  })

  test('round-trips: normalizing the normalized object is the identity', () => {
    const once = normalizeStrategyContent(content())
    expect(normalizeStrategyContent(once)).toEqual(once)
  })

  test('missing baselines and targets become Unknown; known values pass through', () => {
    const normalized = normalizeStrategyContent({
      successMeasures: [
        { outcome: 'A', measure: 'count' },
        { outcome: 'B', measure: 'count', baseline: 7, target: '12/day' },
      ],
    })
    expect(normalized.successMeasures[0]).toMatchObject({ baseline: UNKNOWN, target: UNKNOWN })
    // A number is not kept as an invented metric: it reads as Unknown.
    expect(normalized.successMeasures[1]).toMatchObject({ baseline: UNKNOWN, target: '12/day' })
  })

  test('an unknown claim kind falls back to hypothesis; junk fields are dropped', () => {
    const normalized = normalizeStrategyContent({ claims: [{ text: 'X', kind: 'market_fact', forged: 'yes' }] })
    expect(normalized.claims[0]).toEqual({ ref: 'c1', text: 'X', kind: 'hypothesis' })
  })
})

describe('canonical serialization', () => {
  test('stable across key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  test('the Unknown sentinel is preserved as itself', () => {
    expect(canonicalJson(UNKNOWN)).toBe('"Unknown"')
    const withUnknown = normalizeStrategyContent({ successMeasures: [{ outcome: 'A', measure: 'm' }] })
    expect(canonicalJson(withUnknown.successMeasures)).toContain('"baseline":"Unknown"')
  })

  test('list order is semantic: reordering changes the serialization', () => {
    const a = normalizeStrategyContent({ boundaries: ['one', 'two'] })
    const b = normalizeStrategyContent({ boundaries: ['two', 'one'] })
    expect(canonicalJson(a)).not.toBe(canonicalJson(b))
  })
})

describe('strategyContentErrors', () => {
  test('a validated observation without a source is refused naming the claim', () => {
    const normalized = normalizeStrategyContent({
      claims: [{ text: 'Everyone wants this', kind: 'validated_observation' }],
    })
    expect(strategyContentErrors(normalized)).toEqual([
      'Claim c1 is a validated observation but names no source; add its source reference or label it a hypothesis.',
    ])
  })

  test('every other claim kind needs no source; a sourced observation passes', () => {
    expect(strategyContentErrors(normalizeStrategyContent(content()))).toEqual([])
    expect(strategyContentErrors(normalizeStrategyContent({
      claims: [
        { text: 'a', kind: 'owner_preference' }, { text: 'b', kind: 'explicit_user_statement' },
        { text: 'c', kind: 'agent_interpretation' }, { text: 'd', kind: 'proposed_choice' },
        { text: 'e', kind: 'hypothesis' },
      ],
    }))).toEqual([])
  })
})

describe('StrategyContent type round-trip', () => {
  test('a revision content object survives JSON serialization', () => {
    const original: StrategyContent = normalizeStrategyContent(content())
    const parsed = normalizeStrategyContent(JSON.parse(JSON.stringify(original)))
    expect(parsed).toEqual(original)
    expect(canonicalJson(parsed)).toBe(canonicalJson(original))
  })
})

import { describe, expect, test } from 'bun:test'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS, type GroupLimitPolicy } from '../team/groupFile'
import { MAX_PARKS, resolveLimit } from '../team/routing/limitPolicy'

const DEFAULTS: GroupLimitPolicy = { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' }
const MIN = 60_000

describe('resolveLimit', () => {
  test('close reset with progress parks', () => {
    expect(resolveLimit({ toolCalls: 2, resetInMs: 40 * MIN, parkCount: 0, policy: DEFAULTS })).toEqual({ type: 'park' })
  })

  test('far reset with progress forwards to the same group', () => {
    expect(resolveLimit({ toolCalls: 2, resetInMs: 300 * MIN, parkCount: 0, policy: DEFAULTS })).toEqual({ type: 'forward', to: null })
  })

  test('no progress releases', () => {
    expect(resolveLimit({ toolCalls: 0, resetInMs: 1 * MIN, parkCount: 0, policy: DEFAULTS })).toEqual({ type: 'release' })
  })

  test('frontmatter: otherwise release, and a shorter park window', () => {
    const policy: GroupLimitPolicy = { parkIfResetWithinMs: 60 * MIN, otherwise: 'release' }
    expect(resolveLimit({ toolCalls: 2, resetInMs: 120 * MIN, parkCount: 0, policy })).toEqual({ type: 'release' })
    expect(resolveLimit({ toolCalls: 2, resetInMs: 59 * MIN, parkCount: 0, policy })).toEqual({ type: 'park' })
  })

  test('the rule decides when it answers; default defers to the frontmatter', () => {
    const base = { toolCalls: 0, resetInMs: 300 * MIN, parkCount: 0, policy: DEFAULTS }
    expect(resolveLimit({ ...base, ruled: { type: 'park' } })).toEqual({ type: 'park' })
    expect(resolveLimit({ ...base, ruled: { type: 'forward', to: { kind: 'group', id: 'architects' } } }))
      .toEqual({ type: 'forward', to: { kind: 'group', id: 'architects' } })
    expect(resolveLimit({ ...base, ruled: { type: 'default' } })).toEqual({ type: 'release' })
  })

  test(`after ${MAX_PARKS} parks the message is released, whatever the rule says`, () => {
    expect(resolveLimit({ toolCalls: 5, resetInMs: MIN, parkCount: MAX_PARKS, policy: DEFAULTS, ruled: { type: 'park' } }))
      .toEqual({ type: 'release' })
  })
})

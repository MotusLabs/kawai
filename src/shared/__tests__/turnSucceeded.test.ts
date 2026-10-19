import { describe, expect, test } from 'bun:test'
import { turnSucceeded } from '../chat'

/** chat-context-exhaustion D1: the one success predicate for completed turns. */
describe('turnSucceeded', () => {
  test('a success subtype without is_error succeeds', () => {
    expect(turnSucceeded({ subtype: 'success', isError: false })).toBe(true)
  })

  test('is_error under a success subtype fails (the context overflow shape)', () => {
    expect(turnSucceeded({ subtype: 'success', isError: true })).toBe(false)
  })

  test('a non-success subtype fails whatever is_error says', () => {
    expect(turnSucceeded({ subtype: 'error_during_execution' })).toBe(false)
    expect(turnSucceeded({ subtype: 'error_max_turns', isError: false })).toBe(false)
  })

  test('old events without the field read by their subtype alone', () => {
    expect(turnSucceeded({ subtype: 'success' })).toBe(true)
    expect(turnSucceeded({ subtype: 'error_during_execution' })).toBe(false)
  })
})

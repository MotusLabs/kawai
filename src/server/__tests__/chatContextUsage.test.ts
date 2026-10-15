// Context-meter state (context meter designs D1–D3, D7): the pure tracker's
// reading lifecycle — first request, compaction drops, the three threshold
// sources and their approximation labels, conversation resets, and the
// reserve that must not outlive a report that no longer carries one.
import { describe, expect, test } from 'bun:test'
import {
  ChatContextTracker,
  EMPTY_REQUEST_USAGE,
  mergeRequestUsage,
  parsePositiveTokens,
  sumRequestUsage,
} from '../chat/contextUsage'

const AT = '2026-10-10T12:00:00.000Z'

describe('sumRequestUsage', () => {
  test('sums the four per-request fields, ignoring junk', () => {
    expect(
      sumRequestUsage({
        input_tokens: 10_000,
        cache_read_input_tokens: 45_000,
        cache_creation_input_tokens: 4_000,
        output_tokens: 1_000,
      })
    ).toBe(60_000)
    expect(
      sumRequestUsage({
        input_tokens: Number.NaN,
        cache_read_input_tokens: -5,
        cache_creation_input_tokens: undefined,
        output_tokens: 2_000,
      })
    ).toBe(2_000)
    expect(sumRequestUsage({})).toBe(0)
  })
})

describe('parsePositiveTokens', () => {
  test('reads a positive token count from an env string', () => {
    expect(parsePositiveTokens('100000')).toBe(100_000)
    expect(parsePositiveTokens(undefined)).toBeNull()
    expect(parsePositiveTokens('')).toBeNull()
    expect(parsePositiveTokens('0')).toBeNull()
    expect(parsePositiveTokens('nope')).toBeNull()
  })
})

describe('ChatContextTracker', () => {
  test('no reading exists before the first request (D7)', () => {
    const tracker = new ChatContextTracker()
    expect(tracker.noteModelWindow(200_000).kind).toBe('none')
    expect(
      tracker.applyReport({ autoCompactThreshold: 167_000 }).kind
    ).toBe('none')
    expect(tracker.currentReading()).toBeNull()
  })

  test('the reading is the latest request, not a sum', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(200_000)
    const first = tracker.readRequest(60_000, AT)
    expect(first).toMatchObject({ kind: 'reading', persist: false })
    if (first.kind !== 'reading') throw new Error('expected a reading')
    expect(first.usage.usedTokens).toBe(60_000)

    const second = tracker.readRequest(120_000, AT)
    if (second.kind !== 'reading') throw new Error('expected a reading')
    expect(second.usage.usedTokens).toBe(120_000)
    expect(tracker.currentReading()?.usedTokens).toBe(120_000)
  })

  test('identical re-publications are suppressed', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(200_000)
    tracker.readRequest(60_000, AT)
    expect(tracker.readRequest(60_000, AT).kind).toBe('none')
  })

  test('compaction adopts post_tokens and drops the meter', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(200_000)
    tracker.readRequest(157_900, AT)
    const step = tracker.compact(8_200, AT)
    if (step.kind !== 'reading') throw new Error('expected a reading')
    expect(step.usage.usedTokens).toBe(8_200)
    // The boundary's write is the manager's (keyed on the compacted notice);
    // the tracker only moves the meter.
    expect(step.persist).toBe(false)
  })

  test('compaction without a usable post_tokens keeps the last reading', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(200_000)
    tracker.readRequest(157_900, AT)
    expect(tracker.compact(null, AT).kind).toBe('none')
    expect(tracker.compact(0, AT).kind).toBe('none')
    expect(tracker.compact(Number.NaN, AT).kind).toBe('none')
    expect(tracker.currentReading()?.usedTokens).toBe(157_900)
  })

  test('a conversation reset clears the reading, not just the used count', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(200_000)
    tracker.readRequest(157_900, AT)
    expect(tracker.resetConversation()).toEqual({ kind: 'clear' })
    expect(tracker.currentReading()).toBeNull()
    // Nothing measured again: a second reset is a no-op.
    expect(tracker.resetConversation().kind).toBe('none')
  })

  test('the report threshold wins and is never approximate', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(100_000)
    tracker.readRequest(60_000, AT)
    const step = tracker.applyReport({ autoCompactThreshold: 167_000 })
    if (step.kind !== 'reading') throw new Error('expected a reading')
    expect(step.persist).toBe(true)
    expect(step.usage).toMatchObject({
      usedTokens: 60_000,
      thresholdTokens: 167_000,
    })
    expect(step.usage.thresholdApproximate).toBeUndefined()
  })

  test('the pinned real-report fixture: 200k window, 33k buffer, 157.9k used', () => {
    // Task 4.2's shape, with autoCompactThreshold carrying the same 167000
    // the CLI reports: the preferred field is the threshold in tokens, not a
    // percentage or the full window.
    const tracker = new ChatContextTracker()
    tracker.applyReport({
      autoCompactThreshold: 167_000,
      rawMaxTokens: 200_000,
      categories: [{ kind: 'buffer', tokens: 33_000 }],
    })
    tracker.readRequest(157_900, AT)
    expect(tracker.currentReading()).toMatchObject({
      usedTokens: 157_900,
      thresholdTokens: 167_000,
      percentage: 94.6,
    })
  })

  test('without autoCompactThreshold the threshold is the window minus the buffer', () => {
    const tracker = new ChatContextTracker()
    tracker.applyReport({
      rawMaxTokens: 200_000,
      categories: [
        { kind: 'used', tokens: 120_000 },
        { kind: 'buffer', tokens: 33_000 },
      ],
    })
    tracker.readRequest(157_900, AT)
    const reading = tracker.currentReading()
    expect(reading).toMatchObject({
      thresholdTokens: 167_000,
      percentage: 94.6,
    })
    // raw − buffer is a derived threshold, not a stand-in.
    expect(reading?.thresholdApproximate).toBeUndefined()
  })

  test('rawMaxTokens with no reserve is a window, and is labelled approximate', () => {
    const tracker = new ChatContextTracker()
    tracker.applyReport({ rawMaxTokens: 200_000, categories: [] })
    tracker.readRequest(157_900, AT)
    expect(tracker.currentReading()).toMatchObject({
      thresholdTokens: 200_000,
      thresholdApproximate: true,
    })
  })

  test('a profile window is exact only once a reserve has been observed', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(100_000)
    tracker.readRequest(50_000, AT)
    expect(tracker.currentReading()).toMatchObject({
      thresholdTokens: 100_000,
      thresholdApproximate: true,
    })

    tracker.applyReport({
      rawMaxTokens: 0,
      categories: [{ kind: 'buffer', tokens: 20_000 }],
    })
    expect(tracker.currentReading()).toMatchObject({
      thresholdTokens: 80_000,
    })
    expect(tracker.currentReading()?.thresholdApproximate).toBeUndefined()
  })

  test('a larger profile override stands above the model window', () => {
    const tracker = new ChatContextTracker()
    tracker.noteModelWindow(200_000)
    tracker.setProfileWindow(1_000_000)
    tracker.readRequest(150_000, AT)
    expect(tracker.currentReading()).toMatchObject({
      thresholdTokens: 1_000_000,
      percentage: 15,
      thresholdApproximate: true,
    })
  })

  test('the model window is the last resort and always approximate', () => {
    const tracker = new ChatContextTracker()
    tracker.noteModelWindow(200_000)
    tracker.readRequest(157_900, AT)
    expect(tracker.currentReading()).toMatchObject({
      thresholdTokens: 200_000,
      percentage: 79,
      thresholdApproximate: true,
    })
  })

  test('a report that no longer carries a buffer clears the reserve', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(100_000)
    tracker.applyReport({
      rawMaxTokens: 0,
      categories: [{ kind: 'buffer', tokens: 20_000 }],
    })
    expect(tracker.currentReading()).toBeNull()

    tracker.readRequest(50_000, AT)
    expect(tracker.currentReading()?.thresholdTokens).toBe(80_000)

    // Auto-compact off: the same report shape minus the buffer row. The old
    // 20k reserve must not keep shrinking the denominator.
    tracker.applyReport({ rawMaxTokens: 0, categories: [{ kind: 'used', tokens: 50_000 }] })
    expect(tracker.currentReading()).toMatchObject({
      thresholdTokens: 100_000,
      thresholdApproximate: true,
    })
  })

  test('a report with no categories at all leaves the reserve alone', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(100_000)
    tracker.applyReport({
      rawMaxTokens: 0,
      categories: [{ kind: 'buffer', tokens: 20_000 }],
    })
    tracker.readRequest(50_000, AT)
    // A summary that simply did not enumerate categories is not evidence the
    // reserve is gone.
    tracker.applyReport({ autoCompactThreshold: undefined, categories: [] })
    expect(tracker.currentReading()?.thresholdTokens).toBe(80_000)
  })

  test('a spawn re-read drops the dead process report and re-anchors at once', () => {
    const tracker = new ChatContextTracker()
    tracker.applyReport({ autoCompactThreshold: 167_000 })
    tracker.readRequest(157_900, AT)
    expect(tracker.currentReading()?.thresholdTokens).toBe(167_000)

    const step = tracker.setProfileWindow(100_000)
    if (step.kind !== 'reading') throw new Error('expected a re-anchor')
    expect(step.persist).toBe(true)
    expect(step.usage).toMatchObject({
      usedTokens: 157_900,
      thresholdTokens: 100_000,
      percentage: 157.9,
      thresholdApproximate: true,
    })
  })

  test('percentages are not clamped to 100', () => {
    const tracker = new ChatContextTracker()
    tracker.setProfileWindow(100_000)
    tracker.readRequest(120_000, AT)
    expect(tracker.currentReading()?.percentage).toBe(120)
  })
})

describe('mergeRequestUsage', () => {
  const merge = (...sources: object[]) =>
    sumRequestUsage(sources.reduce<ReturnType<typeof mergeRequestUsage>>(mergeRequestUsage, EMPTY_REQUEST_USAGE))

  test('GLM: a zero start then a complete delta gives the delta sum', () => {
    expect(
      merge(
        { input_tokens: 0, output_tokens: 0 },
        { input_tokens: 46_500, output_tokens: 118, cache_read_input_tokens: 0 }
      )
    ).toBe(46_618)
  })

  test('Anthropic: an output-only delta keeps the start input and cache counts', () => {
    expect(
      merge(
        { input_tokens: 2, cache_creation_input_tokens: 22_456, cache_read_input_tokens: 12_059, output_tokens: 8 },
        { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 300 }
      )
    ).toBe(2 + 22_456 + 12_059 + 300)
  })

  test('MiMo: a start then a complete delta', () => {
    expect(
      merge(
        { input_tokens: 3_358, output_tokens: 0, cache_read_input_tokens: 131_072 },
        { input_tokens: 3_358, output_tokens: 329, cache_read_input_tokens: 131_072 }
      )
    ).toBe(3_358 + 131_072 + 329)
  })

  test('a start re-sent after the delta does not lower the sum', () => {
    const afterDelta = mergeRequestUsage(EMPTY_REQUEST_USAGE, { input_tokens: 46_500, output_tokens: 118 })
    const again = mergeRequestUsage(afterDelta, { input_tokens: 0, output_tokens: 0 })
    expect(again).toEqual(afterDelta)
  })

  test('ignores absent, null, NaN, and negative fields', () => {
    expect(
      merge({ input_tokens: Number.NaN, output_tokens: -4, cache_read_input_tokens: null })
    ).toBe(0)
  })
})

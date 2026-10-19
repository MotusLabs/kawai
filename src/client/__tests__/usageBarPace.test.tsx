// Usage bar elapsed-time marker (usage-bar-time-pace): the pure elapsed-share
// and time-left helpers, the tick on each meter's track, the hover and
// accessible text, and the minute clock that moves the tick between reports.
import { afterEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatUsageReport, ChatUsageWindow } from '@shared/chat'
import UsageBar, {
  formatUsageTimeLeft,
  usageElapsedShare,
} from '../components/chat/UsageBar'

const NOW = Date.parse('2026-10-07T13:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const FIVE_HOURS = 5 * HOUR
const SEVEN_DAYS = 7 * 24 * HOUR
const at = (ms: number) => new Date(ms).toISOString()

const fiveHour = (overrides: Partial<ChatUsageWindow> = {}): ChatUsageWindow => ({
  key: 'five_hour',
  label: '5-hour window',
  percentUsed: 22,
  resetsAt: at(NOW + 2.5 * HOUR),
  periodMs: FIVE_HOURS,
  ...overrides,
})

const report = (windows: ChatUsageWindow[]): ChatUsageReport => ({
  status: 'allowed',
  windows,
  receivedAt: at(NOW),
})

function renderBar(usage: ChatUsageReport) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<UsageBar report={usage} />)
  })
  return renderer
}

const meterOf = (renderer: TestRenderer.ReactTestRenderer, key: string) =>
  renderer.root
    .findAllByProps({ 'data-testid': 'chat-usage-window' })
    .find((meter) => meter.props['data-key'] === key)!

const ticks = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByProps({ 'data-testid': 'chat-usage-time' })

const percentOf = (value: string) => Number.parseFloat(value)

afterEach(() => {
  jest.useRealTimers()
})

describe('usageElapsedShare', () => {
  test('a 5-hour window resetting in 2h 30m is half elapsed', () => {
    expect(usageElapsedShare(fiveHour(), NOW)).toBe(0.5)
  })

  test('no reset time, no period, or an unparsable reset yields no share', () => {
    expect(usageElapsedShare(fiveHour({ resetsAt: null }), NOW)).toBeNull()
    expect(usageElapsedShare(fiveHour({ periodMs: undefined }), NOW)).toBeNull()
    expect(usageElapsedShare(fiveHour({ periodMs: 0 }), NOW)).toBeNull()
    expect(usageElapsedShare(fiveHour({ resetsAt: 'soon' }), NOW)).toBeNull()
  })

  test('a passed reset yields no share; more time left than the period clamps to 0', () => {
    expect(usageElapsedShare(fiveHour({ resetsAt: at(NOW - MINUTE) }), NOW)).toBeNull()
    expect(usageElapsedShare(fiveHour({ resetsAt: at(NOW) }), NOW)).toBeNull()
    expect(usageElapsedShare(fiveHour({ resetsAt: at(NOW + 6 * HOUR) }), NOW)).toBe(0)
  })
})

describe('formatUsageTimeLeft', () => {
  test('days and hours, hours and minutes, minutes, under a minute', () => {
    expect(formatUsageTimeLeft(3 * 24 * HOUR + 4 * HOUR + 5 * MINUTE)).toBe('3d 4h')
    expect(formatUsageTimeLeft(2.5 * HOUR)).toBe('2h 30m')
    expect(formatUsageTimeLeft(45 * MINUTE + 30 * 1000)).toBe('45m')
    expect(formatUsageTimeLeft(30 * 1000)).toBe('<1m')
  })
})

describe('usage bar time marker', () => {
  test('a halfway 5-hour window shows its tick at 50%, row text unchanged', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(report([fiveHour()]))
    const meter = meterOf(renderer, 'five_hour')
    const tick = meter.findByProps({ 'data-testid': 'chat-usage-time' })
    expect(percentOf(tick.props.style.left)).toBe(50)
    // Label, percent, and reset text stay exactly what they were.
    const texts = meter
      .findAll((node) => typeof node.props['data-testid'] === 'string' && node.type === 'span')
      .map((node) => node.props['data-testid'])
    expect(texts).toEqual([
      'chat-usage-label',
      'chat-usage-meter',
      'chat-usage-time',
      'chat-usage-percent',
      'chat-usage-reset',
    ])
    renderer.unmount()
  })

  test('fill past the tick reads ahead of pace, short of it behind', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    // 40% elapsed of a 5-hour window: 3 hours left. 60% elapsed: 2 hours left.
    const renderer = renderBar(
      report([
        fiveHour({ key: 'ahead', percentUsed: 70, resetsAt: at(NOW + 3 * HOUR) }),
        fiveHour({ key: 'behind', percentUsed: 20, resetsAt: at(NOW + 2 * HOUR) }),
      ])
    )
    for (const [key, ahead] of [['ahead', true], ['behind', false]] as const) {
      const meter = meterOf(renderer, key)
      const fill = meter.findByProps({ className: 'chat-usage-fill' })
      const tick = meter.findByProps({ 'data-testid': 'chat-usage-time' })
      const fillWidth = percentOf(fill.props.style.width)
      const tickLeft = percentOf(tick.props.style.left)
      expect(fillWidth > tickLeft).toBe(ahead)
    }
    renderer.unmount()
  })

  test('provider rows, unknown resets, and passed resets get no tick', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(
      report([
        { key: 'zai:tokens_limit', label: 'Tokens', percentUsed: 30, resetsAt: at(NOW + HOUR) },
        fiveHour({ key: 'no-reset', resetsAt: null }),
        fiveHour({ key: 'passed', resetsAt: at(NOW - HOUR) }),
      ])
    )
    expect(ticks(renderer)).toHaveLength(0)
    // Usage still renders for every row.
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'chat-usage-percent' })
    ).toHaveLength(3)
    renderer.unmount()
  })

  test('a provider row stating its own length marks its share like a Claude window', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(
      report([
        {
          key: 'zai:tokens_limit',
          label: '5-hour tokens',
          percentUsed: 30,
          resetsAt: at(NOW + 2.5 * HOUR),
          periodMs: FIVE_HOURS,
        },
      ])
    )
    expect(percentOf(ticks(renderer)[0]!.props.style.left)).toBe(50)
    renderer.unmount()
  })

  test('hover and accessible text state used, elapsed, and time left', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(
      report([
        fiveHour(),
        { key: 'zai:time_limit', label: 'Tool calls', percentUsed: 2, resetsAt: at(NOW + 30 * MINUTE) },
      ])
    )
    const marked = meterOf(renderer, 'five_hour')
    expect(marked.props.title).toBe('22% used · 50% of window elapsed · resets in 2h 30m')
    const track = marked.findByProps({ 'data-testid': 'chat-usage-meter' })
    expect(track.props['aria-label']).toBe(
      '5-hour window: 22% used · 50% of window elapsed · resets in 2h 30m'
    )
    expect(track.props['aria-hidden']).toBeUndefined()

    const plain = meterOf(renderer, 'zai:time_limit')
    expect(plain.props.title).toMatch(/^2% used · resets \d{1,2}:\d{2}/)
    const plainTrack = plain.findByProps({ 'data-testid': 'chat-usage-meter' })
    expect(plainTrack.props['aria-hidden']).toBe(true)
    expect(plainTrack.props['aria-label']).toBeUndefined()
    renderer.unmount()
  })

  test('a 7-day window marks its share of the week', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(
      report([
        fiveHour({
          key: 'seven_day',
          label: '7-day window',
          periodMs: SEVEN_DAYS,
          resetsAt: at(NOW + 3.5 * 24 * HOUR),
        }),
      ])
    )
    expect(percentOf(ticks(renderer)[0]!.props.style.left)).toBe(50)
    expect(meterOf(renderer, 'seven_day').props.title).toContain('resets in 3d 12h')
    renderer.unmount()
  })
})

describe('usage bar minute clock', () => {
  test('the tick advances each minute and disappears once the reset passes', () => {
    // No setSystemTime here: Bun 1.3.x (CI's pinned version) drops a set
    // system time on advanceTimersByTime and jumps back to the real clock, so
    // the window is anchored on the fake clock's own start instead.
    jest.useFakeTimers()
    const start = Date.now()
    const renderer = renderBar(report([fiveHour({ resetsAt: at(start + 2 * MINUTE) })]))
    const left = () => percentOf(ticks(renderer)[0]!.props.style.left)
    const before = left()
    act(() => {
      jest.advanceTimersByTime(MINUTE)
    })
    expect(left()).toBeGreaterThan(before)
    act(() => {
      jest.advanceTimersByTime(2 * MINUTE)
    })
    expect(ticks(renderer)).toHaveLength(0)
    renderer.unmount()
  })

  test('the clock stops once every window’s reset has passed', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(report([fiveHour({ resetsAt: at(NOW + MINUTE) })]))
    expect(jest.getTimerCount()).toBe(1)
    act(() => {
      jest.advanceTimersByTime(MINUTE + 1)
    })
    expect(ticks(renderer)).toHaveLength(0)
    expect(jest.getTimerCount()).toBe(0)
    renderer.unmount()
  })

  test('no clock runs when no window can carry a tick', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(report([fiveHour({ periodMs: undefined })]))
    expect(jest.getTimerCount()).toBe(0)
    renderer.unmount()

    const marked = renderBar(report([fiveHour()]))
    expect(jest.getTimerCount()).toBe(1)
    act(() => marked.unmount())
    expect(jest.getTimerCount()).toBe(0)
  })
})

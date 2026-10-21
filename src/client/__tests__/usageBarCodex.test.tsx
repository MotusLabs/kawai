// Codex windows in the chat header's usage bar (codex-chat-sessions 7.3, the
// client slice of D9): the meters render through the existing bar with their
// Codex labels ('5-hour', 'weekly'), percent figures, and the limited state.
// usageBarPace.test.tsx covers the elapsed tick and the accessible text; this
// file covers the visible label and percent texts those tests skip.
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatUsageReport, ChatUsageWindow } from '@shared/chat'
import UsageBar from '../components/chat/UsageBar'

const NOW = Date.parse('2026-10-21T13:00:00.000Z')
const FIVE_HOURS = 5 * 60 * 60 * 1000
const SEVEN_DAYS = 7 * 24 * FIVE_HOURS
const at = (ms: number) => new Date(ms).toISOString()

const report = (status: ChatUsageReport['status'], windows: ChatUsageWindow[]): ChatUsageReport => ({
  status,
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

const textOf = (meter: ReturnType<typeof meterOf>, testId: string) => {
  const children = meter.findByProps({ 'data-testid': testId }).props.children
  return Array.isArray(children) ? children.join('') : String(children)
}

describe('codex usage bar (codex-chat-sessions 7.3)', () => {
  test('both codex windows render their labels and percents', () => {
    const renderer = renderBar(report('allowed', [
      { key: 'codex:primary', label: '5-hour', percentUsed: 40, resetsAt: at(NOW + 2.5 * FIVE_HOURS), periodMs: FIVE_HOURS },
      { key: 'codex:secondary', label: 'weekly', percentUsed: 12, resetsAt: at(NOW + 5 * 24 * FIVE_HOURS), periodMs: SEVEN_DAYS },
    ]))
    expect(textOf(meterOf(renderer, 'codex:primary'), 'chat-usage-label')).toBe('5-hour')
    expect(textOf(meterOf(renderer, 'codex:primary'), 'chat-usage-percent')).toBe('40%')
    expect(textOf(meterOf(renderer, 'codex:secondary'), 'chat-usage-label')).toBe('weekly')
    expect(textOf(meterOf(renderer, 'codex:secondary'), 'chat-usage-percent')).toBe('12%')
    expect(renderer.root.findByProps({ 'data-testid': 'chat-usage' }).props['data-status']).toBe('allowed')
    act(() => renderer.unmount())
  })

  test('a reached codex limit marks the bar limited; the window keeps its label, percent, and reset', () => {
    const renderer = renderBar(report('limited', [
      { key: 'codex:primary', label: '5-hour', percentUsed: 100, resetsAt: at(NOW + FIVE_HOURS), periodMs: FIVE_HOURS },
      { key: 'codex:secondary', label: 'weekly', percentUsed: 8, resetsAt: at(NOW + 5 * 24 * FIVE_HOURS), periodMs: SEVEN_DAYS },
    ]))
    expect(renderer.root.findByProps({ 'data-testid': 'chat-usage' }).props['data-status']).toBe('limited')
    const primary = meterOf(renderer, 'codex:primary')
    expect(textOf(primary, 'chat-usage-label')).toBe('5-hour')
    expect(textOf(primary, 'chat-usage-percent')).toBe('100%')
    expect(primary.findByProps({ 'data-testid': 'chat-usage-reset' })).toBeDefined()
    act(() => renderer.unmount())
  })

  test('a dropped primary leaves the weekly meter rendering alone', () => {
    const renderer = renderBar(report('allowed', [
      { key: 'codex:secondary', label: 'weekly', percentUsed: 12, resetsAt: at(NOW + 5 * 24 * FIVE_HOURS), periodMs: SEVEN_DAYS },
    ]))
    expect(meterOf(renderer, 'codex:primary')).toBeUndefined()
    expect(textOf(meterOf(renderer, 'codex:secondary'), 'chat-usage-label')).toBe('weekly')
    act(() => renderer.unmount())
  })
})

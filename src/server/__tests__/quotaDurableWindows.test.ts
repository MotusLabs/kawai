// What quota history keeps of a report (process-quota-history-and-incident-
// advice I2/P4): no wire string survives — an accepted answer whose unknown
// row kind, Codex limit name or Claude model display name echoes the
// credential stores approved kinds and table labels only, unknown kinds as
// opaque per-prefix ordinals, resets re-serialized, source/status checked.
import { expect, test } from 'bun:test'
import type { ChatUsageReport } from '../../shared/chat'
import { parseZaiQuotaLimit } from '../chat/zaiQuotaLimit'
import { durableReportFields, durableWindows } from '../metrics/observations/durableWindows'
import { BODY_MARKER, QUOTA_TOKEN } from './helpers/quotaComposition'

const window = (key: string, label: string, extra: Partial<ChatUsageReport['windows'][number]> = {}) =>
  ({ key, label, percentUsed: 10, resetsAt: null, ...extra }) as ChatUsageReport['windows'][number]

test('an accepted Z.ai answer whose unknown kinds echo the credential stores approved kinds and opaque unknowns only', () => {
  const report = parseZaiQuotaLimit({
    success: true,
    data: { limits: [
      { type: 'TIME_LIMIT', percentage: 40, nextResetTime: 4_102_444_800_000 },
      { type: QUOTA_TOKEN, percentage: 1 },
      { type: `${BODY_MARKER}`, percentage: 2 },
      { type: 'TIME_LIMIT', percentage: 50 },
    ] },
  } as never)!
  // The live parser keeps its contract: the raw type is the label.
  expect(report.windows.map(entry => entry.label)).toContain(QUOTA_TOKEN)
  const kept = durableWindows(report.windows)
  expect(kept.map(entry => [entry.key, entry.label, entry.percentUsed])).toEqual([
    ['zai:time_limit', 'Tool calls', 40], ['zai:unknown', 'Unknown window', 1], ['zai:unknown#2', 'Unknown window', 2], ['zai:time_limit#2', 'Tool calls', 50],
  ])
  const stored = JSON.stringify(kept)
  for (const secret of [QUOTA_TOKEN, BODY_MARKER, QUOTA_TOKEN.toLowerCase()]) expect(stored).not.toContain(secret)
})

test('agent report wire text — model display names, Codex limit names, unknown keys and junk resets — never persists', () => {
  const kept = durableWindows([
    window('five_hour', '5-hour window', { resetsAt: '2026-06-01T17:00:00Z', periodMs: 18_000_000 }),
    window(`model_scoped:${QUOTA_TOKEN}`, QUOTA_TOKEN),
    window('codex:primary', `5-hour · ${QUOTA_TOKEN}`),
    window(QUOTA_TOKEN, QUOTA_TOKEN, { resetsAt: QUOTA_TOKEN }),
    window('constructor', 'x'),
    window('seven_day#2', '7-day window', { percentUsed: Number.NaN }),
  ])
  expect(kept).toEqual([
    { key: 'five_hour', label: '5-hour window', percentUsed: 10, resetsAt: '2026-06-01T17:00:00.000Z', periodMs: 18_000_000 },
    { key: 'model_scoped', label: 'Model-scoped window', percentUsed: 10, resetsAt: null },
    { key: 'codex:primary', label: 'Primary window', percentUsed: 10, resetsAt: null },
    { key: 'unknown', label: 'Unknown window', percentUsed: 10, resetsAt: null },
    { key: 'unknown#2', label: 'Unknown window', percentUsed: 10, resetsAt: null },
  ])
  expect(JSON.stringify(kept)).not.toContain(QUOTA_TOKEN)
})

test('a report source or status outside the enums is not stored', () => {
  expect(durableReportFields({ status: 'limited', source: 'provider', windows: [], receivedAt: '' })).toEqual({ source: 'provider', status: 'limited' })
  expect(durableReportFields({ status: QUOTA_TOKEN, source: QUOTA_TOKEN, windows: [], receivedAt: '' } as never)).toEqual({ source: 'none', status: null })
  expect(durableReportFields(null)).toEqual({ source: 'none', status: null })
})

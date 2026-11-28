// What of a usage report quota history may keep (process-quota-history-and-
// incident-advice I2/P4). Reports carry wire text — a Z.ai row's raw type, a
// Codex limit name, a Claude model's display name — and an endpoint that
// echoes the request could put the credential there. So history keeps no
// wire string: a window's key is an approved kind (with its ordinal), its
// label comes from this table, and an unapproved kind becomes the opaque
// `<prefix>unknown#n`. Numbers stay numbers, a reset is re-serialized as an
// ISO time, and the report's source and status are enum-checked.
import type { ChatUsageReport, ChatUsageSource, ChatUsageStatus, ChatUsageWindow } from '../../../shared/chat'

/** Approved window kinds and their durable labels. */
const APPROVED_KINDS = new Map<string, string>([
  ['zai:time_limit', 'Tool calls'], ['zai:tokens_limit', 'Tokens'],
  ['openrouter:key_limit', 'Key limit'], ['openrouter:credits', 'Credits'],
  ['codex:primary', 'Primary window'], ['codex:secondary', 'Secondary window'],
  ['five_hour', '5-hour window'], ['session', '5-hour window'], ['seven_day', '7-day window'],
  ['seven_day_opus', '7-day Opus window'], ['seven_day_sonnet', '7-day Sonnet window'],
  ['seven_day_oauth_apps', '7-day OAuth apps window'], ['seven_day_overage_included', '7-day overage-included window'],
  ['weekly_all', '7-day window'], ['weekly_scoped', '7-day scoped window'], ['overage', 'Overage'],
  ['model_scoped', 'Model-scoped window'],
])
const PREFIXES = ['zai:', 'openrouter:', 'codex:']
const STATUSES: readonly ChatUsageStatus[] = ['allowed', 'warning', 'limited']
const SOURCES: readonly ChatUsageSource[] = ['provider', 'push', 'report', 'pull']

export interface DurableWindow {
  key: string
  label: string
  percentUsed: number
  resetsAt: string | null
  periodMs?: number
}

/**
 * The table label of a key that is exactly an approved kind (`kind` or
 * `kind#n`, never a scoped `model_scoped:<scope>`), else undefined. The live
 * reader boundary keeps such keys as Kawai's own vocabulary (redactSecrets.ts).
 */
export function approvedWindowLabel(key: string): string | undefined {
  return APPROVED_KINDS.get(key.replace(/#\d+$/, ''))
}

/** The approved kind a wire key names (`kind`, `kind#n`, `kind:<scope>` for model-scoped rows), or null. */
function approvedKind(key: string): string | null {
  const base = key.replace(/#\d+$/, '')
  if (APPROVED_KINDS.has(base)) return base
  return base.startsWith('model_scoped:') ? 'model_scoped' : null
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

/** The report's windows as history may keep them: approved kinds, opaque unknowns, no wire text. */
export function durableWindows(windows: readonly ChatUsageWindow[]): DurableWindow[] {
  const seen = new Map<string, number>()
  const out: DurableWindow[] = []
  for (const window of windows) {
    const percentUsed = Number(window.percentUsed)
    if (!Number.isFinite(percentUsed)) continue
    const key = String(window.key)
    const kind = approvedKind(key) ?? `${PREFIXES.find(prefix => key.startsWith(prefix)) ?? ''}unknown`
    const count = (seen.get(kind) ?? 0) + 1
    seen.set(kind, count)
    out.push({
      key: count === 1 ? kind : `${kind}#${count}`,
      label: APPROVED_KINDS.get(kind) ?? 'Unknown window',
      percentUsed,
      resetsAt: isoOrNull(window.resetsAt),
      ...(typeof window.periodMs === 'number' && Number.isFinite(window.periodMs) ? { periodMs: window.periodMs } : {}),
    })
  }
  return out
}

/** The report's source and status, enum-checked (`none`/null otherwise). */
export function durableReportFields(report: ChatUsageReport | null): { source: string; status: ChatUsageStatus | null } {
  const source = SOURCES.includes(report?.source as ChatUsageSource) ? String(report!.source) : 'none'
  const status = STATUSES.includes(report?.status as ChatUsageStatus) ? report!.status : null
  return { source, status }
}

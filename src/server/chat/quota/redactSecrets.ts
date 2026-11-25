// Credential material a provider echoes back never reaches a caller of the
// quota reader (process-quota-history-and-incident-advice I2/P4; Sol
// re-checks note-d5b9f0e9 and note-90848d06; Lead decision-1e654933). Every
// pull the reader returns passes through `redactPull` with its target's
// credentials — each nonempty token and balance key, of any length, matched
// case-insensitively (the live parser lowercases wire kinds into keys):
//
// - a window of an approved kind keeps its key, Kawai's own vocabulary, and
//   its label unless the label carries a credential, then the table label;
// - any other window keeps its raw key and label (master's live behavior,
//   A2) unless either carries a credential: then it becomes the opaque
//   `<prefix>unknown#n` with label `Unknown limit`, numbered past every key
//   the report already holds, so keys stay unique;
// - a free-text string (a failure reason, a credits reason) that carries a
//   credential becomes `[redacted]` whole — partial replacement could leave
//   a credential spanning the seam;
// - enums and times are Kawai's vocabulary (times re-serialized here).
//
// So every string of a returned pull is either fixed vocabulary or holds no
// occurrence of a target credential. Durable history normalizes its fields
// separately (observations/durableWindows.ts).
import type { ChatUsageReport, ChatUsageWindow } from '../../../shared/chat'
import { approvedWindowLabel } from '../../metrics/observations/durableWindows'
import type { QuotaPull } from './QuotaReaderService'
import type { QuotaTarget } from './quotaTarget'

export const REDACTED = '[redacted]'
export const OPAQUE_LABEL = 'Unknown limit'
const PREFIXES = ['zai:', 'openrouter:', 'codex:']

/** The target's nonempty credentials, lowercased for case-insensitive matching. */
function secretsOf(target: QuotaTarget): string[] {
  return [...new Set([target.token, target.balanceKey]
    .filter((secret): secret is string => typeof secret === 'string' && secret !== '')
    .map(secret => secret.toLowerCase()))]
}

function isoOrNull(value: string | null): string | null {
  if (value === null) return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

function redactWindows(windows: ChatUsageWindow[], carries: (text: string) => boolean): ChatUsageWindow[] {
  const kept = windows.map(window => {
    const approved = approvedWindowLabel(window.key)
    if (approved !== undefined) return { window, opaque: false, label: carries(window.label) ? approved : window.label }
    return { window, opaque: carries(window.key) || carries(window.label), label: window.label }
  })
  const taken = new Set(kept.filter(entry => !entry.opaque).map(entry => entry.window.key))
  return kept.map(({ window, opaque, label }) => {
    const resetsAt = isoOrNull(window.resetsAt)
    if (!opaque) return { ...window, label, resetsAt }
    const prefix = PREFIXES.find(candidate => window.key.toLowerCase().startsWith(candidate)) ?? ''
    let n = 1
    while (taken.has(`${prefix}unknown#${n}`)) n++
    const key = `${prefix}unknown#${n}`
    taken.add(key)
    return { key, label: OPAQUE_LABEL, percentUsed: window.percentUsed, resetsAt }
  })
}

function redactReport(report: ChatUsageReport, carries: (text: string) => boolean): ChatUsageReport {
  return { ...report, receivedAt: isoOrNull(report.receivedAt) ?? new Date(0).toISOString(), windows: redactWindows(report.windows, carries) }
}

/** The pull as a caller may see it: no string carries a target credential unless it is Kawai's vocabulary. */
export function redactPull(pull: QuotaPull, target: QuotaTarget): QuotaPull {
  const secrets = secretsOf(target)
  if (secrets.length === 0) return pull
  const carries = (text: string) => {
    const lower = text.toLowerCase()
    return secrets.some(secret => lower.includes(secret))
  }
  const free = (text: string) => carries(text) ? REDACTED : text
  if (!pull.ok) return { ...pull, reason: free(pull.reason) } as QuotaPull
  if ('credits' in pull) {
    const credits = pull.credits.reason === undefined ? pull.credits : { ...pull.credits, reason: free(pull.credits.reason) }
    return { ...pull, report: redactReport(pull.report, carries), credits }
  }
  return { ...pull, report: redactReport(pull.report, carries) }
}

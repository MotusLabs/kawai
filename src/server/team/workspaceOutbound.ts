// The Team workspace's outbound projection (execution-safety-recovery D10):
// the attention items for unacknowledged violations and the morning
// summary's durable `outbound` bucket, both pure over what the audit
// records supply. Split out of workspaceRead.ts to keep that file small.
import type { AttentionItem, SummaryItem } from '../../shared/teamWorkspace'
import type { OutboundViolationGroup } from '../outbound/service'

/**
 * Unacknowledged outbound violations (execution-safety-recovery D10): one
 * informational item per `(rule, destination)` group, owned by the human.
 * Nothing waits on it — the impact names no task — and a verdict never
 * becomes a stop reason, supervision cause, or dispatch input: this source
 * only reads, and nothing downstream of a verdict exists.
 */
export const outboundAttentionItems = (outboundViolations: OutboundViolationGroup[], nameOf: (sessionId: string) => string): AttentionItem[] =>
  outboundViolations.map(group => ({
    id: `outbound-violation:${group.rule}:${group.destination}`,
    kind: 'outbound-violation' as const,
    cause: `${group.rule} to ${group.destination}: ${group.count} unacknowledged, latest by ${nameOf(group.latestSessionId)}`,
    owner: { kind: 'human' as const, id: null, label: 'Human' },
    impact: {},
    nextAction: 'Review and acknowledge',
    link: { kind: 'audit' as const, id: group.latestCallId },
    requiresHuman: true,
  }))

/**
 * The audit records' row counts over the summary window: durable, so a
 * restart within the window shows the same numbers. One item per class the
 * window holds, each opening the Audit tab.
 */
export function outboundSummaryItems(outboundCounts: { allowed: number; unknown: number; violations: number }): SummaryItem[] {
  const outbound: SummaryItem[] = []
  if (outboundCounts.allowed > 0) {
    outbound.push({
      id: 'outbound:allowed', label: `${outboundCounts.allowed} allowed send${outboundCounts.allowed === 1 ? '' : 's'}`,
      link: { kind: 'audit', id: '' },
    })
  }
  if (outboundCounts.unknown > 0) {
    outbound.push({
      id: 'outbound:unknown', label: `${outboundCounts.unknown} unknown destination${outboundCounts.unknown === 1 ? '' : 's'}`,
      link: { kind: 'audit', id: '' },
    })
  }
  if (outboundCounts.violations > 0) {
    outbound.push({
      id: 'outbound:violation', label: `${outboundCounts.violations} violation${outboundCounts.violations === 1 ? '' : 's'}`,
      link: { kind: 'audit', id: '' },
    })
  }
  return outbound
}

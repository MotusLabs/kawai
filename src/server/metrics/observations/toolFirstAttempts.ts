// Closed-cohort R1 predicate; consumers must supply the closure from the same DB read.
import type { StoredObservation } from '../../../shared/processObservations'
export function firstAttemptEligible(row: StoredObservation, closure: StoredObservation | undefined,
  from: number, end: number): boolean {
  const at = Date.parse(row.observedAt)
  return row.kind === 'tool' && row.data.eligible === true && row.data.first === true &&
    row.data.toolKind === 'team' && row.data.partial === false &&
    at >= from && at < end && closure?.kind === 'turn_ended' &&
    closure.sessionId === row.sessionId && closure.turnId === row.turnId &&
    closure.data.toolCoverageVersion === 1 && closure.data.toolFirstHistoryUnknown === false
}

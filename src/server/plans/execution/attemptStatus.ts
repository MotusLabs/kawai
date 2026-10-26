// One attempt row's dispatch state (revision-control PR E, H″ O1): the
// snapshot's owed marker and the pause target's holder derivation read it,
// so both judge the rows alone at call time — no lease, epoch, or stamp of
// their own. 'answered' — a round records the row (a result is attributed to
// the newest row), so its work is in the round pipeline; 'owed' — never
// dispatched, the change's next instruction; 'out' — dispatched.
import type { AttemptStatus } from '../../../shared/planExecution'
import type { AttemptRow, RoundRow } from './executionRows'

export { type AttemptStatus, agentHeldStage } from '../../../shared/planExecution'

/** The assignment facts the status reads: every assignment of the task, any state. */
export interface AttemptKeyFacts {
  requestKey: string | null
}

/**
 * The row's status, derived fresh from the rows. The key test is anchored as
 * a whole: `exec:<e>:<c>:attempt:<n>:<digits>` — `attempt:1:` must never
 * match `attempt:11:…` (the next colon) nor a `:retry:` re-send (the
 * generation is the whole remainder, digits only). The clauses are AND: a
 * stamped row whose assignment was later superseded is not owed — its
 * instruction went out, and the supersession is the restart's story (I2),
 * not the dispatch's.
 */
export function attemptStatus(row: Pick<AttemptRow, 'id' | 'executionId' | 'change' | 'number' | 'assignmentId'>,
  taskAssignments: ReadonlyArray<AttemptKeyFacts>, rounds: ReadonlyArray<Pick<RoundRow, 'attemptId'>>): AttemptStatus {
  if (rounds.some(round => round.attemptId === row.id)) return 'answered'
  if (row.assignmentId === null) {
    const prefix = `exec:${row.executionId}:${row.change}:attempt:${row.number}:`
    const sent = taskAssignments.some(assignment => {
      const key = assignment.requestKey
      if (key === null || !key.startsWith(prefix)) return false
      const generation = key.slice(prefix.length)
      return /^\d+$/.test(generation)
    })
    if (!sent) return 'owed'
  }
  return 'out'
}

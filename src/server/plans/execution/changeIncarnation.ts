// A change's current incarnation (plan-revision-apply CH7, CH9, review F2).
// An Apply that removes an unlanded change cancels its row and records, on
// the removal's publication row, the task the row carried — the task it
// retired. An Apply that adds the name back restores that row as fresh
// waiting work with no task. The earlier attempts and rounds stay in the
// database as history, but they answered the retired task: every attempt
// manifest names its task, so the attempts of a retired task are not current
// once the row no longer carries it, nor are the rounds answering them.
// While no Apply retired a task of the change, every row reads as before.
import type { AttemptRow, RoundRow } from './executionRows'

/** The attempts that are not a retired task's, unless the row still carries that task. */
export function currentAttempts(attempts: AttemptRow[], taskId: string | null, retired: ReadonlySet<string>): AttemptRow[] {
  if (retired.size === 0) return attempts
  return attempts.filter(attempt => {
    // A stored manifest without a task (none Kawai mints) names no retired task.
    const id = (attempt.manifest.task as { id?: string } | undefined)?.id
    return id === undefined || id === taskId || !retired.has(id)
  })
}

/** The rounds answering none of the excluded attempts. */
export function currentRounds(rounds: RoundRow[], all: AttemptRow[], current: AttemptRow[]): RoundRow[] {
  const kept = new Set(current.map(attempt => attempt.id))
  const excluded = new Set(all.filter(attempt => !kept.has(attempt.id)).map(attempt => attempt.id))
  return rounds.filter(round => !excluded.has(round.attemptId))
}

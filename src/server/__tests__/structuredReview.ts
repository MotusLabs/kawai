// A plan review as structured findings (review-findings-ledger D4): the
// execution tests' reviewers rule pass or fail, and a plan change's review
// claimant may no longer send text. A pass resolves every blocking finding;
// a fail keeps the open ones still-open, or raises one accepted P1 citing
// the task's first acceptance clause (or its revision identity without a
// contract). `text` is the notes and the evidence, so instructions that
// quote the reviewer still read it.
import { blocking } from '../../shared/findingsLedger'
import type { TaskResultService } from '../team/TaskResultService'

export function structuredReview(results: TaskResultService, taskId: string, verdict: 'pass' | 'fail', text: string) {
  const task = results.tasks.store.get(taskId)!
  const open = blocking(results.findingsLedger.ledger(task.id))
  if (verdict === 'pass') {
    return { verdict, findings: text, items: [], dispositions: open.map(row => ({ id: row.id, disposition: 'resolved' as const })) }
  }
  if (open.length > 0) {
    return { verdict, findings: text, items: [], dispositions: open.map(row => ({ id: row.id, disposition: 'still-open' as const, evidence: text })) }
  }
  const clause = task.contract?.acceptance[0]?.id ?? task.identity!
  return { verdict, findings: text, items: [{ level: 'P1' as const, clause, evidence: text, impact: text }], dispositions: [] }
}

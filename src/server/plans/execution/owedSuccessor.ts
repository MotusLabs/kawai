// Stale owed attempts (plan-revision-apply design challenge DC1, property
// P4): an attempt row minted but never dispatched names, in its immutable
// manifest, the revision current when it was minted. When an Apply moved the
// execution on before the owed step sent it (e.g. under a hold), the owed
// step dispatches a successor instead: one row of the same kind whose
// manifest names the execution's current revision, content hash, and
// validation report, the task's current revision, and the current
// revision's role profiles, copying everything else — the start point, the
// artifacts, the answers, the update facts, the checkpoint. The stale row
// stays exactly as it was and is never sent: its request key (attempt
// number) is never used, and the successor is the newest row the owed step
// reads from then on.
import { createHash } from 'node:crypto'
import { manifestHashInput, type AttemptManifest } from '../../../shared/planExecution'
import type { PlanStore } from '../planStore'
import type { ExecutionStore } from './executionStore'
import type { AttemptRow } from './executionRows'

export interface OwedSuccessorDeps {
  executions: ExecutionStore
  plans: PlanStore
  taskRevisionOf: (taskId: string) => number | null
}

/** The newest owed row if it names the current revision; else its successor, minted now. Null when the execution is gone. */
export function currentOwedRow(deps: OwedSuccessorDeps, input: { executionId: string; change: string; group: string }, newest: AttemptRow): AttemptRow | null {
  const execution = deps.executions.execution(input.executionId)
  if (execution === null) return null
  if (newest.manifest.plan.revision === execution.revision && newest.manifest.plan.contentHash === execution.contentHash) return newest
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const manifest: AttemptManifest = {
    ...structuredClone(newest.manifest),
    plan: { id: execution.planId, revision: execution.revision, contentHash: execution.contentHash },
    task: { id: newest.manifest.task.id, revision: deps.taskRevisionOf(newest.manifest.task.id) ?? newest.manifest.task.revision },
    validation: { reportId: execution.reportId, inputHash: execution.inputHash },
    roleProfiles: revision?.content.roles.find(role => role.group === input.group)?.profiles ?? newest.manifest.roleProfiles,
  }
  const manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
  return deps.executions.insertAttempt({ executionId: input.executionId, change: input.change, kind: newest.kind, assignmentId: null, manifest, manifestHash })
}

import { createHash } from 'node:crypto'
import type { PublicationContent } from '../../../shared/planDecisions'
import type { Plan, PlanRevision } from '../../../shared/plans'
import { canonicalJson } from '../../../shared/productStrategy'
import { parseContract, renderContract, type ImplementationContract } from '../../../shared/implementationContract'
import type { TaskHandoff } from '../../../shared/taskHandoffs'
import { contractHash, identityOf } from '../../team/contractHash'
import { contractInput, nextContract } from '../../team/taskContractRows'
import { handoffPayloadHash } from '../../team/taskHandoffStore'
import { firstDifference, normalizeHandoffRequest, validatePreparedHandoffFields } from '../../team/taskHandoffValidation'
import { hashPlanRevision } from '../planHash'
import type { DecisionServiceDeps } from './DecisionService'
import { DecisionRefusal } from './decisionInputs'
import { executionContext, stalePublication, type PublicationExecutionReads } from './decisionPublicationExecution'

type BindingReads = Pick<DecisionServiceDeps, 'db' | 'plans' | 'tasks' | 'taskStore'>
type PublicationTarget = { plan: Plan; taskId: string; change: string }

export interface PublicationSnapshot {
  version: 1
  cardId: string
  teamId: string
  planId: string
  change: string
  approvedPlanRevision: number
  approvedPlanHash: string
  taskId: string
  taskCreator: string
  taskOwner: string | null
  baseRevision: number
  baseContractHash: string | null
  baseContentHash: string
  handoffId: string
  requesterSession: string
  requesterGroup: string | null
  payloadHash: string
  baseCommit: string | null
  evidenceRefs: string[]
  execution: ReturnType<typeof executionContext>
}

const SHA256 = /^[0-9a-f]{64}$/
export const sha256 = (input: string) => createHash('sha256').update(input).digest('hex')

export function publicationTarget(deps: BindingReads, teamId: string, handoffId: string) {
  // Authorization and replay need only the persisted target and requester, independent of mutable D2 facts.
  const row = deps.db.query<{
    requesterSession: string; taskId: string; planId: string | null; change: string | null
  }, [string, string]>(`SELECT h.requester_session AS requesterSession, t.id AS taskId, t.plan_id AS planId, t.plan_change AS change
    FROM team_task_handoffs h JOIN team_tasks t ON t.id = h.task_id AND t.team_id = h.team_id
    WHERE h.team_id = ? AND h.id = ?`).get(teamId, handoffId)
  const missing = () => new DecisionRefusal('not-found', 'Publication handoff or target not found in this team.')
  if (!row) throw missing()
  if (!row.planId || !row.change) throw new DecisionRefusal('forbidden', 'The publication handoff requires a task with a persisted plan and change.')
  const plan = deps.plans.forTeam(teamId, row.planId)
  if (!plan) throw missing()
  return { plan, taskId: row.taskId, change: row.change, requesterSession: row.requesterSession }
}

/** Inspect raw routing data. Plan normalization may erase a malformed Lead role. */
export function currentOwnerRoute(deps: BindingReads, plan: Plan, group: string | null): void {
  const row = deps.db.query<{ status: string; content_json: string }, [string, number | null]>(
    'SELECT status, content_json FROM plan_revisions WHERE plan_id = ? AND revision = ?',
  ).get(plan.id, plan.currentApprovedRevision)
  let lead: string | undefined
  try {
    const content = row && JSON.parse(row.content_json)
    if (row?.status !== 'approved' || !content || !Array.isArray(content.changes) || !Array.isArray(content.roles)) throw new Error()
    lead = content.leadGroup
    if (lead !== undefined && (typeof lead !== 'string' || !lead.trim() || lead !== lead.trim() ||
        !content.roles.some((role: { group?: string } | null) => role?.group === lead))) throw new Error()
  } catch {
    throw new DecisionRefusal('forbidden', 'The current approved plan routing is missing or unreadable.')
  }
  if (lead !== undefined && lead !== group) {
    throw new DecisionRefusal('forbidden', 'Your question routes to the Lead. Use an ordinary question or the publication handoff.')
  }
}

export function preparedHandoff(deps: BindingReads, teamId: string, taskId: string, handoffId: string): TaskHandoff & { notify: true } {
  try {
    const handoff = deps.tasks.handoffs.store.forTeam(teamId, handoffId)
    if (!handoff || handoff.taskId !== taskId || !handoff.notify || !Array.isArray(handoff.evidenceRefs) ||
        !handoff.evidenceRefs.every(ref => typeof ref === 'string')) throw new Error()
    const normalized = normalizeHandoffRequest(handoff)
    if (firstDifference(handoff, { ...normalized, baseRevision: handoff.baseRevision }) || handoffPayloadHash(handoff) !== handoff.payloadHash) throw new Error()
    validatePreparedHandoffFields(normalized)
    return { ...handoff, notify: true }
  } catch {
    throw stalePublication('The prepared handoff is missing, nonnotifying or inconsistent.')
  }
}

export function publishedBase(deps: BindingReads, taskId: string, revision: number) {
  const row = deps.db.query<{
    direction: string; acceptance: string | null; contract: string | null; contract_hash: string | null
  }, [string, number]>(`SELECT direction, acceptance, contract, contract_hash FROM team_task_revisions
    WHERE task_id = ? AND revision = ?`).get(taskId, revision)
  if (!row) throw stalePublication(`Published base revision ${revision} is missing.`)
  let contract: ImplementationContract | null = null
  try {
    if (row.contract !== null) {
      const stored = JSON.parse(row.contract) as ImplementationContract
      contract = parseContract(renderContract(stored)).contract
      if (!contract || canonicalJson(stored) !== canonicalJson(contract)) throw new Error()
    }
    if ((contract === null ? null : contractHash(contract)) !== row.contract_hash) throw new Error()
  } catch {
    throw stalePublication(`The contract of published base revision ${revision} is inconsistent.`)
  }
  const content: PublicationContent = { direction: row.direction, acceptance: row.acceptance, contract }
  const fields = { revision, direction: row.direction, acceptance: row.acceptance, contractHash: row.contract_hash }
  return {
    content,
    contractHash: row.contract_hash,
    identity: identityOf(fields),
    contentHash: sha256(canonicalJson({ version: 1, ...content, contractHash: row.contract_hash })),
  }
}

export function preparedContent(handoff: TaskHandoff, before: PublicationContent): PublicationContent {
  return {
    direction: handoff.direction ?? before.direction,
    acceptance: handoff.acceptance ?? before.acceptance,
    contract: nextContract(before.contract, contractInput(handoff.contract, true)),
  }
}

function currentApproval(deps: BindingReads, plan: Plan, change: string): PlanRevision {
  if (plan.lifecycle !== 'open') throw stalePublication('The plan is no longer open.')
  const approved = deps.plans.approvedRevision(plan.id)
  if (!approved || approved.status !== 'approved' || !SHA256.test(approved.contentHash) ||
      hashPlanRevision(approved.content, approved.pin) !== approved.contentHash) {
    throw stalePublication('The current approved plan revision is missing or inconsistent.')
  }
  if (!approved.content.changes.some(item => item.change === change)) throw stalePublication('The change is absent from the approved plan.')
  return approved
}

export function publicationSnapshot(deps: BindingReads, reads: PublicationExecutionReads, teamId: string, cardId: string, handoffId: string, target: PublicationTarget): PublicationSnapshot {
  try {
    const { plan, taskId, change } = target
    const task = deps.taskStore.get(taskId)
    if (!task || task.teamId !== teamId || task.planId !== plan.id || task.planChange !== change || plan.teamId !== teamId ||
        !['open', 'active', 'blocked'].includes(task.status)) throw stalePublication('The task is closed or its scope changed.')
    const handoff = preparedHandoff(deps, teamId, taskId, handoffId)
    if (task.revision !== handoff.baseRevision) throw stalePublication(`The task base moved from revision ${handoff.baseRevision} to ${task.revision}.`)
    if (handoff.state !== 'open') throw stalePublication(`The publication handoff is ${handoff.state}.`)
    const handoffs = deps.tasks.handoffs.store
    if (handoff.publishedRevision !== null || handoffs.associatedRevision(taskId, handoffId) !== null || handoffs.preparedKeyRevision(taskId, handoffId)) {
      throw stalePublication('This prepared handoff already has a revision or a reserved key.')
    }
    const base = publishedBase(deps, taskId, handoff.baseRevision)
    if (handoff.baseContractHash !== base.contractHash) throw stalePublication('The task base contract changed.')
    const approved = currentApproval(deps, plan, change)
    return {
      version: 1, cardId, teamId, planId: plan.id, change,
      approvedPlanRevision: approved.revision, approvedPlanHash: approved.contentHash,
      taskId, taskCreator: task.creator.kind, taskOwner: task.ownerSession ?? null,
      baseRevision: handoff.baseRevision, baseContractHash: base.contractHash, baseContentHash: base.contentHash,
      handoffId, requesterSession: handoff.requesterSession, requesterGroup: handoff.requesterGroup,
      payloadHash: handoff.payloadHash, baseCommit: handoff.baseCommit, evidenceRefs: handoff.evidenceRefs,
      execution: executionContext(deps.db, deps.plans, reads, task, plan, change),
    }
  } catch (error) {
    if (error instanceof DecisionRefusal) throw error
    throw stalePublication('The publication scope or pinned records cannot be read consistently.')
  }
}

import type { DecisionCard, DecisionParty, DecisionPublicationReceipt, PlanDecision, PublicationReview } from '../../../shared/planDecisions'
import { canonicalJson } from '../../../shared/productStrategy'
import { preparedKey } from '../../../shared/taskHandoffs'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { DecisionCaller, DecisionOutcome, DecisionService } from './DecisionService'
import { DecisionRefusal, payloadDiff, rationaleOf } from './decisionInputs'
import { teamPlan } from './decisionScope'
import { preparedContent, preparedHandoff, publicationSnapshot, publishedBase, sha256, type PublicationSnapshot } from './decisionPublicationBinding'
import { stalePublication } from './decisionPublicationExecution'
import { DecisionPublicationStore } from './decisionPublicationStore'

export const APPROVE_ACTION = 'approve-publication'
const CHOICE = 'Approve and publish'
const HUMAN: DecisionParty = { kind: 'human', session: null, group: null, profile: null }
const FIELDS = ['action', 'cardId', 'expectedHandoffId', 'expectedBindingHash', 'rationale'] as const

export interface PublicationReviewInput { planId: string; cardId: string }
export interface PublicationApprovalInput extends PublicationReviewInput {
  commandId: string
  expectedHandoffId: string
  expectedBindingHash: string
  rationale?: string | null
}
type PublicationOutcome = DecisionOutcome & { publication: DecisionPublicationReceipt }

function ownerTeam(caller: DecisionCaller): TeamIdentity {
  if (caller.kind !== 'human') throw new DecisionRefusal('forbidden', 'Only the owner reviews and approves a publication from the Plans view.')
  return caller.team
}

function scopedCard(service: DecisionService, teamId: string, input: PublicationReviewInput) {
  const plan = teamPlan(service.deps.plans, teamId, input.planId)
  const card = service.deps.decisions.card(teamId, input.cardId)
  if (!card || card.planId !== plan.id) throw new DecisionRefusal('not-found', 'Decision card not found on this plan.')
  return { plan, card }
}

function boundRecord(store: DecisionPublicationStore, card: DecisionCard) {
  const record = store.byCard(card.teamId, card.planId, card.id)
  if (!record || card.addressedTo !== 'owner' || card.kind !== 'question') {
    throw new DecisionRefusal('state', 'This card has no publication binding.')
  }
  const { receipt: _receipt, ...link } = record.link
  let snapshot: PublicationSnapshot
  try {
    snapshot = JSON.parse(record.snapshotJson) as PublicationSnapshot
    if (!snapshot || snapshot.version !== 1 || sha256(canonicalJson(snapshot)) !== link.bindingHash ||
        snapshot.cardId !== card.id || snapshot.teamId !== card.teamId || snapshot.planId !== card.planId ||
        snapshot.change !== card.change || snapshot.taskId !== card.taskId || snapshot.taskId !== link.taskId ||
        snapshot.handoffId !== link.handoffId || snapshot.baseRevision !== link.baseRevision ||
        snapshot.payloadHash !== link.payloadHash || snapshot.requesterSession !== card.askedBy.session) throw new Error()
  } catch {
    throw new DecisionRefusal('state', 'The publication binding snapshot is inconsistent.')
  }
  return { ...record, link, snapshot }
}

function compareFresh(service: DecisionService, plan: ReturnType<typeof teamPlan>, card: DecisionCard, bound: ReturnType<typeof boundRecord>): void {
  const reads = service.deps.publication
  if (!reads) throw new DecisionRefusal('state', 'Decision publication is unavailable.')
  const { snapshot, link } = bound
  const observed = publicationSnapshot(service.deps, reads, card.teamId, card.id, link.handoffId,
    { plan, taskId: link.taskId, change: snapshot.change })
  if (canonicalJson(observed) === canonicalJson(snapshot)) return
  const fields = ['baseRevision', 'baseContentHash', 'baseContractHash', 'approvedPlanRevision', 'approvedPlanHash', 'execution',
    'taskOwner', 'taskCreator', 'payloadHash', 'requesterSession', 'requesterGroup', 'baseCommit', 'evidenceRefs'] as const
  const field = fields.find(key => canonicalJson(snapshot[key]) !== canonicalJson(observed[key]))
  throw stalePublication(`The reviewed publication binding changed${field ? ` (${field})` : ''}.`)
}

export function reviewPublication(service: DecisionService, caller: DecisionCaller, input: PublicationReviewInput): PublicationReview {
  const { teamId } = ownerTeam(caller)
  const { deps } = service
  return deps.db.transaction((): PublicationReview => {
    const { plan, card } = scopedCard(service, teamId, input)
    const { link, snapshot, ...record } = boundRecord(new DecisionPublicationStore(deps.db), card)
    const task = deps.db.query<{ title: string }, [string, string]>('SELECT title FROM team_tasks WHERE id = ? AND team_id = ?').get(link.taskId, teamId)
    if (!task) throw new DecisionRefusal('not-found', 'The bound task was not found in this team.')
    let base: ReturnType<typeof publishedBase>
    let handoff: ReturnType<typeof preparedHandoff>
    try {
      base = publishedBase(deps, link.taskId, link.baseRevision)
      handoff = preparedHandoff(deps, teamId, link.taskId, link.handoffId)
      if (base.contentHash !== snapshot.baseContentHash || base.contractHash !== snapshot.baseContractHash ||
          handoff.baseRevision !== link.baseRevision || handoff.baseContractHash !== base.contractHash || handoff.payloadHash !== link.payloadHash ||
          handoff.requesterSession !== snapshot.requesterSession || handoff.requesterGroup !== snapshot.requesterGroup ||
          handoff.baseCommit !== snapshot.baseCommit || canonicalJson(handoff.evidenceRefs) !== canonicalJson(snapshot.evidenceRefs)) throw new Error()
    } catch {
      throw new DecisionRefusal('state', 'The exact bound handoff or published base cannot be read consistently.')
    }
    let availability: PublicationReview['availability'] = 'ready'
    let unavailableReason: string | null = null
    if (deps.decisions.decisionsOfCard(teamId, card.id).length) {
      availability = 'decided'
      unavailableReason = 'This card is already decided.'
    } else {
      try { compareFresh(service, plan, card, { ...record, link, snapshot }) } catch (error) {
        if (!(error instanceof DecisionRefusal)) throw error
        availability = 'stale'
        unavailableReason = error.message
      }
    }
    const execution = snapshot.execution
    return {
      link, planId: plan.id, change: snapshot.change, approvedPlanRevision: snapshot.approvedPlanRevision,
      execution: execution && {
        id: execution.id, revision: execution.revision, revisionSeq: execution.revisionSeq,
        changeGeneration: execution.changeGeneration, attemptId: execution.attemptId,
      },
      taskTitle: task.title, baseIdentity: base.identity, baseContentHash: base.contentHash,
      before: base.content, after: preparedContent(handoff, base.content), requester: { sessionId: handoff.requesterSession, groupId: handoff.requesterGroup },
      preparedRationale: handoff.rationale, notify: true, baseCommit: handoff.baseCommit, evidenceRefs: handoff.evidenceRefs,
      availability, unavailableReason,
    }
  })()
}

function receiptOf(service: DecisionService, store: DecisionPublicationStore, card: DecisionCard, first: PlanDecision): DecisionPublicationReceipt {
  const { db, decisions } = service.deps
  const incomplete = () => new DecisionRefusal('state', 'The recorded approval has inconsistent receipt or publication evidence.')
  let record: ReturnType<DecisionPublicationStore['byCard']>
  try { record = store.byCard(card.teamId, card.planId, card.id) } catch { throw incomplete() }
  const receipt = record?.link.receipt
  if (!record || !receipt || record.decisionId !== first.id || receipt.decisionId !== first.id ||
      receipt.commandId !== first.commandId || first.seq !== 1 || first.kind !== 'answer' ||
      first.decidedBy.kind !== 'human' || first.choice !== CHOICE || first.optionIndex !== null ||
      first.cardId !== card.id || receipt.cardId !== card.id || receipt.planId !== card.planId ||
      receiptLinkDiffers(record.link, receipt) || receipt.taskId !== card.taskId ||
      receipt.publishedRevision !== receipt.baseRevision + 1 || first.affected.length !== 1 || first.affected[0] !== receipt.taskId ||
      decisions.decisionsOfCard(card.teamId, card.id)[0]?.id !== first.id ||
      sha256(record.snapshotJson) !== receipt.bindingHash ||
      !Array.isArray(receipt.noticeMessageIds) || new Set(receipt.noticeMessageIds).size !== receipt.noticeMessageIds.length) throw incomplete()
  const key = preparedKey(receipt.handoffId)
  const row = db.query<{ request_key: string; handoff_id: string; author_kind: string; created_at: string }, [string, number, string]>(
    `SELECT r.request_key, r.handoff_id, r.author_kind, r.created_at
      FROM team_task_revisions r JOIN team_tasks t ON t.id = r.task_id
      WHERE r.task_id = ? AND r.revision = ? AND t.team_id = ?`,
  ).get(receipt.taskId, receipt.publishedRevision, card.teamId)
  if (row?.author_kind !== 'human' || row.handoff_id !== receipt.handoffId || row.request_key !== key || row.created_at !== receipt.publishedAt) throw incomplete()
  const wakeup = db.query<{ message_id: string | null }, [string]>(
    "SELECT message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? AND transition = 'published'",
  ).get(receipt.handoffId)
  if (!wakeup || wakeup.message_id !== receipt.wakeupMessageId) throw incomplete()
  for (const id of receipt.noticeMessageIds) {
    const notice = db.query(`SELECT 1 FROM team_task_notifications
      WHERE message_id = ? AND task_id = ? AND revision = ? AND request_key = ?`).get(id, receipt.taskId, receipt.publishedRevision, key)
    if (!notice) throw incomplete()
  }
  return receipt
}

function receiptLinkDiffers(link: ReturnType<typeof boundRecord>['link'], receipt: DecisionPublicationReceipt): boolean {
  return link.taskId !== receipt.taskId || link.handoffId !== receipt.handoffId || link.baseRevision !== receipt.baseRevision ||
    link.payloadHash !== receipt.payloadHash || link.bindingHash !== receipt.bindingHash
}

export async function approvePublication(service: DecisionService, caller: DecisionCaller, input: PublicationApprovalInput): Promise<PublicationOutcome> {
  const team = ownerTeam(caller)
  const { deps } = service
  const { teamId } = team
  const store = new DecisionPublicationStore(deps.db)
  const commandId = input.commandId.trim()
  if (!commandId) throw new DecisionRefusal('invalid', 'Approval needs a stable command id.')
  const rationale = rationaleOf(input.rationale, false)
  const payload = { action: APPROVE_ACTION, cardId: input.cardId, expectedHandoffId: input.expectedHandoffId, expectedBindingHash: input.expectedBindingHash, rationale }
  const recover = (): PublicationOutcome | null => {
    // Scope precedes command lookup, including after a lost or ambiguous response.
    const { card } = scopedCard(service, teamId, input)
    let prior: ReturnType<typeof deps.decisions.decisionByCommand>
    try { prior = deps.decisions.decisionByCommand(teamId, input.planId, commandId) } catch {
      throw new DecisionRefusal('state', 'The recorded decision command is inconsistent.')
    }
    if (!prior) return null
    const field = payloadDiff(prior.payload, payload, FIELDS)
    if (field) throw new DecisionRefusal('replay-mismatch', `The command id was already used with a different ${field}.`)
    const publication = receiptOf(service, store, card, prior.decision)
    if (publication.handoffId !== input.expectedHandoffId || publication.bindingHash !== input.expectedBindingHash ||
        prior.decision.rationale !== rationale) throw new DecisionRefusal('state', 'The recorded approval and receipt do not match the command.')
    return { card, decision: prior.decision, publication, replayed: true, message: null }
  }

  const fresh = () => {
    const { plan, card } = scopedCard(service, teamId, input)
    const bound = boundRecord(store, card)
    const [first] = deps.decisions.decisionsOfCard(teamId, card.id)
    if (first) service.refuseDecided(card, first)
    if (bound.link.handoffId !== input.expectedHandoffId || bound.link.bindingHash !== input.expectedBindingHash) {
      throw stalePublication('The confirmed handoff id or binding hash differs from the reviewed card.')
    }
    compareFresh(service, plan, card, bound)
    return { card, link: bound.link }
  }

  const prior = recover()
  if (prior) return prior
  const { card, link } = fresh()
  if (deps.tasks.store.db !== deps.db || deps.decisions.db !== deps.db || !deps.tasks.store.mail ||
      deps.tasks.store.mail !== deps.mailbox.store || !deps.tasks.store.notices) {
    throw new DecisionRefusal('state', 'The prepared publication and its transaction are unavailable.')
  }
  try {
    await deps.tasks.handoffs.publish({ kind: 'human', team }, link.taskId, link.handoffId, [], {
      guard: () => {
        if (recover()) throw new DecisionRefusal('state', 'The approval was already recorded.')
        fresh()
      },
      complete: (revision, ids) => {
        const decision = deps.decisions.insertDecision({
          cardId: card.id, planId: card.planId, teamId, seq: 1, kind: 'answer', choice: CHOICE, optionIndex: null,
          rationale, decidedBy: HUMAN, affected: [link.taskId], commandId, payload,
        })
        store.recordReceipt(teamId, {
          ...link, planId: card.planId, cardId: card.id, decisionId: decision.id, commandId,
          publishedRevision: revision.revision, publishedAt: revision.createdAt, ...ids,
        })
      },
    })
  } catch (error) {
    const recovered = recover()
    if (recovered) return recovered
    if (error instanceof DecisionRefusal) throw error
    // The existing prepared publisher can detect a moved base or disposition before reaching the guard.
    fresh()
    const detail = error instanceof Error ? error.message : String(error)
    throw new DecisionRefusal('state', `Publication write failed. Retry the same approval if the failure was transient. ${detail}`)
  }
  const committed = recover()
  if (!committed) {
    fresh()
    throw new DecisionRefusal('state', 'The prepared publisher returned without a combined approval receipt.')
  }
  deps.onChange?.(card.planId)
  service.decided(card, committed.decision)
  return { ...committed, replayed: false }
}

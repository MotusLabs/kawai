import type { ChatSessionRecord } from '../../db'
import type { TeamIdentity } from '../../team/teamIdentity'
import { liveRecord } from '../../team/taskHandoffFacts'
import { canonicalJson } from '../../../shared/productStrategy'
import type { DecisionCard, PublicationBindingRef } from '../../../shared/planDecisions'
import type { AskInput, DecisionServiceDeps } from './DecisionService'
import { askInput, DecisionRefusal, payloadDiff } from './decisionInputs'
import { currentOwnerRoute, publicationSnapshot, publicationTarget, sha256 } from './decisionPublicationBinding'
import { DecisionPublicationStore } from './decisionPublicationStore'

export const HANDOFF_ID = /^handoff-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const GUIDANCE = 'The owner can review and publish the exact edit from the Plans view. Read the receipt with plan_get and the prepared payload or disposition with task_get { task_id, handoff_id }. Continue other work or end your turn meanwhile.'

export interface BoundAskOutcome {
  card: DecisionCard
  message: null
  guidance: string
  publication: PublicationBindingRef
  replayed: boolean
}

export function askPublication(deps: DecisionServiceDeps, initial: Pick<ChatSessionRecord, 'sessionId' | 'projectPath'>, team: TeamIdentity, input: AskInput): BoundAskOutcome {
  const handoffId = typeof input.publication_handoff_id === 'string' ? input.publication_handoff_id.trim() : ''
  if (!HANDOFF_ID.test(handoffId)) throw new DecisionRefusal('invalid', 'publication_handoff_id must be a handoff-<uuid>.')
  const fields = askInput(input)
  const reads = deps.publication
  if (!reads) throw new DecisionRefusal('state', 'Decision publication is unavailable.')
  const store = new DecisionPublicationStore(deps.db)
  const result = deps.db.transaction(() => {
    const session = deps.getSession(initial.sessionId)
    if (!session || !liveRecord(session) || session.projectPath !== initial.projectPath) {
      throw new DecisionRefusal('forbidden', 'The asking session is no longer live in this team.')
    }
    const { teamId } = team
    const target = publicationTarget(deps, teamId, handoffId)
    const { plan, change, taskId, requesterSession } = target
    const planId = input.plan_id?.trim()
    if (planId && planId !== plan.id) throw new DecisionRefusal('forbidden', 'plan_id must match the persisted handoff target plan.')
    if (requesterSession !== session.sessionId) throw new DecisionRefusal('forbidden', 'Only the original requester can bind this handoff.')
    currentOwnerRoute(deps, plan, session.groupId ?? null)

    const prior = store.byHandoff(teamId, handoffId)
    if (prior) {
      const card = deps.decisions.card(teamId, prior.cardId)
      if (!card || card.addressedTo !== 'owner' || card.taskId !== prior.link.taskId) {
        throw new DecisionRefusal('state', 'The recorded publication binding has no consistent owner card.')
      }
      const diff = payloadDiff({ ...card, asker: card.askedBy.session }, { ...fields, planId: plan.id, asker: session.sessionId },
        ['question', 'options', 'context', 'planId', 'asker'])
      if (diff) throw new DecisionRefusal('replay-mismatch', `This handoff is already bound with a different ${diff}.`)
      return { card, publication: prior.link, replayed: true }
    }
    const id = `card-${crypto.randomUUID()}`
    const snapshot = publicationSnapshot(deps, reads, teamId, id, handoffId, target)
    const card = deps.decisions.insertCard({
      ...fields, id, teamId, planId: plan.id, revision: snapshot.execution?.revision ?? snapshot.approvedPlanRevision,
      change, taskId, askedBy: { session: session.sessionId, group: session.groupId ?? null, profile: session.claudeProfileId ?? 'default' },
      addressedTo: 'owner', addressedGroup: null, messageId: null,
    })
    const publication = store.insert(snapshot, sha256(canonicalJson(snapshot)))
    return { card, publication, replayed: false }
  }).immediate()
  if (!result.replayed) deps.onChange?.(result.card.planId)
  return { ...result, message: null, guidance: GUIDANCE }
}

// The publication-handoff attention source (owner-publication-handoff D8,
// Table W). A pending handoff waits on `pendingHandoffActor`'s next actor:
// an `open` one on its publisher — the task's live agent owner (W1), else
// the human (W2) — and a `stale` one on its requester side (W3, W4). A
// published handoff yields a `publication-follow-up` item per
// `handoffPhase` (W5–W12d), none once the task is closed or the claimant
// acknowledged; an ended handoff yields nothing (W13). Pure over its facts;
// `handoffAttentionFacts` gathers them from the manager for the workspace
// read.
import { attentionItemId, type AttentionItem, type AttentionOwner } from '../../shared/teamWorkspace'
import {
  handoffPhase, pendingHandoffActor, type HandoffFollowUpFacts, type HandoffNextActor, type HandoffPhase, type TaskHandoff,
} from '../../shared/taskHandoffs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { followUpFacts } from './taskHandoffFacts'
import { taskOwner } from './taskStatusRights'

export interface HandoffAttentionFact {
  handoff: TaskHandoff
  taskTitle: string
  requesterName: string
  /** The task's live agent owner, or null when it has none or it is gone (archived, exhausted, missing). */
  liveOwner: { sessionId: string; name: string } | null
  /** Whether the requester session is live; a stale handoff's next actor reads it (W3/W4). */
  requesterLive: boolean
}

export interface HandoffFollowUpFact {
  handoff: TaskHandoff
  taskTitle: string
  facts: HandoffFollowUpFacts
  /** A running execution owns the task, so Kawai dispatches its next holder (W7). */
  executionOwns: boolean
  nameOf: (sessionId: string) => string
}

export const PUBLISH_PREPARED_ACTION = 'Publish prepared revision'
export const REPREPARE_ACTION = 'Re-prepare or withdraw'

const human: AttentionOwner = { kind: 'human', id: null, label: 'Human' }
const kawai: AttentionOwner = { kind: 'kawai', id: null, label: 'Kawai' }

function pendingOwner(actor: HandoffNextActor, fact: HandoffAttentionFact): AttentionOwner {
  switch (actor.kind) {
    case 'owner': return { kind: 'session', id: actor.sessionId, label: fact.liveOwner?.name ?? actor.sessionId }
    case 'requester': return { kind: 'session', id: actor.sessionId, label: fact.requesterName }
    case 'requester-group': return { kind: 'group', id: actor.group, label: actor.group }
    case 'human': return human
  }
}

/** W1–W4: one `publication-handoff` item per pending handoff. */
export function handoffAttentionItems(facts: readonly HandoffAttentionFact[]): AttentionItem[] {
  return facts.flatMap(fact => {
    const { handoff, taskTitle, requesterName } = fact
    if (handoff.state !== 'open' && handoff.state !== 'stale') return []
    const actor = pendingHandoffActor(handoff, fact.liveOwner?.sessionId ?? null, fact.requesterLive)
    const stale = handoff.state === 'stale'
    return [{
      id: attentionItemId('publication-handoff', handoff.id),
      kind: 'publication-handoff',
      cause: stale
        ? `Prepared revision on revision ${handoff.baseRevision} went stale: the task moved past its base (requested by ${requesterName})`
        : `Prepared revision on revision ${handoff.baseRevision} awaits publication (requested by ${requesterName})`,
      owner: pendingOwner(actor, fact),
      impact: { taskId: handoff.taskId, taskTitle },
      nextAction: !stale ? PUBLISH_PREPARED_ACTION : actor.kind === 'human' ? 'Decline' : REPREPARE_ACTION,
      link: { kind: 'task' as const, id: handoff.taskId, handoffId: handoff.id },
      requiresHuman: actor.kind === 'human',
    }]
  })
}

/** W7–W12d's owner, next action and link for a phase that keeps an item; null for W5/W6. */
function followUp(phase: HandoffPhase, fact: HandoffFollowUpFact): Pick<AttentionItem, 'owner' | 'nextAction' | 'requiresHuman' | 'cause'> & { messageId?: string } | null {
  const { facts, nameOf } = fact
  const revision = facts.publishedRevision
  const holder = facts.claimant
  const holderOwner = (): AttentionOwner => ({ kind: 'session', id: holder!.sessionId, label: nameOf(holder!.sessionId) })
  switch (phase) {
    case 'task-closed':
    case 'acknowledged':
      return null
    case 'no-holder':
      return fact.executionOwns
        ? { owner: kawai, nextAction: 'Wait for Kawai', requiresHuman: false, cause: `Revision ${revision} was published; Kawai dispatches its next holder` }
        : { owner: human, nextAction: 'Hand off the task', requiresHuman: true, cause: `Revision ${revision} was published; no live session holds the task` }
    case 'delivered-awaiting-ack':
      return {
        owner: holderOwner(), nextAction: 'Wait for acknowledgement', requiresHuman: false,
        cause: `Revision ${revision} delivered to ${nameOf(holder!.sessionId)} (delivered revision ${facts.deliveredRevision}, acknowledged ${facts.acknowledgedRevision ?? 'none'})`,
      }
    case 'notice-uncertain':
      return {
        owner: human, nextAction: 'Resolve in the Mailbox (Retry or Discard)', requiresHuman: true,
        cause: `The notice of revision ${revision} to ${nameOf(holder!.sessionId)} has an uncertain delivery`,
        messageId: facts.notices.find(notice => notice.state === 'uncertain')!.messageId,
      }
    case 'notice-queued':
      return { owner: holderOwner(), nextAction: 'Wait for acknowledgement', requiresHuman: false, cause: `The notice of revision ${revision} to ${nameOf(holder!.sessionId)} is queued` }
    case 'notice-failed':
      return { owner: human, nextAction: 'Retry notification', requiresHuman: true, cause: `The notice of revision ${revision} to ${nameOf(holder!.sessionId)} was not delivered` }
    case 'not-notified':
      return { owner: human, nextAction: 'Notify', requiresHuman: true, cause: `Revision ${revision} was published without notifying ${nameOf(holder!.sessionId)}` }
  }
}

/** W5–W12d: one `publication-follow-up` item per published handoff whose phase keeps one. */
export function handoffFollowUpItems(facts: readonly HandoffFollowUpFact[]): AttentionItem[] {
  return facts.flatMap(fact => {
    if (fact.handoff.state !== 'published') return []
    const item = followUp(handoffPhase(fact.facts), fact)
    if (item === null) return []
    const { messageId, ...shown } = item
    return [{
      id: attentionItemId('publication-follow-up', fact.handoff.id),
      kind: 'publication-follow-up',
      ...shown,
      impact: { taskId: fact.handoff.taskId, taskTitle: fact.taskTitle },
      // W9 links the uncertain message (the Mailbox's Retry/Discard); the rest the task's handoff.
      link: messageId ? { kind: 'message' as const, id: messageId } : { kind: 'task' as const, id: fact.handoff.taskId, handoffId: fact.handoff.id },
    }]
  })
}

/** The workspace read's handoff facts: pending handoffs with their parties' liveness, and published ones of open tasks. */
export function handoffAttentionFacts(manager: ChatSessionManager, teamId: string, nameOf: (sessionId: string) => string): {
  handoffs: HandoffAttentionFact[]; handoffFollowUps: HandoffFollowUpFact[]
} {
  const { store, handoffs: service } = manager.tasks
  const titleOf = (taskId: string) => store.get(taskId)?.title ?? taskId
  const handoffs = service.store.pendingForTeam(teamId).map(handoff => {
    const ownerId = taskOwner(store.get(handoff.taskId)!)
    return {
      handoff, taskTitle: titleOf(handoff.taskId), requesterName: nameOf(handoff.requesterSession),
      liveOwner: ownerId && service.live(ownerId) ? { sessionId: ownerId, name: nameOf(ownerId) } : null,
      requesterLive: service.live(handoff.requesterSession),
    }
  })
  const notices = store.notices
  const handoffFollowUps = !notices ? [] : service.store.publishedOfOpenTasks(teamId).map(handoff => ({
    handoff, taskTitle: titleOf(handoff.taskId), nameOf,
    facts: followUpFacts({ db: store.db, mail: store.mail!, notices, acknowledgements: store.acknowledgements, live: service.live }, handoff, store.get(handoff.taskId)!),
    executionOwns: manager.results?.ownedByExecution(handoff.taskId) === true,
  }))
  return { handoffs, handoffFollowUps }
}

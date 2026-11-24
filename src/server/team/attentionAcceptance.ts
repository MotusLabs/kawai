// The attention source for submitted results awaiting acceptance
// (attention-acceptance-ownership). Who has to act depends on two facts the
// stores already hold: whether the newest findings on the result fail (the
// work goes back to its submitter), and who closes the task (the human, or the
// live agent session that created it). A task a running execution owns is a
// source only for failing findings: WorkspaceRead leaves its acceptance out,
// because Kawai accepts it on landing. A failing result's owner follows
// owner-publication-handoff Table F: its live submitter, else the live
// claimant, else Kawai for an execution-owned task, else the task's live
// agent owner, else the human (`fixesOwner`).
import { attentionItemId, type AttentionItem } from '../../shared/teamWorkspace'
import type { AttentionInput, AttentionSource } from './workspaceRead'

/** A submitted, unaccepted outstanding result of a live task. */
export interface PendingAcceptance {
  resultId: string
  taskId: string
  /** Who submitted it, already labelled: the session's name, or "Human". */
  submitter: string
  /** The submitting agent session; null when the human submitted it. */
  submitterId: string | null
  needsReevaluation: boolean
  /** The verdict of the newest findings bound to the result; null without findings. */
  reviewVerdict: 'pass' | 'fail' | null
  /** The task's owner (group-mail-task-affinity D7; the creating agent unless transferred) when it is a live (present, not archived) agent session; null otherwise. */
  liveCreator: { sessionId: string; name: string } | null
  /** Table F's facts for failing findings; absent, the submitter owns the wait (F1). */
  fixes?: FixesFacts
}

/** Table F's liveness facts, each read with the handoff liveness predicate (live: present, not archived, not exhausted). */
export interface FixesFacts {
  submitterLive: boolean
  /** The outstanding assignment's live claimant. */
  liveClaimant: { sessionId: string; name: string } | null
  executionOwns: boolean
  /** The task's live agent owner. */
  liveOwner: { sessionId: string; name: string } | null
}

/** F1–F5: who owns a failing result's wait for fixes, and what they do next. */
export function fixesOwner(pending: Pick<PendingAcceptance, 'submitter' | 'submitterId' | 'fixes'>): Pick<AttentionItem, 'owner' | 'nextAction' | 'requiresHuman' | 'cause'> {
  const reviewed = `Review of the result submitted by ${pending.submitter} requested fixes`
  const facts = pending.fixes
  // F1: a live submitter (the human submitter is always present).
  if (pending.submitterId === null || !facts || facts.submitterLive) {
    return {
      owner: pending.submitterId
        ? { kind: 'session', id: pending.submitterId, label: pending.submitter }
        : { kind: 'human', id: null, label: pending.submitter },
      nextAction: 'Wait for fixes', requiresHuman: false, cause: reviewed,
    }
  }
  const archived = `${reviewed}; the submitter ${pending.submitter} is archived`
  if (facts.liveClaimant) {
    return { owner: { kind: 'session', id: facts.liveClaimant.sessionId, label: facts.liveClaimant.name }, nextAction: 'Wait for fixes', requiresHuman: false, cause: archived }
  }
  const unheld = `${archived} and no session is running the task`
  if (facts.executionOwns) return { owner: { kind: 'kawai', id: null, label: 'Kawai' }, nextAction: 'Wait for Kawai to dispatch the fix', requiresHuman: false, cause: unheld }
  if (facts.liveOwner) {
    return { owner: { kind: 'session', id: facts.liveOwner.sessionId, label: facts.liveOwner.name }, nextAction: 'Hand off for fixes', requiresHuman: false, cause: unheld }
  }
  return { owner: { kind: 'human', id: null, label: 'Human' }, nextAction: 'Hand off for fixes', requiresHuman: true, cause: unheld }
}

/** The task scope an item carries: the id, plus the title when it is known. */
export const taskImpact = (taskId: string | null, taskTitle: (taskId: string) => string | null) => {
  if (!taskId) return {}
  const title = taskTitle(taskId)
  return title === null ? { taskId } : { taskId, taskTitle: title }
}

/**
 * Failing findings are an agent-owned wait for fixes, owned by the result's
 * submitter. Otherwise a pending acceptance is agent-owned when a live agent
 * session created the task, and human-required for a human-created task or a
 * creator that is archived or killed.
 */
export const acceptanceItems: AttentionSource = ({ pendingAcceptance, taskTitle }: AttentionInput) =>
  pendingAcceptance.map(pending => {
    const impact = taskImpact(pending.taskId, taskTitle)
    const link = { kind: 'task' as const, id: pending.taskId }
    if (pending.reviewVerdict === 'fail') {
      return {
        id: attentionItemId('fixes-requested', pending.resultId),
        kind: 'fixes-requested' as const,
        ...fixesOwner(pending),
        impact,
        link,
      }
    }
    const creator = pending.liveCreator
    return {
      id: attentionItemId('pending-acceptance', pending.resultId),
      kind: 'pending-acceptance' as const,
      cause: creator
        ? `Result submitted by ${pending.submitter} awaits acceptance by ${creator.name}${pending.needsReevaluation ? ' (needs re-evaluation)' : ''}`
        : `Result submitted by ${pending.submitter} awaits acceptance${pending.needsReevaluation ? ' (needs re-evaluation)' : ''}`,
      owner: creator
        ? { kind: 'session' as const, id: creator.sessionId, label: creator.name }
        : { kind: 'human' as const, id: null, label: 'Human' },
      impact,
      nextAction: 'Accept result',
      link,
      requiresHuman: creator === null,
    }
  })

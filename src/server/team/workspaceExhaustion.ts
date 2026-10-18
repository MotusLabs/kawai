// The attention source for context-exhausted sessions (chat-context-exhaustion
// D8): one item per recorded episode, identified by `<sessionId>:<flaggedAt>`
// so a later episode is a new identity and toasts again. Owned by the note's
// recipient (waiting on agents) when a note went out, else by the human. The
// item resolves — derived at read time, nothing stored — once a newer
// dispatch on the task is made, the task closes, the dropped message is
// retried or discarded, the session's flag clears (or names a later
// episode), or the session is killed.
import { attentionItemId, type AttentionItem } from '../../shared/teamWorkspace'
import { taskImpact } from './attentionAcceptance'
import type { ExhaustionEpisode } from './exhaustionNotes'

/** One episode with the facts its resolution reads, gathered by the manager-facing read. */
export interface ExhaustionFact {
  episode: ExhaustionEpisode
  /** The session's name; null once it is killed (no record). */
  sessionName: string | null
  /** The flag time the session's record holds now; null when it is not flagged. */
  currentFlagAt: string | null
  /** The dropped message's state now; null without one (or once it is gone). */
  droppedState: string | null
  /** The task's status now; null without a task. */
  taskStatus: string | null
  /** The newest assignment's creation time on the task; null without one. */
  newestDispatchAt: string | null
}

/** Whether an episode still needs a decision (D8's resolution rules). */
export function exhaustionOpen(fact: ExhaustionFact): boolean {
  const { episode } = fact
  if (fact.sessionName === null) return false
  if (fact.currentFlagAt !== episode.flaggedAt) return false
  if (fact.taskStatus === 'done' || fact.taskStatus === 'cancelled') return false
  if (fact.newestDispatchAt !== null && fact.newestDispatchAt > episode.flaggedAt) return false
  if (episode.droppedId !== null && fact.droppedState !== null && fact.droppedState !== 'dead') return false
  return true
}

export function exhaustionAttentionItems(
  facts: ExhaustionFact[],
  taskTitle: (taskId: string) => string | null,
  nameOf: (sessionId: string) => string,
): AttentionItem[] {
  return facts.filter(exhaustionOpen).map(fact => {
    const { episode } = fact
    const noted = episode.noteId !== null && episode.recipientSession !== null
    return {
      id: attentionItemId('context-exhausted', `${episode.sessionId}:${episode.flaggedAt}`),
      kind: 'context-exhausted',
      cause: `${fact.sessionName} stopped: context exhausted (${episode.reason})` +
        (episode.droppedId ? `; dropped message ${episode.droppedId.slice(0, 8)}` : ''),
      owner: noted
        ? { kind: 'session' as const, id: episode.recipientSession, label: nameOf(episode.recipientSession as string) }
        : { kind: 'human' as const, id: null, label: 'Human' },
      impact: taskImpact(episode.taskId, taskTitle),
      nextAction: noted ? 'Wait for a dispatch decision' : 'Compact, redispatch, or kill',
      link: episode.droppedId
        ? { kind: 'message' as const, id: episode.droppedId }
        : { kind: 'chat' as const, id: episode.sessionId },
      requiresHuman: !noted,
    }
  })
}

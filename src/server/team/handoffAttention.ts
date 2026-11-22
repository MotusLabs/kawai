// The publication-handoff attention source (owner-publication-handoff D8,
// Table W). An `open` handoff waits on its publisher: the task's live agent
// owner (W1), else the human (W2) when the task has no owner or the owner
// is gone. The item clears when the handoff leaves `open`. Pure over its
// facts: the workspace read resolves the owner's liveness.
import { attentionItemId, type AttentionItem } from '../../shared/teamWorkspace'
import type { TaskHandoff } from '../../shared/taskHandoffs'

export interface HandoffAttentionFact {
  handoff: TaskHandoff
  taskTitle: string
  requesterName: string
  /** The task's live agent owner, or null when it has none or it is gone (archived, exhausted, missing). */
  liveOwner: { sessionId: string; name: string } | null
}

export const PUBLISH_PREPARED_ACTION = 'Publish prepared revision'

export function handoffAttentionItems(facts: readonly HandoffAttentionFact[]): AttentionItem[] {
  return facts.flatMap(({ handoff, taskTitle, requesterName, liveOwner }) => {
    if (handoff.state !== 'open') return []
    return [{
      id: attentionItemId('publication-handoff', handoff.id),
      kind: 'publication-handoff',
      cause: `Prepared revision on revision ${handoff.baseRevision} awaits publication (requested by ${requesterName})`,
      owner: liveOwner
        ? { kind: 'session' as const, id: liveOwner.sessionId, label: liveOwner.name }
        : { kind: 'human' as const, id: null, label: 'Human' },
      impact: { taskId: handoff.taskId, taskTitle },
      nextAction: PUBLISH_PREPARED_ACTION,
      link: { kind: 'task' as const, id: handoff.taskId, handoffId: handoff.id },
      requiresHuman: liveOwner === null,
    }]
  })
}

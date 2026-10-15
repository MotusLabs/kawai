// The attention queue (team-workspace D5/D6/D11): what needs the human, then
// what agents are waiting on, from the workspace snapshot. Items render from
// one shape — an unrecognized kind shows its raw kind with the same cause,
// owner, impact, and next action, never dropped. The next action is a link to
// where the existing action lives; this view writes nothing. State words are
// text, not color: the section titles and the owner's kind carry them.
import type { AttentionItem } from '@shared/teamWorkspace'
import { attentionCounts } from '../../stores/teamWorkspaceDataStore'
import { attentionLinkLabel } from './attentionLinks'

const KIND_LABELS: Record<string, string> = {
  approval: 'Approval',
  question: 'Question',
  'uncertain-delivery': 'Uncertain delivery',
  'staffing-wait': 'Staffing wait',
  'pending-acceptance': 'Pending acceptance',
}

/** A known kind's label; an unrecognized kind reads as itself. */
export const attentionKindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

function impactLabel(item: AttentionItem): string {
  const { taskTitle, taskId, worktree, groupId } = item.impact
  return [
    taskTitle || taskId ? `Task ${taskTitle ?? taskId}` : null,
    worktree ? `Worktree ${basename(worktree)}` : null,
    groupId ? `Group ${groupId}` : null,
  ].filter(Boolean).join(' · ')
}

function Item({ item, onOpen }: { item: AttentionItem; onOpen: (item: AttentionItem) => void }) {
  const impact = impactLabel(item)
  return <li className="border border-border p-2" data-testid="attention-item" data-item-id={item.id} data-kind={item.kind}>
    <p className="text-chat-meta text-secondary">
      <span data-testid="attention-kind">{attentionKindLabel(item.kind)}</span> · owner: {item.owner.label}
      {impact && <> · <span data-testid="attention-impact">{impact}</span></>}
    </p>
    <p className="text-chat-body" data-testid="attention-cause">{item.cause}</p>
    <button type="button" className="btn mt-1 text-chat-meta" data-testid="attention-action"
      aria-label={`${item.nextAction} — ${attentionLinkLabel(item.link)}: ${item.cause}`}
      onClick={() => onOpen(item)}>
      {item.nextAction}
    </button>
  </li>
}

export default function TeamAttentionQueue({ items, loaded, onOpen }: {
  items: readonly AttentionItem[]
  /** False until the first snapshot arrives, so loading is not read as empty. */
  loaded: boolean
  onOpen: (item: AttentionItem) => void
}) {
  const counts = attentionCounts(items)
  const human = items.filter(item => item.requiresHuman)
  const agent = items.filter(item => !item.requiresHuman)
  return <section aria-label="Attention queue" data-testid="team-attention-queue">
    <h3 className="font-medium" data-testid="attention-summary">
      Attention · {loaded ? `${counts.human} need you · ${counts.agent} waiting on agents` : 'loading…'}
    </h3>
    {loaded && items.length === 0 && <p className="text-chat-meta text-secondary" data-testid="attention-empty">Nothing needs attention.</p>}
    {human.length > 0 && <div data-testid="attention-human">
      <h4 className="mt-1 text-chat-meta font-medium">Needs you ({human.length})</h4>
      <ul className="mt-1 space-y-1">{human.map(item => <Item key={item.id} item={item} onOpen={onOpen} />)}</ul>
    </div>}
    {agent.length > 0 && <div data-testid="attention-agent">
      <h4 className="mt-1 text-chat-meta font-medium">Waiting on agents ({agent.length})</h4>
      <ul className="mt-1 space-y-1">{agent.map(item => <Item key={item.id} item={item} onOpen={onOpen} />)}</ul>
    </div>}
  </section>
}

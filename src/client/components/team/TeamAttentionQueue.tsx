// The attention queue (team-workspace D5/D6/D11): what needs the human, then
// what agents are waiting on, from the workspace snapshot. Items render from
// one shape — an unrecognized kind shows its raw kind with the same cause,
// owner, impact, and next action, never dropped. The next action is a link to
// where the existing action lives; this view writes nothing. State words are
// text, not color: the section titles and the owner's kind carry them.
import { useEffect, useRef } from 'react'
import type { AttentionItem } from '@shared/teamWorkspace'
import { attentionCounts } from '../../stores/teamWorkspaceDataStore'
import { attentionLinkLabel } from './attentionLinks'

const KIND_LABELS: Record<string, string> = {
  approval: 'Approval',
  question: 'Question',
  'uncertain-delivery': 'Uncertain delivery',
  'staffing-wait': 'Staffing wait',
  'pending-acceptance': 'Pending acceptance',
  'fixes-requested': 'Fixes requested',
  'outbound-violation': 'Outbound violation',
  'context-exhausted': 'Context exhausted',
  'plan-stop': 'Plan stop',
  'plan-stall': 'Plan stall',
  'decision-question': 'Decision question',
  'plan-fix': 'Plan fix',
  'plan-condition': 'Plan condition',
  'plan-promotion': 'Plan promotion',
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

/**
 * Where keyboard focus goes when the focused item leaves the queue (it was
 * resolved): the item now at its place (the next one, or the last), else
 * null — the queue heading. Null also when the focused item is still listed.
 */
export function focusAfterRemoval(previous: readonly string[], current: readonly string[], focusedId: string | null): string | null {
  if (focusedId === null || current.includes(focusedId)) return null
  const index = previous.indexOf(focusedId)
  if (index < 0 || current.length === 0) return null
  return current[Math.min(index, current.length - 1)] ?? null
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
      {item.nextAction}<span className="text-secondary"> · {attentionLinkLabel(item.link)}</span>
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
  const heading = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLElement>(null)
  const order = useRef<string[]>([])
  const focused = useRef<string | null>(null)
  // A resolved item takes its focused button with it: hand focus to the item
  // now in its place, else to the heading, so a keyboard user is not dropped
  // to the page start (8.2).
  useEffect(() => {
    const ids = [...items.filter(item => item.requiresHuman), ...items.filter(item => !item.requiresHuman)].map(item => item.id)
    const next = focusAfterRemoval(order.current, ids, focused.current)
    if (focused.current !== null && !ids.includes(focused.current)) {
      const target = next === null ? heading.current
        : root.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(next)}"] button`) ?? heading.current
      target?.focus()
      focused.current = next
    }
    order.current = ids
  }, [items])
  const human = items.filter(item => item.requiresHuman)
  const agent = items.filter(item => !item.requiresHuman)
  return <section ref={root} aria-label="Attention queue" data-testid="team-attention-queue"
    onFocus={event => { focused.current = event.target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ?? focused.current }}>
    <h3 ref={heading} tabIndex={-1} className="font-medium" data-testid="attention-summary" role="status" aria-live="polite">
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

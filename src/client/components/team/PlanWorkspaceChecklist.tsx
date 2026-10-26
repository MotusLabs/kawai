// One change's read-only checklist (plan-workspace 5.2, design D3): the
// canonical tasks artifact's headings and items in source order, with their
// checked states and source lines. A projection, never Kawai tasks — no
// assignment, no editing, and the explicit unavailable states instead of
// fabricated items or a zero completion.
import type { WorkspaceChecklist, WorkspaceChecklistUnavailable } from '@shared/planWorkspace'

export type ComposedChecklist = { checklist: WorkspaceChecklist | null; unavailable: WorkspaceChecklistUnavailable | null }

const UNAVAILABLE_LABELS: Record<WorkspaceChecklistUnavailable['state'], string> = {
  missing: 'No canonical source found for this change.',
  'missing-in-worktree': 'The convention worktree exists but does not contain this change.',
  ambiguous: 'More than one archive entry matches this change.',
  'cli-unavailable': 'The OpenSpec CLI could not list this change.',
  unreadable: 'The tasks artifact exists but could not be read as a checklist.',
}

export default function PlanWorkspaceChecklist({ change, composed }: {
  change: string
  /** null while the subscription has not answered yet. */
  composed: ComposedChecklist | null
}) {
  if (composed === null) {
    return <p role="status" data-testid={`wbs-checklist-loading-${change}`} className="text-chat-meta text-secondary">Loading checklist…</p>
  }
  if (composed.unavailable !== null) {
    return <p role="note" data-testid={`wbs-checklist-unavailable-${change}`}
      className="text-chat-meta text-approval">
      {UNAVAILABLE_LABELS[composed.unavailable.state] ?? composed.unavailable.state} {composed.unavailable.message}
    </p>
  }
  const checklist = composed.checklist
  if (checklist === null || checklist.sections.length === 0) {
    return <p data-testid={`wbs-checklist-empty-${change}`} className="text-chat-meta text-secondary">No checklist items in the tasks artifact.</p>
  }
  return <div data-testid={`wbs-checklist-${change}`} className="border border-border p-2 text-chat-body">
    <p className="text-chat-meta text-secondary" title={`Source hash ${checklist.sourceHash}`}>tasks.md · read-only</p>
    {checklist.sections.map((section, sectionIndex) => <div key={sectionIndex} className="mt-1">
      <p className={`font-medium ${section.depth <= 2 ? '' : 'text-chat-meta'}`} data-testid={`wbs-checklist-heading-${change}-${sectionIndex}`}>
        {section.heading}
      </p>
      <ul className="ml-4 list-none space-y-0.5">
        {section.items.map(item => (
          <li key={item.key} data-testid={`wbs-item-${change}`} data-checked={item.checked || undefined}
            style={{ marginLeft: `${((item.depth ?? 1) - 1) * 1.25}em` }}>
            <span aria-hidden>{item.checked ? '[x]' : '[ ]'}</span> {item.text}
            <span className="ml-1 text-chat-meta text-secondary" title={`Line ${item.line}`}>L{item.line}</span>
          </li>
        ))}
      </ul>
    </div>)}
  </div>
}

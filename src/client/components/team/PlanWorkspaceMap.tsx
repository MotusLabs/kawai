// The dependency workspace's map (plan-workspace 5.2, design D2): a
// deterministic WBS table whose rows follow plan order and whose column
// follows dependency depth, with the change's edges, holders, checklist
// totals, and execution state — each a separate fact beside the others.
// Checklists expand beneath their change as read-only rows and never create
// execution nodes. Invalid dependency data renders the layout's diagnostic
// fallback instead of looping. A visible text list of prerequisites and
// dependents gives keyboard and screen-reader users the same facts.
import type { PlanContent } from '@shared/plans'
import type { WorkspaceRuntimeChange, WorkspaceRuntimeState, WorkspaceRuntimeView } from '@shared/planWorkspaceRuntime'
import type { PlanWorkspaceView, WorkspaceFilter } from '../../stores/teamPlanWorkspaceStore'
import { changeMatchesFilter, wbsLayout } from '../../utils/planWorkspaceMap'
import PlanWorkspaceChecklist from './PlanWorkspaceChecklist'

export const WORKSPACE_STATE_LABELS: Record<WorkspaceRuntimeState['kind'], string> = {
  'no-execution': 'No execution',
  'not-overlaid': 'Not in the execution',
  landed: 'Landed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
  'not-started': 'Not started',
  stalled: 'Stalled',
  'in-review': 'In review',
  'ready-for-qa': 'Ready for QA',
  'fixes-requested': 'Fixes requested',
  waiting: 'Waiting',
  implementing: 'Implementing',
}

export default function PlanWorkspaceMap({ content, runtime, view, onToggleExpanded, onSelectChange, onSetFilter }: {
  content: PlanContent
  runtime: WorkspaceRuntimeView | null
  view: PlanWorkspaceView
  onToggleExpanded: (change: string) => void
  onSelectChange: (change: string) => void
  onSetFilter: (filter: WorkspaceFilter) => void
}) {
  const layout = wbsLayout(content)
  const stateOf = (change: string): WorkspaceRuntimeChange | null =>
    runtime?.changes.find(row => row.change === change) ?? null
  const visible = layout.rows.filter(row => changeMatchesFilter(stateOf(row.change)?.state ?? null, view.filter))
  return <section data-testid="plan-workspace-map" aria-label="Work breakdown and dependencies" className="mt-3">
    <h4 className="font-medium">Work breakdown</h4>
    <div role="group" aria-label="Filter changes" className="mt-1 flex gap-1" data-testid="wbs-filters">
      {(['all', 'active', 'blocked'] as const).map(option => (
        <button key={option} type="button" aria-pressed={view.filter === option}
          data-testid={`wbs-filter-${option}`}
          className={`btn text-xs ${view.filter === option ? 'btn-primary' : ''}`}
          onClick={() => onSetFilter(option)}>
          {option === 'all' ? 'All' : option === 'active' ? 'Active' : 'Blocked'}
        </button>
      ))}
    </div>
    {layout.kind === 'fallback' && <p role="note" data-testid="wbs-fallback" className="mt-2 border border-border p-2 text-chat-meta text-approval">
      Dependency data is invalid, so the map shows a flat list. Unresolved: {layout.unresolved.join(', ')}.
      {layout.cyclePath !== null && ` Cycle: ${layout.cyclePath.join(' → ')} → ${layout.cyclePath[0]}`}
    </p>}
    <ul className="mt-2 space-y-1" data-testid="wbs-rows" aria-label="Changes by dependency depth">
      {visible.map(row => {
        const change = stateOf(row.change)
        const expanded = view.expanded.includes(row.change)
        const selected = view.selectedChange === row.change
        return <li key={row.change}>
          <div data-testid={`wbs-row-${row.change}`} data-depth={row.depth} data-selected={selected || undefined}
            className="flex flex-wrap items-baseline gap-x-2 border border-border p-1.5"
            style={{ marginLeft: `${row.depth * 1.5}em` }}>
            <button type="button" aria-expanded={expanded} data-testid={`wbs-expand-${row.change}`}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} checklist of ${row.change}`}
              className="btn px-1 py-0 text-xs" onClick={() => onToggleExpanded(row.change)}>
              {expanded ? '▾' : '▸'}
            </button>
            <button type="button" className={`text-left font-medium ${selected ? 'underline' : ''}`}
              data-testid={`wbs-select-${row.change}`} onClick={() => onSelectChange(row.change)}>
              {row.change}
            </button>
            {row.dependsOn.map(dependency => (
              <span key={dependency} aria-hidden data-testid={`wbs-edge-${dependency}-${row.change}`}
                className="text-chat-meta text-secondary">└─ {dependency}</span>
            ))}
            {change && <span className="text-chat-meta" data-testid={`wbs-state-${row.change}`}>{stateLabel(change.state)}</span>}
            {change?.modifiedSinceExecution && <span className="text-chat-meta text-approval" data-testid={`wbs-modified-${row.change}`}
              title="The displayed definition differs from the one the execution runs.">modified since execution</span>}
            {change?.checklist && <span className="text-chat-meta text-secondary" data-testid={`wbs-checklist-count-${row.change}`}>
              {change.checklist.checked}/{change.checklist.total} items
            </span>}
            <HolderList holders={change?.holders ?? []} />
          </div>
          {change && change.history.length > 0 && <p className="ml-[1.5em] text-chat-meta text-secondary" data-testid={`wbs-history-${row.change}`}
            style={{ marginLeft: `${(row.depth + 1) * 1.5}em` }}>
            Earlier: {change.history.map(entry => `${entry.name ?? entry.sessionId} (${entry.stage ?? 'unknown stage'})`).join(', ')}
          </p>}
          {expanded && <div style={{ marginLeft: `${(row.depth + 1) * 1.5}em` }} className="mt-1">
            <PlanWorkspaceChecklist change={row.change} composed={view.checklists[row.change] ?? null} />
          </div>}
        </li>
      })}
    </ul>
    <TextAlternative rows={layout.rows} />
  </section>
}

function stateLabel(state: WorkspaceRuntimeState): string {
  const base = WORKSPACE_STATE_LABELS[state.kind]
  if (state.kind === 'stopped') return `${base} (${state.reason})`
  if (state.kind === 'waiting') return `${base}: ${state.cause}`
  if (state.kind === 'stalled') return `${base} (${state.stall})`
  if (state.kind === 'in-review') return state.reviewer !== null ? `${base} · ${state.reviewer}` : base
  if (state.kind === 'implementing' && state.stage !== null) return `${base} · ${state.stage}`
  return base
}

function HolderList({ holders }: { holders: WorkspaceRuntimeChange['holders'] }) {
  if (holders.length === 0) return null
  return <span className="text-chat-meta" data-testid="wbs-holders">
    {holders.map(holder => holderLabel(holder.holder)).join(', ')}
  </span>
}

function holderLabel(holder: WorkspaceRuntimeChange['holders'][number]['holder']): string {
  if (holder.kind === 'session') return holder.name ?? holder.sessionId
  if (holder.kind === 'group-unclaimed') return `${holder.groupId} (unclaimed)`
  return `${holder.name ?? holder.sessionId} (unclaimed)`
}

/** The same facts as text (design D2): prerequisites and dependents per change, in plan order. */
function TextAlternative({ rows }: { rows: ReturnType<typeof wbsLayout>['rows'] }) {
  return <div data-testid="wbs-text" className="mt-2 text-chat-meta text-secondary">
    <h5 className="font-medium text-primary">Dependencies (text)</h5>
    <ul className="mt-1 space-y-0.5">
      {rows.map(row => <li key={row.change} data-testid={`wbs-text-${row.change}`}>
        {row.change}: {row.dependsOn.length > 0 ? `prerequisites ${row.dependsOn.join(', ')}` : 'no prerequisites'}
        {row.dependents.length > 0 ? `; dependents ${row.dependents.join(', ')}` : ''}
      </li>)}
    </ul>
  </div>
}

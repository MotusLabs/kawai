// The Tasks tab's filters (team-workspace spec "Task rows can be filtered"):
// status, awaiting human, awaiting acceptance, group, and worktree. The values
// live per team in `teamWorkspaceStore` (tab `tasks`, `filters`), so they
// survive opening a task and coming back. Closed tasks stay out of the default
// list unless the Status filter names them or a search is active. Pure
// helpers map the stored record to the shared `TeamTaskRowQuery`.
import type { TaskStatus } from '@shared/teamTasks'
import type { TeamTaskRow, TeamTaskRowQuery } from '@shared/teamWorkspace'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'

const STATUSES: TaskStatus[] = ['open', 'active', 'blocked', 'done', 'cancelled']
const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/** The stored filter record as the shared row query. */
export function queryFromFilters(filters: Record<string, string | boolean>): TeamTaskRowQuery {
  const status = filters.status
  const group = filters.group
  const worktree = filters.worktree
  return {
    ...(typeof status === 'string' && STATUSES.includes(status as TaskStatus) ? { status: status as TaskStatus } : {}),
    ...(filters.awaitingHuman === true ? { awaitingHuman: true } : {}),
    ...(filters.awaitingAcceptance === true ? { awaitingAcceptance: true } : {}),
    ...(typeof group === 'string' && group ? { groupId: group } : {}),
    ...(typeof worktree === 'string' && worktree ? { worktree } : {}),
  }
}

export default function TaskListFilters({ teamPath, rows, filters }: {
  teamPath: string
  rows: readonly TeamTaskRow[]
  filters: Record<string, string | boolean>
}) {
  const set = (patch: Record<string, string | boolean | undefined>) =>
    useTeamWorkspaceStore.getState().setFilters(teamPath, 'tasks', patch)
  const groups = [...new Set(rows.flatMap(row => row.groupId ? [row.groupId] : []))].sort()
  const worktrees = [...new Set(rows.flatMap(row => row.worktree ? [row.worktree] : []))].sort()
  const text = (key: string) => typeof filters[key] === 'string' ? filters[key] as string : ''
  const active = Object.keys(queryFromFilters(filters)).length > 0
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="task-filters">
    <label className="flex items-center gap-1">Status
      <select className="input" data-testid="task-filter-status" value={text('status')}
        onChange={event => set({ status: event.target.value || undefined })}>
        <option value="">Open work (not closed)</option>
        {STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
      </select>
    </label>
    <label className="flex items-center gap-1">
      <input type="checkbox" data-testid="task-filter-human" checked={filters.awaitingHuman === true}
        onChange={event => set({ awaitingHuman: event.target.checked || undefined })} />
      Awaiting human
    </label>
    <label className="flex items-center gap-1">
      <input type="checkbox" data-testid="task-filter-acceptance" checked={filters.awaitingAcceptance === true}
        onChange={event => set({ awaitingAcceptance: event.target.checked || undefined })} />
      Awaiting acceptance
    </label>
    <label className="flex items-center gap-1">Group
      <select className="input" data-testid="task-filter-group" value={text('group')}
        onChange={event => set({ group: event.target.value || undefined })}>
        <option value="">Any group</option>
        {groups.map(group => <option key={group} value={group}>{group}</option>)}
      </select>
    </label>
    <label className="flex items-center gap-1">Worktree
      <select className="input" data-testid="task-filter-worktree" value={text('worktree')}
        onChange={event => set({ worktree: event.target.value || undefined })}>
        <option value="">Any worktree</option>
        {worktrees.map(worktree => <option key={worktree} value={worktree} title={worktree}>{basename(worktree)}</option>)}
      </select>
    </label>
    {active && <button type="button" className="btn" data-testid="task-filter-clear"
      onClick={() => set({ status: undefined, awaitingHuman: undefined, awaitingAcceptance: undefined, group: undefined, worktree: undefined })}>
      Clear filters
    </button>}
  </div>
}

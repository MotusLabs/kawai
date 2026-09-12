// WorktreeOpenSpecRows.tsx - Compact OpenSpec change rows rendered inside a
// worktree group: change name, workflow status, task progress (e.g. 9/11),
// and last-modified time when available. Optional fields are never invented;
// a worktree without an OpenSpec root renders nothing. Discovery failures are
// isolated to this worktree: last-valid changes stay visible with a stale or
// error indication.

import type { WorktreeOpenSpecState } from '@shared/workspace'
import { formatRelativeTime } from '../utils/time'

interface WorktreeOpenSpecRowsProps {
  openspec: WorktreeOpenSpecState
}

function changeAriaLabel(change: WorktreeOpenSpecState['changes'][number]): string {
  const parts = [`OpenSpec change ${change.name}`]
  if (change.status) parts.push(change.status)
  if (change.completedTasks !== undefined && change.totalTasks !== undefined) {
    parts.push(`${change.completedTasks} of ${change.totalTasks} tasks complete`)
  }
  return parts.join(', ')
}

export default function WorktreeOpenSpecRows({ openspec }: WorktreeOpenSpecRowsProps) {
  if (openspec.changes.length === 0 && !openspec.stale) return null

  return (
    <div data-testid="worktree-openspec-rows" className="py-0.5">
      {openspec.stale && (
        <div
          className="mx-3 mb-1 rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] text-zinc-400"
          data-testid="worktree-openspec-stale"
          title={
            openspec.error ??
            'OpenSpec discovery failed; showing last known changes'
          }
          role="status"
          aria-label={
            openspec.error
              ? `OpenSpec unavailable: ${openspec.error}`
              : 'OpenSpec data stale; showing last known changes'
          }
        >
          openspec {openspec.error ? 'unavailable' : 'stale'}
        </div>
      )}
      {openspec.changes.map((change) => {
        const hasProgress =
          change.completedTasks !== undefined && change.totalTasks !== undefined
        return (
          <div
            key={change.name}
            className="flex items-center gap-1.5 px-3 py-0.5 text-[11px]"
            data-testid="worktree-openspec-change"
            data-change-name={change.name}
            aria-label={changeAriaLabel(change)}
            title={
              change.lastModified
                ? `${change.name} (updated ${formatRelativeTime(change.lastModified)})`
                : change.name
            }
          >
            <span className="truncate font-mono text-muted">{change.name}</span>
            {change.status && (
              <span className="shrink-0 rounded bg-surface px-1 text-[10px] text-secondary">
                {change.status}
              </span>
            )}
            {hasProgress && (
              <span
                className="ml-auto shrink-0 font-mono tabular-nums text-accent"
                data-testid="worktree-openspec-progress"
                aria-label={`${change.completedTasks} of ${change.totalTasks} tasks complete`}
              >
                {change.completedTasks}/{change.totalTasks}
              </span>
            )}
            {change.lastModified && (
              <span className="shrink-0 text-[10px] text-muted">
                {formatRelativeTime(change.lastModified)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

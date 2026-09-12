// WorktreeGroupHeader.tsx - Repository/worktree group header for the grouped
// workspace navigator: repository name, branch or detached revision, path,
// dirty/stale state, session and OpenSpec counts, collapse control, and
// accessible labels. Purely presentational; collapse state lives in the
// workspace store.

import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import HandIcon from '@untitledui-icons/react/line/esm/HandIcon'
import { shortRevision } from '@shared/workspace'
import { getPathLeaf } from '../utils/sessionLabel'
import type { WorktreeGroup } from '../utils/workspaceView'

export interface WorktreeGroupHeaderProps {
  group: WorktreeGroup
  onToggleCollapse: (worktreeId: string) => void
  /** Rendered at the trailing edge (e.g. the group's new-session action). */
  actions?: React.ReactNode
}

export default function WorktreeGroupHeader({
  group,
  onToggleCollapse,
  actions,
}: WorktreeGroupHeaderProps) {
  // Branch is absent exactly when HEAD is detached; fall back defensively so
  // the header never renders an empty identity.
  const isDetached = group.detached || !group.branch
  const identityLabel = isDetached ? `@${shortRevision(group.headRevision)}` : group.branch!
  const identityTitle = isDetached
    ? `Detached HEAD at ${group.headRevision}`
    : `Branch ${group.branch}`

  // The repository name comes from the main worktree's directory, so the path
  // leaf only adds information for linked worktrees.
  const pathLeaf = getPathLeaf(group.worktreePath)
  const showPath = pathLeaf !== null && pathLeaf !== group.repositoryName

  const stateLabels: string[] = []
  if (group.dirty) stateLabels.push('dirty')
  if (group.repositoryStale) stateLabels.push('stale')
  if (isDetached) stateLabels.push('detached')

  const hiddenAttention = group.hiddenAttentionCount
  const attentionTotal = group.attentionCount + hiddenAttention
  const openspecCount = group.openspec.changes.length

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 text-left"
      data-testid="worktree-group-header"
      data-worktree-id={group.worktreeId}
      data-repository={group.repositoryName}
      data-branch={group.branch ?? ''}
      data-detached={isDetached ? 'true' : 'false'}
      data-dirty={group.dirty ? 'true' : 'false'}
      data-stale={group.repositoryStale ? 'true' : 'false'}
      data-collapsed={group.collapsed ? 'true' : 'false'}
      data-session-count={group.entries.length}
      data-openspec-count={openspecCount}
      data-attention-count={attentionTotal}
      data-hidden-attention-count={hiddenAttention}
    >
      <button
        type="button"
        onClick={() => onToggleCollapse(group.worktreeId)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-xs font-medium text-secondary hover:text-primary"
        aria-expanded={!group.collapsed}
        aria-label={
          group.collapsed
            ? `Expand ${group.repositoryName} worktree ${group.worktreePath}`
            : `Collapse ${group.repositoryName} worktree ${group.worktreePath}`
        }
        title={group.worktreePath}
      >
        {group.collapsed ? (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className="truncate font-semibold">{group.repositoryName}</span>
        <span
          className={`min-w-0 shrink truncate font-mono text-[11px] ${
            isDetached ? 'text-amber-500' : 'text-accent'
          }`}
          title={identityTitle}
        >
          {identityLabel}
        </span>
        {showPath && (
          <span className="truncate text-[11px] text-muted" title={group.worktreePath}>
            {pathLeaf}
          </span>
        )}
        {group.dirty && (
          <span
            className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] uppercase tracking-wide text-amber-600"
            title="Working tree has tracked or untracked changes"
          >
            dirty
          </span>
        )}
        {group.repositoryStale && (
          <span
            className="shrink-0 rounded bg-zinc-500/20 px-1 text-[10px] uppercase tracking-wide text-zinc-400"
            title={group.repositoryError ?? 'Git discovery failed; showing last known state'}
          >
            stale
          </span>
        )}
        {stateLabels.length > 0 && <span className="sr-only">{` (${stateLabels.join(', ')})`}</span>}
      </button>

      {attentionTotal > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-600"
          title="Sessions waiting for permission"
          aria-label={`${attentionTotal} session(s) need permission`}
          data-testid="worktree-attention-badge"
        >
          <HandIcon className="h-3 w-3" />
          {attentionTotal}
        </span>
      )}

      {openspecCount > 0 && (
        <span
          className="shrink-0 rounded bg-accent/10 px-1 text-[10px] text-accent"
          title={`${openspecCount} active OpenSpec change(s)`}
          aria-label={`${openspecCount} active OpenSpec changes`}
          data-testid="worktree-openspec-count"
        >
          {openspecCount} spec
        </span>
      )}

      <span
        className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted"
        aria-label={`${group.entries.length} session(s)`}
      >
        {group.entries.length}
      </span>

      {actions}
    </div>
  )
}

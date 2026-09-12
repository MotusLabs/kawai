// BranchBrowserModal.tsx - Repository branch browser (§8.1): lists local
// branches with the worktree each is checked out in. Only unassigned branches
// offer worktree creation; assigned branches identify their worktree and the
// duplicate creation action stays disabled. Purely presentational — repository
// data comes from the workspace snapshot and creation is delegated to the
// create-worktree form (§8.2).

import { useEffect, useMemo, useState } from 'react'
import GitBranch01Icon from '@untitledui-icons/react/line/esm/GitBranch01Icon'
import {
  shortRevision,
  type WorkspaceBranch,
  type WorkspaceRepository,
} from '@shared/workspace'
import { getPathLeaf } from '../utils/sessionLabel'

export interface BranchBrowserModalProps {
  repository: WorkspaceRepository
  onClose: () => void
  /** Opens the create-worktree form for an unassigned local branch. */
  onCreateWorktree: (branch: WorkspaceBranch) => void
}

export default function BranchBrowserModal({
  repository,
  onClose,
  onCreateWorktree,
}: BranchBrowserModalProps) {
  const [filter, setFilter] = useState('')

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const worktreePathById = useMemo(() => {
    const map = new Map<string, string>()
    for (const worktree of repository.worktrees) map.set(worktree.id, worktree.path)
    return map
  }, [repository])

  const needle = filter.trim().toLowerCase()
  const branches = needle
    ? repository.branches.filter((branch) =>
        branch.name.toLowerCase().includes(needle)
      )
    : repository.branches

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="branch-browser-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col border border-border bg-elevated p-6"
        data-testid="branch-browser"
        data-repository={repository.name}
      >
        <h2
          id="branch-browser-title"
          className="text-sm font-semibold uppercase tracking-wider text-primary"
        >
          Branches — {repository.name}
        </h2>

        <input
          autoFocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter branches…"
          aria-label="Filter branches"
          data-testid="branch-filter"
          className="input mt-4 text-sm"
        />

        <ul
          className="mt-3 min-h-0 flex-1 overflow-y-auto"
          role="list"
          aria-label={`Local branches in ${repository.name}`}
          data-testid="branch-list"
        >
          {branches.map((branch) => {
            const assignedPath = branch.assignedWorktreeId
              ? worktreePathById.get(branch.assignedWorktreeId)
              : undefined
            const assigned = assignedPath !== undefined
            const assignmentLeaf = assignedPath
              ? getPathLeaf(assignedPath) ?? assignedPath
              : null
            return (
              <li
                key={branch.name}
                className="flex items-center gap-2 px-1 py-1.5"
                data-testid="branch-row"
                data-branch={branch.name}
                data-assigned={assigned ? 'true' : 'false'}
              >
                <GitBranch01Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={branch.name}>
                  {branch.name}
                </span>
                <span
                  className="shrink-0 font-mono text-[11px] text-muted"
                  title={branch.revision}
                >
                  {shortRevision(branch.revision)}
                </span>
                {assignmentLeaf !== null && (
                  <span
                    className="shrink-0 truncate text-[11px] text-muted"
                    title={assignedPath}
                  >
                    in {assignmentLeaf}
                  </span>
                )}
                <button
                  type="button"
                  disabled={assigned}
                  aria-disabled={assigned ? 'true' : undefined}
                  aria-label={
                    assigned
                      ? `Branch ${branch.name} is checked out at ${assignedPath}`
                      : `Create worktree for branch ${branch.name}`
                  }
                  title={
                    assigned
                      ? `Checked out at ${assignedPath}`
                      : `Create a worktree for ${branch.name}`
                  }
                  data-testid="branch-create"
                  onClick={() => {
                    if (!assigned) onCreateWorktree(branch)
                  }}
                  className={`btn shrink-0 text-xs ${assigned ? 'opacity-50' : ''}`}
                >
                  Create worktree
                </button>
              </li>
            )
          })}
        </ul>

        {repository.branches.length === 0 && (
          <p className="mt-3 text-xs text-muted" data-testid="branch-empty">
            No local branches
          </p>
        )}
        {repository.branches.length > 0 && branches.length === 0 && (
          <p className="mt-3 text-xs text-muted" data-testid="branch-no-match">
            No branches match &ldquo;{filter.trim()}&rdquo;
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

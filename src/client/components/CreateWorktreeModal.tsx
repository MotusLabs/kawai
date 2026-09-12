// CreateWorktreeModal.tsx - Create-worktree form (§8.2): editable absolute
// destination pre-filled with a collision-resistant sibling suggestion, an
// exact branch/destination confirmation summary, and an optional follow-up
// session launch. The server revalidates everything before running git;
// this form only produces the request.

import { useEffect, useState } from 'react'
import type { WorkspaceBranch, WorkspaceRepository } from '@shared/workspace'
import { suggestWorktreeDestination } from '../utils/worktreeDestination'

export interface CreateWorktreeModalProps {
  repository: WorkspaceRepository
  branch: WorkspaceBranch
  /** Every worktree path known from the latest snapshot, for de-confliction. */
  existingWorktreePaths: string[]
  onConfirm: (destination: string, launchSession: boolean) => void
  onCancel: () => void
}

export default function CreateWorktreeModal({
  repository,
  branch,
  existingWorktreePaths,
  onConfirm,
  onCancel,
}: CreateWorktreeModalProps) {
  const mainWorktree = repository.worktrees.find((worktree) => worktree.isMain)
  const [destination, setDestination] = useState(() =>
    suggestWorktreeDestination(
      mainWorktree?.path ?? repository.worktrees[0]?.path ?? '/',
      repository.name,
      branch.name,
      existingWorktreePaths
    )
  )
  const [launchSession, setLaunchSession] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const trimmedDestination = destination.trim()
  const destinationError =
    trimmedDestination === ''
      ? 'Destination is required'
      : !trimmedDestination.startsWith('/') || trimmedDestination.length < 2 || trimmedDestination.includes('\0')
        ? 'Destination must be an absolute path'
        : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-worktree-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        className="w-full max-w-md border border-border bg-elevated p-6"
        data-testid="create-worktree-form"
        data-repository={repository.name}
        data-branch={branch.name}
        onSubmit={(event) => {
          event.preventDefault()
          if (destinationError === null) {
            onConfirm(trimmedDestination, launchSession)
          }
        }}
      >
        <h2
          id="create-worktree-title"
          className="text-sm font-semibold uppercase tracking-wider text-primary"
        >
          Create Worktree
        </h2>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs text-secondary">Branch</label>
            <p
              className="break-all font-mono text-sm text-primary"
              data-testid="create-worktree-branch"
            >
              {branch.name}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">{repository.name}</p>
          </div>

          <div>
            <label
              htmlFor="create-worktree-destination"
              className="mb-1.5 block text-xs text-secondary"
            >
              Destination (absolute path)
            </label>
            <input
              id="create-worktree-destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              aria-invalid={destinationError !== null ? 'true' : undefined}
              className="input text-sm"
              data-testid="create-worktree-destination"
            />
            {destinationError !== null ? (
              <p
                className="mt-1 text-xs text-red-500"
                data-testid="create-worktree-destination-error"
              >
                {destinationError}
              </p>
            ) : null}
          </div>

          <label className="flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={launchSession}
              onChange={(event) => setLaunchSession(event.target.checked)}
              data-testid="create-worktree-launch"
            />
            Start a session in the new worktree after creation
          </label>

          <p
            className="break-all border border-border bg-hover/40 p-2 text-[11px] text-secondary"
            data-testid="create-worktree-summary"
          >
            Create worktree for branch{' '}
            <span className="font-mono">{branch.name}</span> at{' '}
            <span className="font-mono">
              {destinationError === null ? trimmedDestination : '…'}
            </span>{' '}
            in repository {repository.name}
            {launchSession && destinationError === null ? ', then open session options' : ''}.
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn" data-testid="create-worktree-cancel">
            Cancel
          </button>
          <button
            type="submit"
            disabled={destinationError !== null}
            className="btn btn-primary"
            data-testid="create-worktree-submit"
          >
            Create worktree
          </button>
        </div>
      </form>
    </div>
  )
}

// Workspace messages: snapshot application and operation results, including
// the worktree-launch flow that opens the prefilled New Session dialog.
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

export function handleWorkspaceSnapshot(
  message: Extract<ServerMessage, { type: 'workspace-snapshot' }>,
  _deps: MessageRouterDeps
): void {
  // Malformed snapshots keep the last valid one (stale retention);
  // reconnects resupply the latest snapshot on open.
  useWorkspaceStore.getState().applySnapshot(message.snapshot)
}

export function handleWorkspaceOperationResult(
  message: Extract<ServerMessage, { type: 'workspace-operation-result' }>,
  deps: MessageRouterDeps
): void {
  useWorkspaceStore.getState().recordOperationResult(message.result)
  const result = message.result
  if (result.operation === 'create-worktree') {
    const pending = deps.pendingWorktreeLaunch.current
    if (result.ok) {
      // Route a successful launch request through the normal session
      // form — presets, names, and hosts stay in play (§8.4).
      if (
        pending &&
        pending.repositoryId === result.repositoryId &&
        pending.branch === result.branch
      ) {
        deps.pendingWorktreeLaunch.current = null
        deps.openSessionFormPrefilled({ path: result.path })
      }
    } else {
      // Every operation failure surfaces an actionable error.
      if (pending) deps.pendingWorktreeLaunch.current = null
      deps.setTransientError(result.error)
    }
  }
  if (result.operation === 'create-change-worktree') {
    const pending = deps.pendingChangeLaunch.current
    if (result.ok) {
      // Seeded creation succeeded: open the session form prefilled with
      // the new worktree root and the apply auto-start offered (§7.4).
      if (pending && pending.repositoryId === result.repositoryId && pending.change === result.change) {
        deps.pendingChangeLaunch.current = null
        deps.openSessionFormPrefilled({ path: result.path, autoStartChange: result.change })
      }
    } else {
      if (pending) deps.pendingChangeLaunch.current = null
      deps.setTransientError(result.error)
    }
  }
}

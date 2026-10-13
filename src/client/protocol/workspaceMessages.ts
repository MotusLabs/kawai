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

/**
 * Settle a worktree launch (F7 dedupe). The two outcome paths are NOT
 * symmetric and must stay that way: a SUCCESS only acts when it matches the
 * pending request — an unmatched success (another client's worktree, or a
 * second creation in flight) leaves the pending launch alone so its own
 * result can still open the form. A FAILURE always surfaces the error and
 * clears any pending launch.
 */
function settleLaunch(
  deps: MessageRouterDeps,
  ok: boolean,
  error: string,
  pending: unknown,
  clearPending: () => void,
  matched: boolean,
  launch: () => void
): void {
  if (ok) {
    if (matched) {
      clearPending()
      launch()
    }
    return
  }
  if (pending) clearPending()
  // Every operation failure surfaces an actionable error.
  deps.setTransientError(error)
}

export function handleWorkspaceOperationResult(
  message: Extract<ServerMessage, { type: 'workspace-operation-result' }>,
  deps: MessageRouterDeps
): void {
  useWorkspaceStore.getState().recordOperationResult(message.result)
  const result = message.result
  if (result.operation === 'create-worktree') {
    const pending = deps.pendingWorktreeLaunch.current
    const launchPath = result.ok ? result.path : ''
    settleLaunch(
      deps,
      result.ok,
      result.ok ? '' : result.error,
      pending,
      () => { deps.pendingWorktreeLaunch.current = null },
      Boolean(pending && pending.repositoryId === result.repositoryId && pending.branch === result.branch),
      // Route a successful launch request through the normal session
      // form — presets, names, and hosts stay in play (§8.4).
      () => deps.openSessionFormPrefilled({ path: launchPath })
    )
  }
  if (result.operation === 'create-change-worktree') {
    const pending = deps.pendingChangeLaunch.current
    const launchPath = result.ok ? result.path : ''
    const launchChange = result.ok ? result.change : ''
    settleLaunch(
      deps,
      result.ok,
      result.ok ? '' : result.error,
      pending,
      () => { deps.pendingChangeLaunch.current = null },
      Boolean(pending && pending.repositoryId === result.repositoryId && pending.change === result.change),
      // Seeded creation succeeded: open the session form prefilled with
      // the new worktree root and the apply auto-start offered (§7.4).
      () => deps.openSessionFormPrefilled({ path: launchPath, autoStartChange: launchChange })
    )
  }
}

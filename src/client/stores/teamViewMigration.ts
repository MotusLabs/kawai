// Team views follow workspace discovery (team-workspace-pages D2). A view is
// keyed by a team key, and a key that is a path inside a repository not yet
// discovered is that path itself; once discovery reports the repository, the
// same team's key is its main checkout. On every snapshot change each
// existing view is moved to the key its own path now maps to — for every
// view, not only the selected chat's, so a panel opened in a chat that is not
// on screen is still there when that chat is selected again. A key only ever
// moves to its own repository's main checkout, so views never cross into a
// different team: a chat whose directory moves to another repository keeps
// the old team's view under the old key and finds its new team's own view.
// An open Team page moves with its team too: its URL names the key, so the
// location is rewritten (in place, no new history entry) alongside the views
// — otherwise the page would sit on a key no view answers and read as
// unknown (D2/D3).
import type { WorkspaceRepository } from '@shared/workspace'
import { teamKeyOf } from '../utils/teamKey'
import { aliasTeamKey } from '../utils/teamKeyAliases'
import { useTeamLocationStore } from '../hooks/useTeamLocation'
import { useStrategyStore } from './strategyStore'
import { useTeamMailboxStore } from './teamMailboxStore'
import { useTeamMessageStore } from './teamMessageStore'
import { useTeamTaskStore } from './teamTaskStore'
import { useTeamWorkspaceDataStore } from './teamWorkspaceDataStore'
import { useTeamPlanStore } from './teamPlanStore'
import { useMetricsStore } from './metricsStore'
import { useTeamWorkspaceStore } from './teamWorkspaceStore'
import { useWorkspaceStore } from './workspaceStore'

const viewKeys = () => new Set([
  ...Object.keys(useTeamMailboxStore.getState().views),
  ...Object.keys(useTeamTaskStore.getState().views),
  ...Object.keys(useTeamMessageStore.getState().views),
  ...Object.keys(useStrategyStore.getState().views),
  ...Object.keys(useTeamWorkspaceStore.getState().views),
  ...Object.keys(useTeamWorkspaceDataStore.getState().views),
  ...Object.keys(useTeamPlanStore.getState().views),
  ...Object.keys(useMetricsStore.getState().views),
])

/** Move every team view from a chat's old team key to its new one. */
function rekeyTeamViews(from: string, to: string) {
  if (from === to) return
  // Replies still in flight for the old key follow the views (teamKeyAliases).
  aliasTeamKey(from, to)
  useTeamMailboxStore.getState().rekey(from, to)
  useTeamTaskStore.getState().rekey(from, to)
  useTeamMessageStore.getState().rekey(from, to)
  useStrategyStore.getState().rekey(from, to)
  useTeamWorkspaceStore.getState().rekey(from, to)
  useTeamWorkspaceDataStore.getState().rekey(from, to)
  // An open Team page on the old key follows (D3): same tab, selection, and
  // sub-view, replaced in place so no history entry appears for the move.
  const location = useTeamLocationStore.getState().location
  if (location?.teamKey === from) {
    useTeamLocationStore.getState().navigate({ ...location, teamKey: to }, { replace: true })
  }
  useTeamPlanStore.getState().rekey(from, to)
  useMetricsStore.getState().rekey(from, to)
}

/** Move every team view whose key now maps elsewhere within its own team. */
export function migrateTeamViews(repositories: readonly WorkspaceRepository[] | null | undefined): void {
  for (const key of viewKeys()) {
    const next = teamKeyOf(key, repositories)
    if (next !== key) rekeyTeamViews(key, next)
  }
}

/** The rekey, exported for tests (the view keys it moves are module-private stores). */
export const rekeyTeamViewsForTests = rekeyTeamViews

/** Re-run the migration whenever the workspace snapshot changes; returns the unsubscribe. */
export function startTeamViewMigration(): () => void {
  migrateTeamViews(useWorkspaceStore.getState().snapshot?.repositories)
  return useWorkspaceStore.subscribe((state, previous) => {
    if (state.snapshot !== previous.snapshot) migrateTeamViews(state.snapshot?.repositories)
  })
}

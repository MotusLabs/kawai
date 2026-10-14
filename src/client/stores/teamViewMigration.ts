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
import type { WorkspaceRepository } from '@shared/workspace'
import { rekeyTeamViews } from '../components/chat/sideSlot'
import { teamKeyOf } from '../utils/teamKey'
import { useStrategyStore } from './strategyStore'
import { useTeamMailboxStore } from './teamMailboxStore'
import { useTeamMessageStore } from './teamMessageStore'
import { useTeamTaskStore } from './teamTaskStore'
import { useTeamWorkspaceStore } from './teamWorkspaceStore'
import { useWorkspaceStore } from './workspaceStore'

const viewKeys = () => new Set([
  ...Object.keys(useTeamMailboxStore.getState().views),
  ...Object.keys(useTeamTaskStore.getState().views),
  ...Object.keys(useTeamMessageStore.getState().views),
  ...Object.keys(useStrategyStore.getState().views),
  ...Object.keys(useTeamWorkspaceStore.getState().views),
])

/** Move every team view whose key now maps elsewhere within its own team. */
export function migrateTeamViews(repositories: readonly WorkspaceRepository[] | null | undefined): void {
  for (const key of viewKeys()) {
    const next = teamKeyOf(key, repositories)
    if (next !== key) rekeyTeamViews(key, next)
  }
}

/** Re-run the migration whenever the workspace snapshot changes; returns the unsubscribe. */
export function startTeamViewMigration(): () => void {
  migrateTeamViews(useWorkspaceStore.getState().snapshot?.repositories)
  return useWorkspaceStore.subscribe((state, previous) => {
    if (state.snapshot !== previous.snapshot) migrateTeamViews(state.snapshot?.repositories)
  })
}

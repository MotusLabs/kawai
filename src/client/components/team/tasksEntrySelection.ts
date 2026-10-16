// Body of TeamWorkspaceView's tasks-tab entry effect, extracted so tests can
// drive StrictMode's same-closure replay directly: bun's react-test-renderer
// never replays effects, and any re-render the replay would follow already
// sees the URL the entry navigation restored. The replay calls this with the
// entering run's closure values again while the live location — read fresh
// here, never from the caller's closure — has moved on.
import { useTeamLocationStore } from '../../hooks/useTeamLocation'
import type { TeamLocation } from '../../utils/teamLocation'
import { useTeamTaskStore } from '../../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'

// Entering the tab with a task still selected (Messages, then Tasks, or a
// return through the Team entry) puts the selection back in the URL instead
// of dropping it (spec: the selected task survives navigation); a URL that
// loses its id while the tab stays open — the browser's Back — is a request
// for the list. Entering is told apart by the tab having just opened, and
// the live-location read means StrictMode's replay (same closure, location
// already restored) finds the id and does nothing.
export function runTasksEntrySelection({ entering, closureLocationId, teamKey, navigate }: {
  entering: boolean
  closureLocationId: string | undefined
  teamKey: string
  navigate: (location: TeamLocation, options?: { replace?: boolean }) => void
}): void {
  const store = useTeamTaskStore.getState()
  const view = store.views[teamKey]
  const live = useTeamLocationStore.getState().location
  const locationId = live ? live.id : closureLocationId
  if (locationId === undefined) {
    if (view && view.selectedTaskId != null) {
      if (entering) navigate({ teamKey, tab: 'tasks', id: view.selectedTaskId }, { replace: true })
      else store.select(teamKey, null)
    }
    return
  }
  // Wait for the list before judging a named task: a reload's snapshot has
  // not arrived yet, and a task that exists must not read as missing.
  if (!view || view.loading) return
  const known = view.tasks.some(task => task.id === locationId)
  if (known) {
    if (view.selectedTaskId !== locationId) store.select(teamKey, locationId)
  } else {
    // A missing task falls back to the list with a notice (D3).
    useTeamWorkspaceStore.getState().setNotice(teamKey, `Task ${locationId} was not found`)
    if (view.selectedTaskId != null) store.select(teamKey, null)
  }
}

// MissingGroupsNotice.tsx - the New Session dialog's pointer to Set up team
// (starter-team-setup D2): shown for a chat whose project's team has no
// project group file. It never blocks creating the chat; its link closes the
// dialog and opens that team's Team page on the Members tab, where the
// starter groups are one click away and stay editable files afterwards. The
// team key is the main checkout of the discovered repository containing the
// path, else the path itself — the key every Team entry point computes.
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useTeamLocationStore } from '../../hooks/useTeamLocation'
import { teamKeyOf } from '../../utils/teamKey'

export default function MissingGroupsNotice({ projectPath, onLeave }: {
  projectPath: string
  /** Closes the dialog before the Team page opens. */
  onLeave: () => void
}) {
  const open = () => {
    const teamKey = teamKeyOf(projectPath, useWorkspaceStore.getState().snapshot?.repositories)
    onLeave()
    useTeamLocationStore.getState().navigate({ teamKey, tab: 'members' })
  }
  return <div role="status" data-testid="missing-groups-notice" className="mt-1 text-xs text-secondary">
    This project has no team groups yet.{' '}
    <button type="button" className="underline text-primary" data-testid="missing-groups-link" onClick={open}>
      Set up a starter team on the Members tab
    </button>
    {' '}— one click, and the groups stay editable files.
  </div>
}

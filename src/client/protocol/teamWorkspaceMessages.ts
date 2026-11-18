// Team workspace pushes (team-workspace 4.2): the snapshot and the change
// push are the same full-set replace. The store returns the attention items
// that newly need the human; each raises one toast, keyed by its identity.
// Set up team's answers go to the setup store under the same routed key.
import { useTeamWorkspaceDataStore } from '../stores/teamWorkspaceDataStore'
import { useTeamSetupStore } from '../stores/teamSetupStore'
import { routedTeamPath } from '../utils/teamKeyAliases'
import { toastManager } from '../components/Toast'
import type { ServerMessage } from '@shared/types'

type WorkspaceMessage = Extract<ServerMessage, { type: 'team-workspace-snapshot' | 'team-workspace' }>
type ApprovalResult = Extract<ServerMessage, { type: 'team-workspace-approval-default-result' }>
type SetupMessage = Extract<ServerMessage, { type: 'team-workspace-setup-preview-result' | 'team-workspace-setup-result' }>

/** Set up team's preview and run answers (starter-team-setup D3), routed like the snapshot. */
export function handleTeamSetupMessage(message: SetupMessage): void {
  const teamKey = routedTeamPath(message.teamPath, useTeamWorkspaceDataStore.getState().views)
  const setup = useTeamSetupStore.getState()
  if (message.type === 'team-workspace-setup-preview-result') {
    setup.applyPreview(teamKey, message.ok ? { ok: true, preview: message.preview } : { ok: false, error: message.error })
    return
  }
  const { type: _type, teamPath: _teamPath, ...result } = message
  setup.applyResult(teamKey, result)
}

/** The team default approval save's answer (team-approval-default D4), routed like the snapshot. */
export function handleTeamApprovalDefaultResult(message: ApprovalResult): void {
  const store = useTeamWorkspaceDataStore.getState()
  const { type: _type, ...result } = message
  store.applyApprovalResult({ ...result, teamPath: routedTeamPath(message.teamPath, store.views) })
}

export function handleTeamWorkspaceMessage(message: WorkspaceMessage): void {
  const store = useTeamWorkspaceDataStore.getState()
  const teamPath = routedTeamPath(message.teamPath, store.views)
  const { type: _type, ...payload } = message
  for (const item of store.apply({ ...payload, teamPath })) {
    toastManager.add({
      title: `${item.nextAction}: ${item.owner.label}`,
      description: item.cause,
      type: 'warning',
    })
  }
}

// Store dispatches for the plan workspace message family (plan-workspace
// tasks 1.3, §5): the authoritative snapshot, the composed checklists and
// documents, and the keyed command results. The view is host-agnostic and
// drives its own wire subscription (PlanWorkspaceSection); this is the host
// that feeds its store. Pushes for a team key whose views moved (a rekey)
// route to the new key, like the sibling team stores.
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { routedTeamPath } from '../utils/teamKeyAliases'
import type { ServerMessage } from '@shared/types'

type WorkspaceMessage = Extract<ServerMessage, { type: `team-plan-workspace-${string}` }>

export function handlePlanWorkspaceMessage(message: WorkspaceMessage): void {
  const store = useTeamPlanWorkspaceStore.getState()
  switch (message.type) {
    case 'team-plan-workspace-snapshot': {
      const teamPath = routedTeamPath(message.teamPath, store.views)
      store.applySnapshot(teamPath === message.teamPath ? message : { ...message, teamPath })
      return
    }
    case 'team-plan-workspace-checklist': {
      const teamPath = routedTeamPath(message.teamPath, store.views)
      store.applyChecklist(teamPath === message.teamPath ? message : { ...message, teamPath })
      return
    }
    case 'team-plan-workspace-document': {
      const teamPath = routedTeamPath(message.teamPath, store.views)
      store.applyDocument(teamPath === message.teamPath ? message : { ...message, teamPath })
      return
    }
    case 'team-plan-workspace-artifacts': {
      const teamPath = routedTeamPath(message.teamPath, store.views)
      store.applyArtifacts(teamPath === message.teamPath ? message : { ...message, teamPath })
      return
    }
    case 'team-plan-workspace-result': {
      const teamPath = routedTeamPath(message.teamPath, store.views)
      store.applyResult(teamPath === message.teamPath ? message : { ...message, teamPath })
      return
    }
    // Only ends the subscription; the server answers nothing.
    default: return
  }
}

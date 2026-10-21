// Where an attention or summary link goes (team-workspace D11): the workspace
// holds no action of its own, so a link navigates to where the existing one
// lives — a task's detail, the Mailbox row for a message (Retry/Discard/Hand
// off), or the chat whose card is waiting. A decision card carrying its plan
// and a `plan` link open the plan instead (plan-supervision D13), and name
// the detail's scroll target (D15) in the plans store's `reveal`.
import type { AttentionLink } from '@shared/teamWorkspace'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import type { TeamLocation } from '../../utils/teamLocation'
import { openParticipantChat } from '../chat/openParticipant'

const LINK_LABELS: Record<AttentionLink['kind'], string> = {
  card: 'Open card',
  task: 'Open task',
  message: 'Open message',
  chat: 'Open chat',
  audit: 'Open audit row',
  plan: 'Open plan',
}

export const attentionLinkLabel = (link: AttentionLink): string =>
  // A decision card carrying its plan opens the plan, which scrolls to the
  // card (plan-supervision D13, D15).
  link.kind === 'card' && link.planId ? 'Open plan' : LINK_LABELS[link.kind] ?? 'Open'

export function openAttentionLink(
  teamKey: string,
  link: AttentionLink,
  navigate: (location: TeamLocation) => void,
): void {
  switch (link.kind) {
    case 'task':
      navigate({ teamKey, tab: 'tasks', id: link.id })
      return
    case 'message': {
      // The Mailbox row opens expanded so its constraints and actions show.
      const workspace = useTeamWorkspaceStore.getState()
      const expanded = workspace.views[teamKey]?.tabs.mailbox.expanded ?? []
      if (!expanded.includes(link.id)) workspace.setExpanded(teamKey, 'mailbox', [...expanded, link.id])
      navigate({ teamKey, tab: 'mailbox' })
      return
    }
    case 'chat':
      openParticipantChat(link.id)
      return
    case 'card':
      // A decision card opens its plan when it names one (plan-supervision
      // D13) and the detail scrolls to the card (D15): the one-shot target
      // rides the plans store, since the URL stays the plan's. A
      // session-shaped card keeps its chat.
      if (link.planId) {
        useTeamPlanStore.getState().requestReveal(teamKey, link.planId, `decision-card-${link.id}`)
        navigate({ teamKey, tab: 'plans', id: link.planId })
        return
      }
      openParticipantChat(link.id)
      return
    case 'audit':
      // The Audit tab, on the linked call when one is named (execution-safety-recovery D10).
      navigate(link.id ? { teamKey, tab: 'audit', id: link.id } : { teamKey, tab: 'audit' })
      return
    case 'plan': {
      // The Plans tab's plan detail (plan-supervision D13); with a change,
      // the detail scrolls to that change's row (D15) through the store's
      // one-shot reveal target.
      const planId = link.planId ?? link.id
      if (link.change) useTeamPlanStore.getState().requestReveal(teamKey, planId, `plan-change-${link.change}`)
      navigate({ teamKey, tab: 'plans', id: planId })
      return
    }
  }
}

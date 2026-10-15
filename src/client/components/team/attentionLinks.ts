// Where an attention or summary link goes (team-workspace D11): the workspace
// holds no action of its own, so a link navigates to where the existing one
// lives — a task's detail, the Mailbox row for a message (Retry/Discard/Hand
// off), or the chat whose card is waiting. A `card` link names a chat: cards
// (approvals, questions, later Lead decisions) are chat surfaces.
import type { AttentionLink } from '@shared/teamWorkspace'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import type { TeamLocation } from '../../utils/teamLocation'
import { openParticipantChat } from '../chat/openParticipant'

const LINK_LABELS: Record<AttentionLink['kind'], string> = {
  card: 'Open card',
  task: 'Open task',
  message: 'Open message',
  chat: 'Open chat',
}

export const attentionLinkLabel = (link: AttentionLink): string => LINK_LABELS[link.kind] ?? 'Open'

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
    case 'card':
      openParticipantChat(link.id)
      return
  }
}

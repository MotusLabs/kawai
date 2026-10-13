// The Messages side panel (team-message-threads 5.4): the first host of the
// host-agnostic TeamMessagesView, mounted in the chat side slot behind the
// Messages header toggle beside Debug, Mailbox, and Tasks (one at a time). It
// supplies only what the view cannot know on its own — the live sessions to
// name and the team's groups to address — and leaves delivery operations with
// the Mailbox panel.
import type { SendClientMessage } from '@shared/types'
import { useSessionStore } from '../../stores/sessionStore'
import { closedMessageView, useTeamMessageStore } from '../../stores/teamMessageStore'
import TeamMessagesView from './TeamMessagesView'
import { openParticipantChat } from './openParticipant'
import { useTeamGroups } from './useTeamGroups'

export default function TeamMessagesPanel({ sessionId, projectPath, sendMessage, connected, connectionEpoch, onClose }: {
  sessionId: string
  projectPath: string
  sendMessage: SendClientMessage
  connected: boolean
  connectionEpoch: number
  onClose: () => void
}) {
  const view = useTeamMessageStore(state => state.views[sessionId]) ?? closedMessageView()
  const sessions = useSessionStore(state => state.sessions)
  const groups = useTeamGroups(view.open, projectPath)
  return <TeamMessagesView sessionId={sessionId} view={view} sendMessage={sendMessage} connected={connected}
    connectionEpoch={connectionEpoch}
    sessions={sessions.map(row => ({ id: row.id, name: row.name, groupId: row.groupId ?? null }))}
    groups={groups.groups.map(group => ({ id: group.id, label: group.label }))}
    onOpenSession={openParticipantChat}
    onClose={onClose} />
}

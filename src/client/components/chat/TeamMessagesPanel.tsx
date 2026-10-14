// The Messages side panel (team-message-threads 5.4): the first host of the
// host-agnostic TeamMessagesView, mounted in the chat side slot behind the
// Messages header toggle beside Debug, Mailbox, and Tasks (one at a time). It
// supplies only what the view cannot know on its own — the slot's chrome,
// the live sessions to name, and the team's groups to address — and leaves
// delivery operations with the Mailbox panel.
import type { SendClientMessage } from '@shared/types'
import { useSessionStore } from '../../stores/sessionStore'
import { closedMessageView, useTeamMessageStore } from '../../stores/teamMessageStore'
import TeamMessagesView from '../team/TeamMessagesView'
import { openParticipantChat } from './openParticipant'
import { useTeamGroups } from './useTeamGroups'

export default function TeamMessagesPanel({ teamPath, projectPath, sendMessage, connected, connectionEpoch, onClose }: {
  teamPath: string
  projectPath: string
  sendMessage: SendClientMessage
  connected: boolean
  connectionEpoch: number
  onClose: () => void
}) {
  const view = useTeamMessageStore(state => state.views[teamPath]) ?? closedMessageView()
  const sessions = useSessionStore(state => state.sessions)
  const groups = useTeamGroups(view.open, projectPath)
  return <aside className="flex min-h-0 w-full flex-col border-l border-border md:w-[28rem]">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Team messages</h3>
      <button className="btn" onClick={onClose}>Close messages</button></header>
    <TeamMessagesView teamPath={teamPath} view={view} sendMessage={sendMessage} connected={connected}
      connectionEpoch={connectionEpoch}
      sessions={sessions.map(row => ({ id: row.id, name: row.name, groupId: row.groupId ?? null }))}
      groups={groups.groups.map(group => ({ id: group.id, label: group.label }))}
      onOpenSession={openParticipantChat} />
  </aside>
}

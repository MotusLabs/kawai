// The Mailbox side panel: the chat side slot's host of the host-agnostic
// TeamMailboxView, supplying only the slot's chrome. Every delivery
// operation lives in the view; the panel adds nothing.
import type { SendClientMessage } from '@shared/types'
import type { LiveParticipant } from '@shared/participants'
import type { MailboxView } from '../../stores/teamMailboxStore'
import TeamMailboxView from './TeamMailboxView'

export default function TeamMailboxPanel({ teamPath, view, sendMessage, connected, onClose, groups = [], sessions = [], onOpenSession }: {
  teamPath: string; view: MailboxView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
  /** The team's group ids, suggested as hand-off targets. */
  groups?: string[]
  /** Live team sessions, for naming and linking occupants (waiting reasons). */
  sessions?: ReadonlyArray<LiveParticipant>
  /** Open a named session's chat. */
  onOpenSession?: (sessionId: string) => void
}) {
  return <aside className="flex min-h-0 w-full flex-col border-l border-border md:w-96">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Team mailbox</h3>
      <button className="btn" onClick={onClose}>Close mailbox</button></header>
    <TeamMailboxView teamPath={teamPath} view={view} sendMessage={sendMessage} connected={connected}
      groups={groups} sessions={sessions} onOpenSession={onOpenSession} />
  </aside>
}

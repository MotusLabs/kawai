// One message row (team-message-threads 5.2, D3/D7): sender → current
// recipient with named participants, delivery-state and priority badges, the
// body, the task revision it carried at delivery, and its hold reason. Shared
// by the Messages list, the thread detail, and task detail's Messages section,
// so every surface names people the same way — including killed sessions as
// `Name (gone)`.
import { useState } from 'react'
import type { SessionDirectoryEntry, TeamMessage } from '@shared/team'
import type { LiveParticipant } from '@shared/participants'
import ParticipantName from '../chat/ParticipantName'

export default function MessageRow({ row, sessions, names, onOpenSession, clamp = false }: {
  row: TeamMessage
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
  /**
   * Clamp the body to a few lines with a show-full toggle
   * (team-workspace-pages 5.4): list surfaces clamp; detail surfaces show all.
   */
  clamp?: boolean
}) {
  return <>
    <p className="text-chat-meta text-secondary">
      <ParticipantName sessionId={row.fromSession} senderKind={row.fromKind} sessions={sessions} directory={names} onOpen={onOpenSession} />
      {' → '}
      <Recipient row={row} sessions={sessions} names={names} onOpenSession={onOpenSession} />
    </p>
    <p className="text-chat-meta text-secondary">
      <span data-testid="message-state">{row.state}</span>
      {' · '}
      <span data-testid="message-priority">{row.priority}</span>
      {' · '}
      <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
      {row.possibleDuplicate && <span data-testid="message-possible-duplicate"> · possible duplicate</span>}
    </p>
    {clamp
      ? <ClampedBody body={row.body} />
      : <p className="whitespace-pre-wrap text-chat-body" data-testid="message-body">{row.body}</p>}
    {row.taskRevision !== null && <p className="text-chat-meta text-secondary" data-testid="message-task-revision">
      Task revision {row.taskRevision}
    </p>}
    {row.reason && <p className="text-chat-meta text-secondary" data-testid="message-reason">{row.reason}</p>}
  </>
}

/** A body clamped to three lines until expanded (team-workspace-pages 5.4). */
function ClampedBody({ body }: { body: string }) {
  const [full, setFull] = useState(false)
  return <div data-testid="message-body-clamped">
    <p className={`whitespace-pre-wrap text-chat-body ${full ? '' : 'line-clamp-3'}`} data-testid="message-body">{body}</p>
    <button type="button" className="btn text-chat-meta" data-testid="message-body-toggle"
      aria-expanded={full} onClick={() => setFull(value => !value)}>
      {full ? 'Show less' : 'Show full'}
    </button>
  </div>
}

/** Where the row goes now — a group, a named session, or the human. */
function Recipient({ row, sessions, names, onOpenSession }: {
  row: TeamMessage
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
}) {
  if (row.toKind === 'human') return <span data-testid="message-to">Human</span>
  if (row.toKind === 'group') return <span data-testid="message-to">group {row.toId}</span>
  return <span data-testid="message-to">
    <ParticipantName sessionId={row.toId} sessions={sessions} directory={names} onOpen={onOpenSession} />
  </span>
}

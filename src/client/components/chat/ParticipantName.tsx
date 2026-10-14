// A message participant named for display (team-message-threads D3): the
// session's current name, or a killed session's recorded name with `(gone)`,
// or the human. The role (group) badge and the raw id ride along — the id is
// expandable metadata, never the primary label. Clicking opens the chat only
// for a participant that still exists.
import type { ParticipantLabel, SessionDirectoryEntry } from '@shared/team'
import {
  humanParticipant,
  participantName,
  resolveParticipant,
  type LiveParticipant,
} from '@shared/participants'

export interface ParticipantNameProps {
  sessionId: string | null
  /** Human senders have no session and label as `Human`. */
  senderKind?: 'agent' | 'human'
  sessions?: ReadonlyArray<LiveParticipant>
  directory?: ReadonlyArray<SessionDirectoryEntry>
  /** Present for live or archived sessions; omit to disable navigation. */
  onOpen?: (sessionId: string) => void
}

export function participantLabelFor(props: Pick<ParticipantNameProps, 'sessionId' | 'senderKind' | 'sessions' | 'directory'>): ParticipantLabel {
  if (props.senderKind === 'human' || props.sessionId === null) return humanParticipant()
  return resolveParticipant(props.sessionId, props.sessions ?? [], props.directory ?? [])
}

export default function ParticipantName(props: ParticipantNameProps) {
  const label = participantLabelFor(props)
  const open = props.onOpen && !label.gone && label.id !== null
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-testid="participant">
    {open
      ? <button type="button" className="truncate underline-offset-2 hover:underline" data-testid="participant-name"
        onClick={() => props.onOpen!(label.id!)}>{participantName(label)}</button>
      : <span className="truncate" data-testid="participant-name">{participantName(label)}</span>}
    {label.group !== null && <span className="shrink-0" data-testid="participant-group">{label.group}</span>}
    <details className="shrink-0" data-testid="participant-id">
      <summary className="cursor-pointer select-none">id</summary>
      <span className="break-all">{label.id ?? 'human'}</span>
    </details>
  </span>
}

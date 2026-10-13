// Naming a message participant (team-message-threads D3): live sessions win,
// the durable directory answers for killed ones, and anything else is the raw
// id marked gone. Pure and SDK-free so the client's views and the server's
// read models label people the same way.
import type { ParticipantLabel, SessionDirectoryEntry } from './team'

export interface LiveParticipant {
  id: string
  name: string
  groupId?: string | null
}

/**
 * Label a participant by session id. A live or archived session row is
 * authoritative for the name and role; a directory entry keeps a killed
 * session's identity. Looking one up never creates or restores a session —
 * `gone` is what tells the view not to navigate.
 */
export function resolveParticipant(
  sessionId: string,
  sessions: ReadonlyArray<LiveParticipant>,
  directory: ReadonlyArray<SessionDirectoryEntry> = []
): ParticipantLabel {
  const live = sessions.find(row => row.id === sessionId)
  if (live) return { id: sessionId, name: live.name, group: live.groupId ?? null, gone: false }
  const recorded = directory.find(row => row.sessionId === sessionId)
  if (recorded) return { id: sessionId, name: recorded.name, group: recorded.group, gone: true }
  return { id: sessionId, name: sessionId, group: null, gone: true }
}

/** The human, who is a sender without a session. */
export function humanParticipant(): ParticipantLabel {
  return { id: null, name: 'Human', group: null, gone: false }
}

/** Display text: a gone participant keeps its name with the unavailable mark. */
export function participantName(label: ParticipantLabel): string {
  return label.gone ? `${label.name} (gone)` : label.name
}

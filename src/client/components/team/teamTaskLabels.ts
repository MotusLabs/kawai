// Display helpers shared by the task list and detail: who an actor is (a
// session's current name, or its id marked gone once the session was killed).
import type { Session } from '@shared/types'
import type { ActingParty } from '@shared/team'
import type { JournalAuthor } from '@shared/teamTasks'

export function sessionLabel(sessionId: string, sessions: Session[]): string {
  const session = sessions.find(row => row.id === sessionId)
  return session ? session.name : `${sessionId} (gone)`
}

/** A creator, dispatcher, sender, acceptor, or author: the human, Kawai (plan-execution D2), or a session. */
export function actorLabel(actor: ActingParty, sessions: Session[]): string {
  switch (actor.kind) {
    case 'human': return 'Human'
    case 'system': return 'Kawai'
    case 'agent': return sessionLabel(actor.sessionId, sessions)
    default: {
      const never: never = actor
      return String(never)
    }
  }
}

/** A journal author: an actor, or Kawai itself for system entries. */
export function journalAuthorLabel(author: JournalAuthor, sessions: Session[]): string {
  return actorLabel(author, sessions)
}

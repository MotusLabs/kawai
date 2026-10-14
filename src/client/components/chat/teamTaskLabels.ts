// Display helpers shared by the task list and detail: who an actor is (a
// session's current name, or its id marked gone once the session was killed).
import type { Session } from '@shared/types'
import type { JournalAuthor, TaskActor } from '@shared/teamTasks'

export function sessionLabel(sessionId: string, sessions: Session[]): string {
  const session = sessions.find(row => row.id === sessionId)
  return session ? session.name : `${sessionId} (gone)`
}

export function actorLabel(actor: TaskActor, sessions: Session[]): string {
  return actor.kind === 'human' ? 'Human' : sessionLabel(actor.sessionId, sessions)
}

/** A journal author: an actor, or kawai itself for system entries (D4). */
export function journalAuthorLabel(author: JournalAuthor, sessions: Session[]): string {
  return author.kind === 'system' ? 'Kawai' : actorLabel(author, sessions)
}

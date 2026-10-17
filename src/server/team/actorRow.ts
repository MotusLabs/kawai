// Actor columns read back from rows (plan-execution D2). Creator,
// dispatcher, sender, acceptor, and journal-author columns hold `system` for
// Kawai with a null session; it reads back as Kawai, never as the human.
// Result submitters and findings authors stay `TeamActor` (`actorFromRow`).
import { SYSTEM_ACTOR, type ActingParty, type TeamActor } from '../../shared/team'

/** An `agent` row with its session, else the human: the columns that never hold `system`. */
export function actorFromRow(kind: unknown, session: unknown): TeamActor {
  return kind === 'agent' && typeof session === 'string' ? { kind: 'agent', sessionId: session } : { kind: 'human', sessionId: null }
}

/** How text names a party: the human, Kawai, or the session id. */
export function partyName(party: ActingParty): string {
  switch (party.kind) {
    case 'human': return 'the human'
    case 'system': return 'Kawai'
    case 'agent': return party.sessionId
    default: {
      const never: never = party
      return String(never)
    }
  }
}

/** Like `actorFromRow`, but `system` reads back as Kawai. */
export function partyFromRow(kind: unknown, session: unknown): ActingParty {
  return kind === 'system' ? SYSTEM_ACTOR : actorFromRow(kind, session)
}

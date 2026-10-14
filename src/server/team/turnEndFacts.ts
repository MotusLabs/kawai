// The morning summary's turn-end facts (team-workspace D8), maintained
// incrementally. A naive cache keyed on `lastActivityAt` would replay the
// whole transcript on every turn — the stamp moves each turn, and
// `turn_completed` is itself a publish trigger — so live events append here
// instead, and the transcript is replayed exactly once per session, at the
// first snapshot that needs it after a restart or an open.
import type { ChatSessionRecord } from '../db'

/** One turn-end fact the summary reads, pre-extracted from a transcript or event. */
export interface TurnEndFact {
  sessionId: string
  taskId: string | null
  at: string
}

/** The transcript events a session is seeded from, oldest first. */
export type HistoryEvents = (sessionId: string) => Array<{ type: string; at: string }> | null

interface Entry {
  /** Whether the one-time transcript replay has happened for this session. */
  seeded: boolean
  facts: TurnEndFact[]
}

export class TurnEndFacts {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly historyEvents: HistoryEvents) {}

  /** A live `turn_completed` event: append, never replay. */
  record(sessionId: string, taskId: string | null, at: string): void {
    const entry = this.entries.get(sessionId) ?? { seeded: false, facts: [] }
    entry.facts.push({ sessionId, taskId, at })
    this.entries.set(sessionId, entry)
  }

  /**
   * Facts for these records. A task-bound session seen for the first time is
   * seeded by one transcript replay; later reads and live events append only.
   * Entries for sessions no longer in the record set (killed ones — records
   * keep archived sessions) are pruned. An archived session's facts stay:
   * its turns still fall inside the 24-hour window, and dropping them would
   * force the replay the ledger exists to avoid.
   */
  forRecords(records: ChatSessionRecord[]): TurnEndFact[] {
    const present = new Set(records.map(record => record.sessionId))
    const gone = [...this.entries.keys()].filter(sessionId => !present.has(sessionId))
    for (const sessionId of gone) this.entries.delete(sessionId)
    const out: TurnEndFact[] = []
    for (const record of records) {
      const { sessionId } = record
      const taskId = record.taskId
      if (!taskId) continue
      let entry = this.entries.get(sessionId)
      if (!entry?.seeded) {
        const seeded = (this.historyEvents(sessionId) ?? [])
          .filter(event => event.type === 'turn_completed')
          .map(event => ({ sessionId, taskId, at: event.at }))
        // Live events recorded before the seeding usually describe turns the
        // transcript already holds; keep only those it does not.
        const live = entry ? entry.facts.filter(fact =>
          !seeded.some(seededFact => seededFact.at === fact.at && seededFact.taskId === fact.taskId)
        ) : []
        entry = { seeded: true, facts: [...seeded, ...live] }
        this.entries.set(sessionId, entry)
      }
      out.push(...entry.facts)
    }
    return out
  }
}

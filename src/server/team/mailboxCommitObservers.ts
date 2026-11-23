import type { Database } from 'bun:sqlite'

type Observation = 'changed' | 'enqueued'

/** Defer this command's observations until its outermost synchronous writer commits. */
export class MailboxCommitObservers {
  private pending: Map<string, Set<Observation>> | null = null

  constructor(private readonly db: Database, private readonly emit: (id: string, kind: Observation, committed: boolean) => void) {}

  observe(id: string, kind: Observation): void {
    if (!this.pending) return this.emit(id, kind, false)
    const kinds = this.pending.get(id) ?? new Set<Observation>()
    kinds.add(kind)
    this.pending.set(id, kinds)
  }

  write<T>(change: () => T): T {
    if (this.db.inTransaction || this.pending) throw new Error('Committed mailbox observations require the outer writer transaction')
    const pending = new Map<string, Set<Observation>>()
    this.pending = pending
    let result: T
    try {
      result = this.db.transaction(change).immediate()
    } finally {
      this.pending = null
    }
    for (const [id, kinds] of pending) {
      for (const kind of kinds) this.emit(id, kind, true)
    }
    return result
  }
}

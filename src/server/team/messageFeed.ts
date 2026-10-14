// The live half of the Messages read model (team-message-threads 4.3): store
// changes fan out to each watcher as a push of the changed rows, and every
// watch starts from an authoritative snapshot of its own filters — the
// discipline team-tasks already uses, so a reconnect needs no deltas. Pushes
// carry the changed rows unfiltered: a watcher that no longer matches one of
// them (a queued row that was just claimed) still has to drop it, which only
// the client's own filters can decide. Watchers are per team; a row of another
// team is never pushed across.
import type { TeamMessage } from '../../shared/team'
import type { MailboxStore } from './mailboxStore'
import type {
  MessageCursor,
  MessagePage,
  MessageQuery,
  MessageQueryFilters,
} from './messageQuery'

/** What a watcher receives: its own first page, then the rows that changed. */
export type MessageFeedEvent =
  | { kind: 'snapshot'; page: MessagePage }
  | { kind: 'changed'; messages: TeamMessage[] }

export type MessageFeedWatcher = (event: MessageFeedEvent) => void

interface Watch {
  teamId: string
  filters: MessageQueryFilters
  emit: MessageFeedWatcher
}

export class MessageFeed {
  private readonly watches = new Set<Watch>()
  private readonly releaseStore: () => void

  constructor(readonly store: MailboxStore, private readonly query: MessageQuery) {
    this.releaseStore = store.subscribe((teamId, message) => this.changed(teamId, message))
  }

  /**
   * Watch one team's mail under some filters. The first event is always the
   * authoritative snapshot of those filters — also what a reconnecting
   * watcher gets when it registers again.
   */
  watch(teamId: string, filters: MessageQueryFilters, emit: MessageFeedWatcher): () => void {
    const watch: Watch = { teamId, filters, emit }
    this.watches.add(watch)
    emit({ kind: 'snapshot', page: this.snapshot(teamId, filters) })
    return () => { this.watches.delete(watch) }
  }

  /** The authoritative page for these filters (open, reconnect, page change). */
  snapshot(
    teamId: string,
    filters: MessageQueryFilters = {},
    cursor: MessageCursor | null = null,
    limit?: number,
  ): MessagePage {
    return this.query.list(teamId, filters, cursor, limit)
  }

  /** One thread with its append-only events. */
  thread(teamId: string, threadId: string) {
    return this.query.thread(teamId, threadId)
  }

  /** Stop listening to the store (server shutdown, test teardown). */
  close() {
    this.releaseStore()
    this.watches.clear()
  }

  private changed(teamId: string, message?: TeamMessage) {
    if (!message) return
    for (const watch of this.watches) {
      if (watch.teamId === teamId) watch.emit({ kind: 'changed', messages: [message] })
    }
  }
}

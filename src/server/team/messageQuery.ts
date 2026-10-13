// One read model over the durable rows (team-message-threads D1): delivered
// history and pending mail of a team in one filterable, keyset-paged list,
// plus one thread's messages with their append-only events. The rows the
// dispatcher writes are the history — there is no projection table to drift.
// Paging is newest first over `(created_at, rowid)`, the key `MailboxStore`
// already writes and orders by. Every query is scoped to one team, so
// another team's rows are unreachable by construction.
import type { Database } from 'bun:sqlite'
import type {
  MessageEvent,
  MessagePriority,
  MessageState,
  TeamMessage,
} from '../../shared/team'
import { MessageEventLog } from './messageEvents'
import { mapRow } from './messageRow'

export interface MessageQueryFilters {
  /** Task the message works under. */
  taskId?: string
  /** Thread the message belongs to. */
  threadId?: string
  /**
   * Role involvement (the spec's "role"): the recipient group of group mail,
   * or the sender's group. Absent keeps every role.
   */
  groupId?: string
  /**
   * Session involvement: sender, current recipient, or claimant. Absent keeps
   * every session.
   */
  sessionId?: string
  priority?: MessagePriority
  /** One state or several; absent keeps every delivery state. */
  state?: MessageState | MessageState[]
  /**
   * Human involvement: `true` keeps only mail to or from the human, `false`
   * only agent-to-agent mail. Absent keeps both.
   */
  human?: boolean
}

/** Keyset position: the row after which the next (older) page starts. */
export interface MessageCursor {
  createdAt: string
  rowid: number
}

export interface MessagePage {
  messages: TeamMessage[]
  /** Key of the last row, for the next older page; null when exhausted. */
  nextCursor: MessageCursor | null
}

/** One thread row with the history that happened to it. */
export interface ThreadEntry {
  message: TeamMessage
  events: MessageEvent[]
}

/** How many rows one page holds when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 50

type SqlFragment = { clause: string; params: Record<string, string> }

export class MessageQuery {
  private readonly events: MessageEventLog

  constructor(private readonly db: Database) {
    this.events = new MessageEventLog(db)
  }

  /**
   * Delivered and pending mail of one team together, newest first. Each page
   * continues from `cursor` with rows strictly older than it.
   */
  list(
    teamId: string,
    filters: MessageQueryFilters = {},
    cursor: MessageCursor | null = null,
    limit = DEFAULT_PAGE_SIZE,
  ): MessagePage {
    const bound: Record<string, string | number> = { $teamId: teamId, $limit: limit + 1 }
    const where = ['team_id = $teamId']
    for (const fragment of this.clauses(filters)) {
      where.push(fragment.clause)
      Object.assign(bound, fragment.params)
    }
    if (cursor) {
      // Strictly older than the cursor in the newest-first order.
      where.push('(created_at < $cursorAt OR (created_at = $cursorAt AND rowid < $cursorRowid))')
      bound.$cursorAt = cursor.createdAt
      bound.$cursorRowid = cursor.rowid
    }
    const rows = this.db.prepare(
      `SELECT * FROM team_messages WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, rowid DESC LIMIT $limit`
    ).all(bound) as Record<string, unknown>[]
    // Fetch one past the page: its presence says an older page exists. The
    // cursor is the page's own last row, so the next page is everything
    // strictly older than it.
    const messages = rows.slice(0, limit).map(mapRow)
    const last = rows[limit - 1]
    return {
      messages,
      nextCursor: rows.length > limit && last
        ? { createdAt: String(last.created_at), rowid: Number(last.rowid) }
        : null,
    }
  }

  /**
   * One thread's messages in chronological order, each with its own history.
   * Team-scoped like the list: another team's thread is simply empty.
   */
  thread(teamId: string, threadId: string): ThreadEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM team_messages WHERE team_id = $teamId AND thread_id = $threadId
       ORDER BY created_at, rowid`
    ).all({ $teamId: teamId, $threadId: threadId }) as Record<string, unknown>[]
    return rows.map(row => {
      const message = mapRow(row)
      return { message, events: this.events.forMessage(message.id) }
    })
  }

  /** Every event of every message of a thread, per message then per seq. */
  threadEvents(threadId: string): MessageEvent[] {
    return this.events.forThread(threadId)
  }

  private clauses(filters: MessageQueryFilters): SqlFragment[] {
    const where: SqlFragment[] = []
    if (filters.taskId !== undefined) {
      where.push({ clause: 'task_id = $taskId', params: { $taskId: filters.taskId } })
    }
    if (filters.threadId !== undefined) {
      where.push({ clause: 'thread_id = $threadId', params: { $threadId: filters.threadId } })
    }
    if (filters.groupId !== undefined) {
      where.push({
        clause: '((to_kind = \'group\' AND to_id = $groupId) OR from_group = $groupId)',
        params: { $groupId: filters.groupId },
      })
    }
    if (filters.sessionId !== undefined) {
      where.push({
        clause: '(from_session = $sessionId OR (to_kind = \'session\' AND to_id = $sessionId) OR claimed_by = $sessionId)',
        params: { $sessionId: filters.sessionId },
      })
    }
    if (filters.priority !== undefined) {
      where.push({ clause: 'priority = $priority', params: { $priority: filters.priority } })
    }
    if (filters.state !== undefined) {
      const states = Array.isArray(filters.state) ? filters.state : [filters.state]
      if (states.length === 0) throw new Error('A state filter needs at least one state')
      const params: Record<string, string> = {}
      const names = states.map((state, index) => {
        const name = `$state${index}`
        params[name] = state
        return name
      })
      where.push({ clause: `state IN (${names.join(', ')})`, params })
    }
    if (filters.human === true) {
      where.push({ clause: '(from_kind = \'human\' OR to_kind = \'human\')', params: {} })
    }
    if (filters.human === false) {
      where.push({ clause: '(from_kind = \'agent\' AND to_kind <> \'human\')', params: {} })
    }
    return where
  }
}

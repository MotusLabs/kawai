// Agent-side mailbox management (team-mailbox-management D1/D6): cancel,
// discard, and a scoped listing over the team's mail. This is the one place
// rights live — the store is rights-free and shared with the human panel.
// Every call resolves the caller's session, team, and *current* group file, so
// an edited `canManageMailbox` applies to the next call. A refusal throws a
// reason before anything is written; the store's conditional update stays the
// authority under races. Other-team ids read as not found.
import type { ChatSessionRecord } from '../db'
import type { MessageState, TeamMessage, WaitingConstraint, WaitingReason } from '../../shared/team'
import { logger } from '../logger'
import { loadTeamGroups } from './teamGroups'
import type { TeamIdentity } from './teamIdentity'
import type { CancelResult, MailboxStore } from './mailboxStore'
import type { TaskService } from './TaskService'

/** Longest body returned by `list`; cap on rows per call. */
export const LIST_BODY_LIMIT = 300
export const LIST_ROW_LIMIT = 100
/** Agent-cancellable states (a parked message additionally needs management). */
const CANCEL_STATES: MessageState[] = ['queued', 'awaiting-request']
const DISCARD_STATES: MessageState[] = ['dead', 'uncertain']

export interface MailboxListFilters {
  state?: MessageState[]
  /** Recipient session or group id. */
  to?: string
  /** Sender session id. */
  from?: string
  task_id?: string
}

export interface MailboxListEntry {
  id: string
  state: MessageState
  priority: string
  from: { kind: 'agent' | 'human' | 'system'; session: string | null; group: string | null }
  to: { kind: 'group' | 'session' | 'human'; id: string | null }
  claimedBy: string | null
  taskId: string | null
  createdAt: string
  ageMinutes: number
  deliverAt: string | null
  parkedUntil: string | null
  reason: string | null
  /** The immediate blocker while the message waits, from the dispatcher's reasons. */
  waiting: WaitingConstraint | null
  body: string
  bodyTruncated: boolean
}

export interface MailboxListResult {
  scope: 'team' | 'own'
  messages: MailboxListEntry[]
  omitted: number
}

/** The store's integrity refusals as sentences; null for a plain state change. */
export function cancelRefusalText(result: CancelResult): string | null {
  if (result.ok) return null
  if (result.code === 'resume-in-flight') {
    return `${result.holder ?? 'its holder'} is resuming this parked work now. The cancel is refused until that turn ends: message the holder directly (urgent mail interrupts) or try again afterwards.`
  }
  if (result.code === 'linked-resume') {
    return `This is the resume message of parked work ${result.parkedId}. Cancel the parked message ${result.parkedId} instead; it cancels the resume with it.`
  }
  return null
}

const stateText = (message: TeamMessage): string => {
  switch (message.state) {
    case 'claimed': return `claimed by ${message.claimedBy ?? 'a recipient'}; its delivery is in progress`
    case 'spawning': return 'a member is starting for it'
    case 'parked': return 'parked on its holder'
    default: return message.state
  }
}

export class MailboxManagement {
  constructor(private readonly store: MailboxStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    tasks: TaskService
    /** The team's in-memory waiting reasons by message id. */
    waitingFor?: (teamId: string) => Record<string, WaitingReason>
    homeDir?: string
    now?: () => number
  }) {}

  /** The caller's team and whether its group currently holds management. */
  private async context(sessionId: string): Promise<{ team: TeamIdentity; manager: boolean }> {
    const session = this.options.getSession(sessionId)
    if (!session) throw new Error(`Unknown calling session: ${sessionId}`)
    const { team, catalog } = await loadTeamGroups(session.projectPath, this.options.homeDir)
    const group = session.groupId ? catalog.groups.get(session.groupId)?.group : undefined
    return { team, manager: group?.canManageMailbox === true }
  }

  private teamMessage(team: TeamIdentity, id: string): TeamMessage {
    const message = this.store.get(id)
    if (!message || message.teamId !== team.teamId) throw new Error(`Message not found in this team: ${id}`)
    return message
  }

  private reasonOf(reason: string | undefined): string {
    const text = reason?.trim()
    if (!text) throw new Error('A reason is required. Say why this message is being cancelled or discarded.')
    return text
  }

  /** Cancel undelivered mail: one's own while queued, or any (and parked work) as a manager. */
  async cancel(sessionId: string, input: { message_id: string; reason?: string }) {
    const { team, manager } = await this.context(sessionId)
    const message = this.teamMessage(team, input.message_id)
    const isSender = message.fromKind === 'agent' && message.fromSession === sessionId
    if (!isSender && !manager) {
      throw new Error(`Message ${message.id} was not sent by you. Only its sender, a group with mailbox management, or the human can cancel it.`)
    }
    const reason = this.reasonOf(input.reason)
    if (message.state === 'parked') {
      if (!manager) throw new Error(`Message ${message.id} is parked work on ${message.claimedBy ?? 'its holder'}. Only a group with mailbox management or the human can cancel parked work.`)
    } else if (!CANCEL_STATES.includes(message.state)) {
      throw new Error(`Message ${message.id} cannot be cancelled: it is ${stateText(message)}. Only queued, scheduled, or awaiting-request mail${manager ? ', or parked work,' : ''} can be cancelled.`)
    }
    const resumeId = message.state === 'parked' ? message.resumeMessageId : null
    const result = this.store.cancelResult(message.id, { kind: 'agent', sessionId }, reason)
    if (!result.ok) {
      const refusal = cancelRefusalText(result)
      throw new Error(refusal
        ? `Message ${message.id} was not cancelled. ${refusal} Nothing changed.`
        : `Message ${message.id} state changed to ${result.code === 'state-changed' ? result.state ?? 'unknown' : 'unknown'}; nothing was cancelled.`)
    }
    await this.journal(sessionId, message, 'Cancelled', reason)
    return { id: message.id, state: 'cancelled' as const, ...(resumeId ? { resumeMessage: resumeId } : {}) }
  }

  /** Discard a dead or uncertain message for good; managers only. */
  async discard(sessionId: string, input: { message_id: string; reason?: string }) {
    const { team, manager } = await this.context(sessionId)
    const message = this.teamMessage(team, input.message_id)
    if (!manager) throw new Error('Only a group with mailbox management or the human can discard dead or uncertain mail.')
    const reason = this.reasonOf(input.reason)
    if (!DISCARD_STATES.includes(message.state)) {
      throw new Error(`Message ${message.id} cannot be discarded: it is ${stateText(message)}. Only dead or uncertain mail can be discarded.`)
    }
    if (!this.store.discard(message.id, { kind: 'agent', sessionId }, reason)) {
      throw new Error(`Message ${message.id} state changed to ${this.store.get(message.id)?.state ?? 'unknown'}; nothing was discarded.`)
    }
    await this.journal(sessionId, message, 'Discarded', reason)
    return { id: message.id, state: 'discarded' as const }
  }

  /**
   * The acting agent's journal note (D5). A failure is logged and never undoes
   * the mailbox action: the event log stays the record.
   */
  private async journal(sessionId: string, message: TeamMessage, verb: string, reason: string) {
    if (!message.taskId) return
    const to = message.toId ? `${message.toKind} ${message.toId}` : message.toKind
    try {
      await this.options.tasks.note(
        { kind: 'agent', sessionId }, message.taskId,
        `${verb} message ${message.id} to ${to} (${message.state}): ${reason}`
      )
    } catch (error) {
      logger.warn('team_mailbox_management_journal_failed', { messageId: message.id, taskId: message.taskId, error: String(error) })
    }
  }

  /** Unsettled team mail, scoped by right (D6). */
  async list(sessionId: string, filters: MailboxListFilters = {}): Promise<MailboxListResult> {
    const { team, manager } = await this.context(sessionId)
    const waiting = this.options.waitingFor?.(team.teamId) ?? {}
    const now = this.options.now?.() ?? Date.now()
    const rows = this.store.listForTeam(team.teamId)
      .filter(row => manager || row.fromSession === sessionId || (row.toKind === 'session' && row.toId === sessionId) || row.claimedBy === sessionId)
      .filter(row => !filters.state?.length || filters.state.includes(row.state))
      .filter(row => !filters.to || row.toId === filters.to)
      .filter(row => !filters.from || row.fromSession === filters.from)
      .filter(row => !filters.task_id || row.taskId === filters.task_id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const shown = rows.slice(0, LIST_ROW_LIMIT)
    return {
      scope: manager ? 'team' : 'own',
      messages: shown.map(row => ({
        id: row.id, state: row.state, priority: row.priority,
        from: { kind: row.fromKind, session: row.fromSession, group: row.fromGroup },
        to: { kind: row.toKind, id: row.toId },
        claimedBy: row.claimedBy, taskId: row.taskId, createdAt: row.createdAt,
        ageMinutes: Math.max(0, Math.round((now - Date.parse(row.createdAt)) / 60_000)),
        deliverAt: row.deliverAt, parkedUntil: row.parkedUntil, reason: row.reason,
        waiting: waiting[row.id]?.blocker ?? null,
        body: row.body.slice(0, LIST_BODY_LIMIT), bodyTruncated: row.body.length > LIST_BODY_LIMIT,
      })),
      omitted: rows.length - shown.length,
    }
  }
}

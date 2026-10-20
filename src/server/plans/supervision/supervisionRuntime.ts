// The production `SupervisionRuntime` (plan-supervision design D10): the
// instruction holder's session facts and the mailbox blocker, read from the
// session record, its driver, the manager's worker and background-task
// rosters, the mailbox store, the waiting-reason ledger, the cooldown rule,
// and the turn-end record. A killed holder (no record) reads gone, and so
// idle, like an archived one. Reads only.
import type { Database } from 'bun:sqlite'
import type { HolderFacts } from '../../../shared/planSupervision'
import type { ChatPendingRequest } from '../../../shared/chat'
import type { WaitingReason } from '../../../shared/team'
import type { ChatSessionRecord } from '../../db'
import type { MailboxStore } from '../../team/mailboxStore'
import type { SupervisionRuntime } from './supervisionRead'

export interface SupervisionRuntimeDeps {
  db: Database
  mail: MailboxStore
  getRecord: (sessionId: string) => ChatSessionRecord | undefined
  pendingRequests: (sessionId: string) => ChatPendingRequest[]
  hasLiveWorkers: (sessionId: string) => boolean
  hasRunningBackgroundTasks: (sessionId: string) => boolean
  /** The mailbox's waiting reasons of the team's unsettled mail. */
  waitingFor: (teamId: string) => Record<string, WaitingReason>
  /** The record's profile cooldown end (the router's rule); null when it is not cooling. */
  cooldownUntil: (record: ChatSessionRecord) => string | null
  now?: () => Date
}

const newest = (times: Array<string | null | undefined>): string | null =>
  times.reduce<string | null>((best, time) => (time != null && (best === null || time > best) ? time : best), null)

export function supervisionRuntime(deps: SupervisionRuntimeDeps): SupervisionRuntime {
  const lastTurnEnd = deps.db.prepare('SELECT MAX(ended_at) AS at FROM chat_turn_ends WHERE session_id = ? AND task_id = ?')
  const lastTaskMail = deps.db.prepare(`SELECT MAX(COALESCE(delivered_at, created_at)) AS at FROM team_messages
    WHERE task_id = ? AND (from_session = ? OR claimed_by = ? OR (to_kind = 'session' AND to_id = ?))`)
  return {
    holder: (session, taskId): HolderFacts => {
      const record = deps.getRecord(session)
      const turnEnd = taskId === null ? null : (lastTurnEnd.get(session, taskId) as { at: string | null } | null)?.at ?? null
      const mail = taskId === null ? null : (lastTaskMail.get(taskId, session, session, session) as { at: string | null } | null)?.at ?? null
      const base = { session, lastTurnEndAt: turnEnd, lastTaskMailAt: mail }
      if (record === undefined) {
        return { ...base, group: null, profile: null, gone: true, turnRunning: false, pendingRequest: null, backgroundTasks: 0, workers: 0, dueDirectMail: false, parkedUntil: null, coolingUntil: null }
      }
      const pending = deps.pendingRequests(session)[0]
      const now = (deps.now?.() ?? new Date()).toISOString()
      return {
        ...base,
        group: record.groupId ?? null,
        profile: record.claudeProfileId ?? 'default',
        gone: record.archivedAt != null,
        turnRunning: record.status === 'working',
        pendingRequest: pending === undefined ? null : pending.kind === 'approval' ? 'approval' : 'question',
        backgroundTasks: deps.hasRunningBackgroundTasks(session) ? 1 : 0,
        workers: deps.hasLiveWorkers(session) ? 1 : 0,
        dueDirectMail: deps.mail.waitingDirectMail(now).some(row => row.toId === session),
        parkedUntil: newest(deps.mail.parkedBy(session).map(row => row.parkedUntil)),
        coolingUntil: deps.cooldownUntil(record),
      }
    },
    blocker: messageId => {
      const message = deps.mail.get(messageId)
      if (message === null) return null
      return deps.waitingFor(message.teamId)[messageId]?.blocker.kind ?? null
    },
  }
}

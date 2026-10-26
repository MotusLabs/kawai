// A member's recipient facts from its session record and the mailbox alone,
// for tests that build an AssignmentService without the dispatcher's
// recipient view (production wires SessionMailbox's own `recipient`).
import type { ChatSessionRecord } from '../../db'
import type { MailRecipient } from '../../team/dispatcher'
import type { MailboxStore } from '../../team/mailboxStore'
import { worktreeRootOf } from '../../team/worktreeRoots'

export function recordRecipient(record: ChatSessionRecord | undefined, teamId: string, mail: MailboxStore): MailRecipient | undefined {
  if (!record) return undefined
  return {
    sessionId: record.sessionId, teamId, groupId: record.groupId ?? null, idle: record.status === 'waiting', pendingRequest: false,
    available: true, worktree: worktreeRootOf(record.projectPath), parked: mail.parkedBy(record.sessionId).length > 0,
    contextExhausted: Boolean(record.contextExhausted), profileId: record.claudeProfileId ?? 'default',
  }
}

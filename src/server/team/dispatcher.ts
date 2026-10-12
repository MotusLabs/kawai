// Durable mailbox dispatch, serialized across asynchronous agent startup.
// Idleness is checked again inside the atomic claim; SDK queues receive only
// idle turns, except urgent direct mail after an acknowledged interrupt.
// Group mail whose task targets a worktree (team-tasks D4) only goes to a
// member whose resolved worktree is that target; after the idle pass a
// staffing hook may spawn a member for mail nobody could take, and the
// reserved message becomes the new member's first turn.
import type { ChatPeerMessage } from '../../shared/chat'
import type { ChatPeerTaskContext } from '../../shared/teamTasks'
import type { TeamMessage } from './mailboxStore'
import { MailboxStore } from './mailboxStore'
import { messageEnvelope } from './envelope'

export interface MailRecipient {
  sessionId: string
  teamId: string
  groupId: string | null
  idle: boolean
  pendingRequest: boolean
  available: boolean
  /** The worktree root containing the member's current project path. */
  worktree?: string
}

/** Mail reserved for a freshly spawned member, to deliver as its first turn. */
export interface SpawnAssignment {
  message: TeamMessage
  sessionId: string
}

export class MailDispatcher {
  private idleSince = new Map<string, number>()
  private ordinal = 0
  private requested = false
  private running: Promise<void> | null = null
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly store: MailboxStore, private readonly options: {
    recipients: () => MailRecipient[]
    recipient?: (id: string) => MailRecipient | undefined
    beginCycle?: () => void
    prepare: (sessionId: string) => Promise<void>
    interrupt: (sessionId: string) => Promise<void>
    deliver: (sessionId: string, envelope: ChatPeerMessage) => void
    watchReceipt: (message: TeamMessage) => void
    /** The task section for a delivery, read now (team-tasks D3). */
    taskContext?: (taskId: string | null) => ChatPeerTaskContext | null
    /** A task message was pushed to this session: it now works on that task. */
    associateTask?: (sessionId: string, taskId: string) => void
    /** Target worktree root of group mail under a worktree task; null = any member. */
    targetWorktree?: (message: TeamMessage) => string | null
    /** Spawn members for worktree mail no idle member could take (team-tasks D4). */
    staff?: () => Promise<SpawnAssignment[]>
    onError?: (error: unknown) => void
  }) {}

  /** Whether a member may take a message given its task's target worktree. */
  private inWorktree(recipient: MailRecipient | undefined, message: TeamMessage): boolean {
    if (message.toKind !== 'group' || !this.options.targetWorktree) return true
    const target = this.options.targetWorktree(message)
    return target === null || recipient?.worktree === target
  }

  notify(): void {
    if (this.closed) return
    this.requested = true
    if (this.running) return
    this.running = Promise.resolve().then(async () => {
      while (this.requested && !this.closed) {
        this.requested = false
        await this.dispatch()
      }
    }).catch(error => this.options.onError?.(error)).finally(() => {
      this.running = null
      this.armTimer()
      if (this.requested) this.notify()
    })
  }

  /** Tests and startup callers can await all work requested so far. */
  async settled(): Promise<void> {
    while (this.running) await this.running
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private current(id: string) { return this.options.recipient ? this.options.recipient(id) : this.options.recipients().find(row => row.sessionId === id) }

  private async dispatch() {
    this.options.beginCycle?.()
    const recipients = this.options.recipients()
    const ids = new Set(recipients.map(row => row.sessionId))
    for (const id of this.idleSince.keys()) if (!ids.has(id)) this.idleSince.delete(id)
    for (const row of recipients) {
      if (row.idle && row.available && !row.pendingRequest) {
        if (!this.idleSince.has(row.sessionId)) this.idleSince.set(row.sessionId, ++this.ordinal)
      } else this.idleSince.delete(row.sessionId)
    }
    // Urgent direct mail is the only path that may stop a busy recipient.
    for (const row of recipients.filter(row => row.available)) {
      for (const held of this.store.awaitingRequestFor(row.sessionId)) {
        if (!row.pendingRequest) this.store.requeue(held.id)
      }
      const urgent = this.store.urgentDirectFor(row.sessionId)
      for (const message of urgent) {
        if (this.current(row.sessionId)?.pendingRequest) {
          this.store.holdForRequest(message.id)
          continue
        }
        if (!this.current(row.sessionId)?.idle) {
          await this.push(message, row, true)
          break
        }
      }
    }
    const idle = recipients.filter(row => this.idleSince.has(row.sessionId))
      .sort((a, b) => this.idleSince.get(a.sessionId)! - this.idleSince.get(b.sessionId)!)
    for (const row of idle) {
      const message = this.store.nextEligible({ teamId: row.teamId, sessionId: row.sessionId, groupId: row.groupId },
        undefined, candidate => this.inWorktree(row, candidate))
      if (message) await this.push(message, row, false)
    }
    if (this.closed || !this.options.staff) return
    for (const assignment of await this.options.staff()) {
      const recipient = this.current(assignment.sessionId)
      if (recipient) await this.push(assignment.message, recipient, false, true)
      // Not delivered as the first turn (the member was not ready or went
      // away): back to the queue, where the member can still pick it up.
      if (this.store.get(assignment.message.id)?.state === 'spawning') this.store.requeue(assignment.message.id)
    }
  }

  private async push(message: TeamMessage, recipient: MailRecipient, interrupt: boolean, reserved = false) {
    try {
      await this.options.prepare(recipient.sessionId)
      if (this.closed) return
      const eligible = () => {
        const current = this.current(recipient.sessionId)
        return !!current?.available && !current.pendingRequest && current.teamId === message.teamId &&
          (interrupt || current.idle) && (message.toKind === 'session' || current.groupId === message.toId) &&
          this.inWorktree(current, message)
      }
      if (!this.store.claimWhen(message.id, recipient.sessionId, eligible, reserved)) return
      this.idleSince.delete(recipient.sessionId)
      if (interrupt) await this.options.interrupt(recipient.sessionId)
      const current = this.current(recipient.sessionId)
      // The awaited interrupt allows a human turn/card to arrive. Re-check
      // before recording a push so a refused submission cannot strand mail.
      if (this.closed || !current?.available || !current.idle || current.pendingRequest) {
        this.store.requeue(message.id)
        if (current?.pendingRequest) this.store.holdForRequest(message.id)
        return
      }
      const envelope = messageEnvelope(message, message.attachThread ? this.store.thread(message.threadId) : undefined,
        this.options.taskContext?.(message.taskId))
      // The awaited interrupt can also let a turn end or the driver die, which
      // settles the recipient and requeues this claim. A refused markPushed
      // means exactly that: the row is queued again, so delivering here would
      // duplicate it on the next pass.
      if (!this.store.markPushed(message.id)) return
      this.options.deliver(recipient.sessionId, envelope)
      if (message.taskId) this.options.associateTask?.(recipient.sessionId, message.taskId)
      const pushed = this.store.get(message.id)!
      if (!this.current(recipient.sessionId)?.available) this.store.holdUncertain(message.id, 'recipient-unavailable-after-push')
      this.options.watchReceipt(pushed)
    } catch (error) {
      // A pushed claim must be reconciled from its transcript; it cannot be
      // requeued merely because a display observer or submit call threw.
      const claimed = this.store.get(message.id)
      if (claimed?.state === 'claimed') {
        if (claimed.pushedAt) {
          this.store.holdUncertain(message.id, 'delivery-submit-failed')
          try { this.options.watchReceipt(this.store.get(message.id)!) } catch (receiptError) { this.options.onError?.(receiptError) }
        }
        else this.store.requeue(message.id)
      }
      this.options.onError?.(error)
    }
  }

  private armTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.closed) return
    const due = this.store.nextDueAt()
    if (!due) return
    this.timer = setTimeout(() => this.notify(), Math.min(2147483647, Math.max(0, Date.parse(due) - Date.now())))
    this.timer.unref?.()
  }
}

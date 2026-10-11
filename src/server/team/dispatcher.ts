// Durable mailbox dispatch, serialized across asynchronous agent startup.
// Idleness is checked again inside the atomic claim; SDK queues receive only
// idle turns, except urgent direct mail after an acknowledged interrupt.
import type { ChatPeerMessage } from '../../shared/chat'
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
    onError?: (error: unknown) => void
  }) {}

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
      const urgent = this.store.listForTeam(row.teamId).filter(message =>
        message.state === 'queued' && message.toKind === 'session' && message.toId === row.sessionId &&
        message.priority === 'urgent' && (!message.deliverAt || message.deliverAt <= new Date().toISOString()))
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
      const message = this.store.nextEligible({ teamId: row.teamId, sessionId: row.sessionId, groupId: row.groupId })
      if (message) await this.push(message, row, false)
    }
  }

  private async push(message: TeamMessage, recipient: MailRecipient, interrupt: boolean) {
    try {
      await this.options.prepare(recipient.sessionId)
      if (this.closed) return
      const eligible = () => {
        const current = this.current(recipient.sessionId)
        return !!current?.available && !current.pendingRequest && current.teamId === message.teamId &&
          (interrupt || current.idle) && (message.toKind === 'session' || current.groupId === message.toId)
      }
      if (!this.store.claimWhen(message.id, recipient.sessionId, eligible)) return
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
      const envelope = messageEnvelope(message, message.attachThread ? this.store.thread(message.threadId) : undefined)
      this.store.markPushed(message.id)
      this.options.deliver(recipient.sessionId, envelope)
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

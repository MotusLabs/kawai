// Durable mailbox dispatch, serialized across asynchronous agent startup.
// Idleness is checked again inside the atomic claim; SDK queues receive only
// idle turns, except urgent direct mail after an acknowledged interrupt.
// Order per pass: urgent direct, urgent group, normal direct, normal group.
// Direct mail goes to its recipient; group mail is routed one message at a
// time (profile-routing D5): the router sees the group's eligible members —
// idle, available, request-free, not parked, and in the target worktree of
// the message's task (team-tasks D4) — and answers with a member, a spawned
// member (the reserved message becomes its first turn), a hold, or nothing.
// Groups route concurrently; within a group one decision runs at a time. A
// pick that went stale before the claim is routed again (attempt 1), then by
// the built-in strategy (attempt 2). Without a router the longest-idle
// eligible member takes the message.
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
  /** Holds a parked message: takes no group mail (profile-routing). */
  parked?: boolean
}

/** Mail reserved for a freshly spawned member, to deliver as its first turn. */
export interface SpawnAssignment {
  message: TeamMessage
  sessionId: string
}

/** An eligible member as the router sees it. */
export interface EligibleMember extends MailRecipient {
  idleForMs: number
}

export interface RouteView {
  /** Eligible members of the message's group, longest idle first. */
  eligible: EligibleMember[]
  /** 0 first decision, 1 after a stale pick, 2 built-in only. */
  attempt: number
}

export type RouteResult =
  | { kind: 'member'; sessionId: string }
  | { kind: 'spawned'; assignment: SpawnAssignment }
  /** Leave it queued; `retryAt` (epoch ms) re-arms the timer. */
  | { kind: 'hold'; retryAt: number | null }
  | { kind: 'none' }

export interface GroupRouter {
  route(message: TeamMessage, view: RouteView): Promise<RouteResult>
}

const longestIdle: GroupRouter = {
  route: async (_message, view) => (view.eligible[0] ? { kind: 'member', sessionId: view.eligible[0].sessionId } : { kind: 'none' }),
}

export class MailDispatcher {
  /** Idle order and the time each recipient became idle. */
  private idleSince = new Map<string, { ordinal: number; at: number }>()
  private ordinal = 0
  /** Held group messages and when to route them again. */
  private holds = new Map<string, number | null>()
  /** Recipients whose startup failed this pass: routing skips them. */
  private failedThisPass = new Set<string>()
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
    /** Decides who takes group mail (profile routing); default longest idle. */
    router?: GroupRouter
    /** A claim was won (profile routing records the claim commit). */
    claimed?: (message: TeamMessage, sessionId: string) => void
    /** Mail was pushed as the session's next turn. */
    delivered?: (sessionId: string, message: TeamMessage) => void
    /** Another time the dispatcher must wake (e.g. a recovery note), epoch ms. */
    wakeAt?: () => number | null
    onError?: (error: unknown) => void
    now?: () => number
  }) {}

  private now() { return this.options.now?.() ?? Date.now() }

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
    this.failedThisPass.clear()
    const recipients = this.options.recipients()
    const ids = new Set(recipients.map(row => row.sessionId))
    for (const id of this.idleSince.keys()) if (!ids.has(id)) this.idleSince.delete(id)
    for (const row of recipients) {
      if (row.idle && row.available && !row.pendingRequest) {
        if (!this.idleSince.has(row.sessionId)) this.idleSince.set(row.sessionId, { ordinal: ++this.ordinal, at: this.now() })
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
    const groupMail = this.store.dueGroupMail()
    const live = new Set(groupMail.map(message => message.id))
    for (const id of this.holds.keys()) if (!live.has(id)) this.holds.delete(id)
    for (const priority of ['urgent', 'normal'] as const) {
      if (this.closed) return
      await this.directPass(priority)
      await this.groupPass(groupMail.filter(message => message.priority === priority))
    }
  }

  /** Idle recipients in idle order (longest idle first). */
  private idleRecipients(): MailRecipient[] {
    return [...this.idleSince.entries()].sort(([, a], [, b]) => a.ordinal - b.ordinal)
      .flatMap(([id]) => { const row = this.current(id); return row ? [row] : [] })
  }

  private async directPass(priority: 'urgent' | 'normal') {
    for (const row of this.idleRecipients()) {
      const message = this.store.nextEligible({ teamId: row.teamId, sessionId: row.sessionId, groupId: null },
        undefined, candidate => candidate.toKind === 'session' && candidate.priority === priority)
      if (message) await this.push(message, row, false)
    }
  }

  /** Groups route concurrently; one decision at a time within a group. */
  private async groupPass(messages: TeamMessage[]) {
    const buckets = new Map<string, TeamMessage[]>()
    for (const message of messages) {
      const key = `${message.teamId}\0${message.toId}`
      buckets.set(key, [...(buckets.get(key) ?? []), message])
    }
    await Promise.all([...buckets.values()].map(async bucket => {
      for (const message of bucket) {
        if (this.closed) return
        try {
          await this.routeOne(message)
        } catch (error) {
          this.options.onError?.(error)
        }
      }
    }))
  }

  private eligibleFor(message: TeamMessage): EligibleMember[] {
    const now = this.now()
    return this.idleRecipients().flatMap(row => {
      const idle = this.idleSince.get(row.sessionId)
      if (!idle || !row.available || row.pendingRequest || !row.idle || row.parked) return []
      if (this.failedThisPass.has(row.sessionId)) return []
      if (row.teamId !== message.teamId || row.groupId !== message.toId || !this.inWorktree(row, message)) return []
      return [{ ...row, idleForMs: now - idle.at }]
    })
  }

  private async routeOne(message: TeamMessage) {
    const router = this.options.router ?? longestIdle
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (this.store.get(message.id)?.state !== 'queued') return
      const result = await router.route(message, { eligible: this.eligibleFor(message), attempt })
      if (result.kind === 'hold') {
        this.holds.set(message.id, result.retryAt)
        return
      }
      this.holds.delete(message.id)
      if (result.kind === 'none') return
      if (result.kind === 'spawned') {
        const { assignment } = result
        const recipient = this.current(assignment.sessionId)
        if (recipient) await this.push(assignment.message, recipient, false, true)
        // Not delivered as the first turn (the member was not ready or went
        // away): back to the queue, where the member can still pick it up.
        if (this.store.get(assignment.message.id)?.state === 'spawning') this.store.requeue(assignment.message.id)
        return
      }
      const recipient = this.current(result.sessionId)
      // A stale pick (busy, gone, parked, moved) is routed again.
      if (recipient && await this.push(message, recipient, false)) return
    }
  }

  /** Claim and deliver; false when the claim was refused (the pick went stale). */
  private async push(message: TeamMessage, recipient: MailRecipient, interrupt: boolean, reserved = false): Promise<boolean> {
    try {
      await this.options.prepare(recipient.sessionId)
      if (this.closed) return true
      const eligible = () => {
        const current = this.current(recipient.sessionId)
        return !!current?.available && !current.pendingRequest && current.teamId === message.teamId &&
          (interrupt || current.idle) &&
          (message.toKind === 'session' || (current.groupId === message.toId && (reserved || !current.parked))) &&
          this.inWorktree(current, message)
      }
      if (!this.store.claimWhen(message.id, recipient.sessionId, eligible, reserved)) return false
      this.idleSince.delete(recipient.sessionId)
      this.options.claimed?.(message, recipient.sessionId)
      if (interrupt) await this.options.interrupt(recipient.sessionId)
      const current = this.current(recipient.sessionId)
      // The awaited interrupt allows a human turn/card to arrive. Re-check
      // before recording a push so a refused submission cannot strand mail.
      if (this.closed || !current?.available || !current.idle || current.pendingRequest) {
        this.store.requeue(message.id)
        if (current?.pendingRequest) this.store.holdForRequest(message.id)
        return true
      }
      const envelope = messageEnvelope(message, message.attachThread ? this.store.thread(message.threadId) : undefined,
        this.options.taskContext?.(message.taskId))
      // The awaited interrupt can also let a turn end or the driver die, which
      // settles the recipient and requeues this claim. A refused markPushed
      // means exactly that: the row is queued again, so delivering here would
      // duplicate it on the next pass.
      if (!this.store.markPushed(message.id)) return true
      this.options.deliver(recipient.sessionId, envelope)
      this.options.delivered?.(recipient.sessionId, message)
      if (message.taskId) this.options.associateTask?.(recipient.sessionId, message.taskId)
      const pushed = this.store.get(message.id)!
      if (!this.current(recipient.sessionId)?.available) this.store.holdUncertain(message.id, 'recipient-unavailable-after-push')
      this.options.watchReceipt(pushed)
      return true
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
      // Failed before claiming (e.g. the agent would not start): let routing
      // try someone else this pass.
      if (this.store.get(message.id)?.state === 'queued') {
        this.failedThisPass.add(recipient.sessionId)
        return false
      }
      return true
    }
  }

  private armTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.closed) return
    const due = this.store.nextDueAt()
    const times = [due ? Date.parse(due) : null, ...this.holds.values(), this.options.wakeAt?.() ?? null]
      .filter((at): at is number => at !== null)
    if (times.length === 0) return
    this.timer = setTimeout(() => this.notify(), Math.min(2147483647, Math.max(0, Math.min(...times) - Date.now())))
    this.timer.unref?.()
  }
}

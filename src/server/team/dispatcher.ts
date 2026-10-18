// Durable mailbox dispatch, serialized across asynchronous agent startup.
// A dispatcher may start held, recording requests without dispatching until
// its owner's startup recovery has run.
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
// Waiting reasons (team-waiting-reasons D2): a cause reporter over the
// shared recipient fields sits beneath the eligibility and claim predicates,
// which keep their exact boolean shapes by rejecting different subsets of
// its causes; every pass ends in an `afterPass` outcome carrying fresh
// constraints per still-waiting message plus the waiting surface itself.
import type { ChatPeerMessage } from '../../shared/chat'
import type { ChatPeerTaskContext } from '../../shared/teamTasks'
import type { WaitingConstraint } from '../../shared/team'
import type { TeamMessage } from './mailboxStore'
import { MailboxStore } from './mailboxStore'
import { messageEnvelope } from './envelope'
import { memberExclusions, messageExclusions, type MemberExclusion, type MemberExclusionKind } from './memberCauses'

export interface MailRecipient {
  sessionId: string
  teamId: string
  groupId: string | null
  idle: boolean
  pendingRequest: boolean
  available: boolean
  /** The manager's start refusal text when `available` is false (D2: unavailable reason). */
  blockedBy?: string | null
  /** The worktree root containing the member's current project path. */
  worktree?: string
  /** Holds a parked message: takes no group mail (profile-routing). */
  parked?: boolean
  /** Flagged context-exhausted (chat-context-exhaustion D7): takes no mail, still counts toward caps. */
  contextExhausted?: boolean
  profileId?: string
  /** Direct mail waits for provider recovery; custom group rules may override cooling. */
  cooldownUntil?: string | null
}

// The member-state cause reporter lives beside the predicates it sits beneath.
export { memberExclusions }
export type { MemberExclusion, MemberExclusionKind }

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
  /** Why each live member of the group cannot take the message (D2). */
  exclusions?: MemberExclusion[]
}

export type RouteResult =
  | { kind: 'member'; sessionId: string }
  | { kind: 'spawned'; assignment: SpawnAssignment }
  /** Leave it queued; `retryAt` (epoch ms) re-arms the timer. */
  | { kind: 'hold'; retryAt: number | null; diagnosis?: WaitingConstraint[] }
  | { kind: 'none'; diagnosis?: WaitingConstraint[] }

/** What one dispatch pass learned about waiting mail (team-waiting-reasons D3). */
export interface PassOutcome {
  /** Fresh constraints per still-waiting message the pass diagnosed. */
  reasons: Map<string, WaitingConstraint[]>
  /** Every message still on the waiting surface (queued due, awaiting-request, spawning). */
  waiting: Set<string>
}

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
  /** Router diagnoses collected this pass, per message (D2/D3). */
  private passDiagnoses = new Map<string, WaitingConstraint[]>()
  /** Agent-start failures with their error text, until the message leaves the queued surface (D2). */
  private readonly startFailures = new Map<string, { sessionId: string; error: string }>()
  private requested = false
  private running: Promise<void> | null = null
  private closed = false
  /** Held: requests are recorded but nothing dispatches until release(). */
  private held: boolean
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly store: MailboxStore, private readonly options: {
    recipients: () => MailRecipient[]
    recipient?: (id: string) => MailRecipient | undefined
    /** Cycle start (member-release D5): awaited before this pass's diagnoses clear and routing begins. */
    beginCycle?: () => void | Promise<void>
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
    /** Pass end: fresh waiting constraints and the waiting surface (D3). */
    afterPass?: (outcome: PassOutcome) => void
    onError?: (error: unknown) => void
    /** Start held (see release): the owner still has recovery to run first. */
    held?: boolean
    now?: () => number
  }) {
    this.held = options.held ?? false
  }

  private now() { return this.options.now?.() ?? Date.now() }

  /** The message's target worktree root, or null when any member may take it. */
  private targetOf(message: TeamMessage): string | null {
    if (message.toKind !== 'group' || !this.options.targetWorktree) return null
    return this.options.targetWorktree(message)
  }

  /** Whether a member may take a message given its task's target worktree. */
  private inWorktree(recipient: MailRecipient | undefined, message: TeamMessage): boolean {
    const target = this.targetOf(message)
    return target === null || recipient?.worktree === target
  }

  notify(): void {
    if (this.closed) return
    this.requested = true
    if (this.held || this.running) return
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

  /** Lift the hold; requests recorded while held dispatch now. */
  release(): void {
    if (!this.held) return
    this.held = false
    if (this.requested) this.notify()
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
    // Awaited (member-release D5): release evaluation and closed-task
    // dead-lettering finish before this pass's diagnoses are cleared and
    // collected, so `afterPass` never reports a dead-lettered row as waiting.
    await this.options.beginCycle?.()
    this.failedThisPass.clear()
    this.passDiagnoses.clear()
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
      if (this.cooling(this.current(row.sessionId))) continue
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
    this.finishPass()
  }

  /**
   * Pass end (team-waiting-reasons D3): merge the router diagnoses and the
   * direct-mail reasons into one outcome, plus the waiting surface so the
   * owner can clear ledger entries and start-failure backoffs for messages
   * that left it (delivered, cancelled, dead-lettered, discarded).
   */
  private finishPass() {
    if (!this.options.afterPass) return
    const reasons = this.directWaiting(this.now())
    for (const [id, constraints] of this.passDiagnoses) {
      if (reasons.has(id)) continue
      if (this.store.get(id)?.state === 'queued') reasons.set(id, constraints)
    }
    const waiting = new Set<string>(reasons.keys())
    for (const message of this.store.waitingRows()) waiting.add(message.id)
    for (const id of this.startFailures.keys()) if (!waiting.has(id)) this.startFailures.delete(id)
    this.options.afterPass({ reasons, waiting })
  }

  /** Direct-mail waiting constraints from the recipient view (D2). */
  private directWaiting(now: number): Map<string, WaitingConstraint[]> {
    const out = new Map<string, WaitingConstraint[]>()
    for (const message of this.store.waitingDirectMail()) {
      const constraints: WaitingConstraint[] = []
      const row = message.toId !== null ? this.current(message.toId) : undefined
      const failure = this.startFailures.get(message.id)
      if (failure && (!row || failure.sessionId === row.sessionId)) {
        constraints.push({ kind: 'startup-failed', ...(failure.error ? { detail: failure.error } : {}) })
      }
      if (message.state === 'awaiting-request') constraints.push({ kind: 'recipient-pending-request' })
      else if (!row || row.teamId !== message.teamId) {
        constraints.push({ kind: 'recipient-unavailable', detail: 'the recipient is not a live member of this team' })
      } else {
        // Parked recipients still take direct mail; every other cause is a reason.
        for (const cause of memberExclusions(row, message, { targetWorktree: null, now, startupFailed: false })) {
          if (cause.kind === 'unavailable') {
            constraints.push({ kind: 'recipient-unavailable', ...(row.blockedBy ? { detail: row.blockedBy } : {}) })
          } else if (cause.kind === 'pending-card') constraints.push({ kind: 'recipient-pending-request' })
          else if (cause.kind === 'busy') constraints.push({ kind: 'recipient-busy' })
          else if (cause.kind === 'context-exhausted') {
            constraints.push({ kind: 'recipient-unavailable', sessionIds: [row.sessionId], detail: 'the recipient\'s context is exhausted' })
          }
          else if (cause.kind === 'excluded-profile') {
            constraints.push({ kind: 'recipient-unavailable', detail: `the recipient is on the excluded profile ${message.excludedProfile}` })
          } else if (cause.kind === 'outside-role') {
            constraints.push({ kind: 'outside-role', ...(cause.detail ? { detail: cause.detail } : {}) })
          } else if (cause.kind === 'profile-cooling') {
            constraints.push({ kind: 'profile-cooling', ...(row.cooldownUntil ? { retryAt: row.cooldownUntil } : {}) })
          }
        }
      }
      if (constraints.length > 0) out.set(message.id, constraints)
    }
    return out
  }

  /** Idle recipients in idle order (longest idle first). */
  private idleRecipients(): MailRecipient[] {
    return [...this.idleSince.entries()].sort(([, a], [, b]) => a.ordinal - b.ordinal)
      .flatMap(([id]) => { const row = this.current(id); return row ? [row] : [] })
  }

  private cooling(recipient: MailRecipient | undefined): boolean {
    return Date.parse(recipient?.cooldownUntil ?? '') > this.now()
  }

  private async directPass(priority: 'urgent' | 'normal') {
    for (const row of this.idleRecipients()) {
      if (this.cooling(row)) continue
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

  /**
   * Eligible members, rebuilt unchanged on the cause reporter: the group
   * path rejects every cause except the direct-only ones (`excluded-profile`
   * is the candidate builder's filter; cooling members stay candidates).
   */
  private eligibleFor(message: TeamMessage): EligibleMember[] {
    const now = this.now()
    const target = this.targetOf(message)
    return this.idleRecipients().flatMap(row => {
      const idle = this.idleSince.get(row.sessionId)
      if (!idle) return []
      if (row.teamId !== message.teamId || row.groupId !== message.toId) return []
      const groupPath = memberExclusions(row, message, { targetWorktree: target, now, startupFailed: this.failedThisPass.has(row.sessionId) })
        .some(cause => cause.kind !== 'excluded-profile' && cause.kind !== 'profile-cooling')
      return groupPath ? [] : [{ ...row, idleForMs: now - idle.at }]
    })
  }

  /**
   * Why each live member of the message's group cannot take it (D2): the
   * router's `none`/`hold` diagnosis is built from this breakdown. A member
   * that missed this pass's idle order reports busy — it was working when
   * the pass began.
   */
  private exclusionsFor(message: TeamMessage): MemberExclusion[] {
    const failure = this.startFailures.get(message.id)
    return messageExclusions({
      message,
      recipients: this.options.recipients(),
      eligibleIds: new Set(this.eligibleFor(message).map(row => row.sessionId)),
      targetWorktree: this.targetOf(message),
      startFailure: failure ?? null,
      now: this.now(),
      startupFailed: sessionId => this.failedThisPass.has(sessionId),
    })
  }

  private async routeOne(message: TeamMessage) {
    const router = this.options.router ?? longestIdle
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (this.store.get(message.id)?.state !== 'queued') return
      const result = await router.route(message, { eligible: this.eligibleFor(message), attempt, exclusions: this.exclusionsFor(message) })
      if (result.kind === 'hold') {
        this.holds.set(message.id, result.retryAt)
        this.passDiagnoses.set(message.id, result.diagnosis ?? [])
        return
      }
      this.holds.delete(message.id)
      if (result.kind === 'none') {
        this.passDiagnoses.set(message.id, result.diagnosis ?? [])
        return
      }
      this.passDiagnoses.delete(message.id)
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
        // Rebuilt unchanged on the cause reporter (D2): this predicate rejects
        // its own subset — busy unless interrupting, cooling only for direct
        // mail, parked only for unreserved group mail — never startup failures
        // or idle order, which belong to `eligibleFor`.
        const current = this.current(recipient.sessionId)
        if (!current || current.teamId !== message.teamId) return false
        const causes = memberExclusions(current, message, { targetWorktree: this.targetOf(message), now: this.now(), startupFailed: false })
        const has = (kind: MemberExclusionKind) => causes.some(cause => cause.kind === kind)
        if (has('unavailable') || has('pending-card') || has('other-worktree') || has('context-exhausted')) return false
        if (!interrupt && has('busy')) return false
        if (message.excludedProfile && has('excluded-profile')) return false
        if (message.toKind === 'session' && has('profile-cooling')) return false
        if (message.toKind === 'group' && (current.groupId !== message.toId || (!reserved && has('parked')))) return false
        return true
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
      const task = this.options.taskContext?.(message.taskId)
      const envelope = messageEnvelope(message, message.attachThread ? this.store.thread(message.threadId) : undefined, task)
      // The awaited interrupt can also let a turn end or the driver die, which
      // settles the recipient and requeues this claim. A refused markPushed
      // means exactly that: the row is queued again, so delivering here would
      // duplicate it on the next pass.
      if (!this.store.markPushed(message.id, undefined, task?.revision ?? null)) return true
      this.startFailures.delete(message.id)
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
      // try someone else this pass, and keep the error with the message until
      // it leaves the queued surface (D2).
      if (this.store.get(message.id)?.state === 'queued') {
        this.failedThisPass.add(recipient.sessionId)
        this.startFailures.set(message.id, { sessionId: recipient.sessionId, error: error instanceof Error ? error.message : String(error) })
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
    const cooldowns = this.options.recipients().map(row => Date.parse(row.cooldownUntil ?? ''))
      .filter(at => Number.isFinite(at) && at > this.now())
    const times = [due ? Date.parse(due) : null, ...cooldowns, ...this.holds.values(), this.options.wakeAt?.() ?? null]
      .filter((at): at is number => at !== null)
    if (times.length === 0) return
    this.timer = setTimeout(() => this.notify(), Math.min(2147483647, Math.max(0, Math.min(...times) - Date.now())))
    this.timer.unref?.()
  }
}

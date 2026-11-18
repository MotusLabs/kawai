// Codex capacity recovery effects for one session (codex-capacity-retry D2,
// D4, D5; tasks 2.1-2.2), over the pure policy in capacityRetry.ts. Only with
// the session option `capacityRecovery: 'bounded'`; otherwise nothing here
// acts and a failed turn settles exactly as before.
// - Logical turn versus attempt. The session's CodexTurnState is the logical
//   turn: its turn id, opening message, result, usage, tool counts and the
//   lifecycle's active turn stay across attempts. An attempt is one native
//   Codex turn id. A matching terminal `serverOverloaded` completion of the
//   open turn is handed here before the turn is decided: the attempt's native
//   id is retired (the session maps it to a settled sentinel, so a late
//   turn/started, item, request or duplicate completion naming it reaches
//   nothing) and the turn is rearmed for its next native id, while no
//   turn_completed, error, limit event or idle transition is published.
// - One pending effect. At most one backoff timer or one active attempt
//   exists. Each armed timer carries a token; arming, cancelling and
//   dispatching bump it, so a duplicate, early or stale wakeup is inert (L1).
//   Codex's own `willRetry` notifications never reach this module (L7).
// - Continuation. A due wakeup inside the deadline sends one turn/start on
//   the same thread with the original turn's own turn/start parameters
//   (policy, effort), replacing only the input — the exported
//   CODEX_CAPACITY_CONTINUATION text — and a fresh clientUserMessageId: the
//   original prompt, peer envelope and tool output are never resent. It
//   publishes a `capacity_recovery` notice, not a user_message.
// - Cancellation. Every settlement of the logical turn goes through the
//   session's decide(), which calls settled() here: Stop, interrupt (urgent
//   delivery included), kill, shutdown, process exit, a refused start, a
//   success and expiry all invalidate the token and clear the timer before
//   anything is published. A steer during backoff supersedes the turn: it is
//   settled interrupted and the steer refused as `turn-ended`, so the caller
//   sends the input as a new turn (L13). A start reply arriving after a Stop
//   binds the cancelled attempt only, through the session's interruptOwed
//   handshake: the single cleanup turn/interrupt for that attempt's id.
// - Start ownership. turn/started names no request, so the session binds it
//   to the oldest unbound turn. While a dispatched continuation's start reply
//   is outstanding, a new turn's turn/start waits for that reply (or its
//   rejection, bounded by the request deadline): a cancelled attempt's
//   cleanup identity never competes with a successor's native id. A turn
//   ended while it waited sends nothing; a refused continuation leaves the
//   unbound queue.
// - Ephemeral. Nothing is persisted; a new session (backend restart) has no
//   recovery and schedules nothing (L16).
import type { TurnOutcome } from '../contract.js'
import type { AgentErrorInfo } from '../errors.js'
import type { EventBody } from '../eventStream.js'
import type { JsonObject } from '../json.js'
import type { ChatActivityInput } from '../common/activity.js'
import { AgentRuntimeError } from '../errors.js'
import { capacityDeadline, capacitySchedule, capacityWake, CAPACITY_WINDOW_MS, isCodexCapacityError, systemCapacityClock, type CapacityClock } from './capacityRetry.js'
import { CODEX_CAPACITY_CONTINUATION } from './continuation.js'
import { rpcError, type CodexGeneration } from './generation.js'
import { rearmAttempt, retiredAttempt, type CodexTurnState } from './turns.js'

export interface RecoveryHost {
  readonly bounded: boolean
  /** Default systemCapacityClock. */
  readonly clock?: CapacityClock | undefined
  /** The session's bound native ids (a retired attempt maps to a settled sentinel). */
  readonly native: Map<string, CodexTurnState>
  open(): CodexTurnState | null
  stopBegun(): boolean
  current(): CodexGeneration | null
  /** The fallback turn/start parameters of a turn the runtime did not start (an agent-started turn). */
  turnParams(threadId: string | null): Record<string, unknown>
  /** The turn awaits its next native id (turn/started binds the oldest unbound turn), or with `waiting` false leaves that queue. */
  unbound(turn: CodexTurnState, waiting?: boolean): void
  bindNative(turn: CodexTurnState, id: string): void
  settle(turn: CodexTurnState, outcome: TurnOutcome, error: AgentErrorInfo, subtype: string, terminalReason?: string | null): void
  runOwned<T>(label: string, body: () => Promise<T>): Promise<T> | null
  emit(body: EventBody): void
  activity(input: ChatActivityInput): void
  /** The retired attempt's outstanding approvals and questions are cancelled with it. */
  cancelRequests(): void
}

interface Recovering {
  turn: CodexTurnState
  /** Monotonic deadline, fixed by the first terminal capacity failure. */
  deadline: number
  /** The same deadline in epoch milliseconds, for display. */
  deadlineAt: number
  /** Retries dispatched or scheduled so far. */
  ordinal: number
  /** The latest capacity error: the turn's error if recovery ends. */
  error: AgentErrorInfo
  /** Monotonic due time of the armed wakeup (the deadline when expiring), or null while an attempt runs. */
  due: number | null
}

const EXHAUSTED = 'Model capacity did not recover within the retry window; the turn ends with the capacity error.'

export class CapacityRecovery {
  private recovering: Recovering | null = null
  private timer: unknown = null
  /** Bumped by every arm, dispatch and cancel: only the newest timer's callback may act. */
  private token = 0

  /** The dispatched continuation's start reply, until it resolves or rejects. */
  private starting: Promise<void> | null = null

  private readonly clock: CapacityClock

  constructor(private readonly host: RecoveryHost) {
    this.clock = host.clock ?? systemCapacityClock
  }

  /**
   * Run a new turn's turn/start `send` now, or once no continuation start reply is outstanding. A turn
   * settled, superseded or orphaned by its generation meanwhile leaves the unbound queue and `skip`s.
   */
  afterStarts(turn: CodexTurnState, generation: CodexGeneration, send: () => void, skip: () => void): void {
    const starting = this.starting
    if (!starting) return send()
    void starting.then(() => {
      if (!turn.settled && turn === this.host.open() && generation === this.host.current() && !generation.retired && !this.host.stopBegun()) return this.afterStarts(turn, generation, send, skip)
      this.host.unbound(turn, false)
      skip()
    })
  }

  /** Whether a backoff timer (not an attempt) is pending. */
  get waiting(): boolean {
    return this.recovering !== null && this.recovering.due !== null
  }

  /**
   * A matching failed completion of the open turn, before it is decided:
   * true when recovery took it (the turn stays open), false to settle it as
   * before (not eligible, or the deadline has passed: L4).
   */
  failed(turn: CodexTurnState, raw: unknown, error: AgentErrorInfo): boolean {
    if (!this.host.bounded || !isCodexCapacityError(raw) || turn.settled || turn !== this.host.open() || this.host.stopBegun()) return false
    const { clock } = this
    const now = clock.monotonic()
    if (this.recovering && this.recovering.turn !== turn) this.cancel()
    const recovering = (this.recovering ??= { turn, deadline: capacityDeadline(now), deadlineAt: clock.epoch() + CAPACITY_WINDOW_MS, ordinal: 0, error, due: null })
    recovering.error = error
    if (now >= recovering.deadline) {
      this.cancel()
      this.host.emit({ type: 'notice', kind: 'capacity_recovery', text: EXHAUSTED })
      return false
    }
    retiredAttempt(turn, this.host.native)
    rearmAttempt(turn)
    this.host.cancelRequests()
    const plan = capacitySchedule(now, recovering.deadline, recovering.ordinal + 1, clock.random())
    if (plan.kind === 'retry') recovering.ordinal += 1
    this.arm(recovering, plan.due)
    const nextRetryAt = plan.kind === 'retry' ? clock.epoch() + plan.delayMs : null
    const expiring = plan.kind === 'expiring'
    this.host.emit({ type: 'capacity_retry', turnId: turn.turnId, ordinal: recovering.ordinal, nextRetryAt: nextRetryAt === null ? null : new Date(nextRetryAt).toISOString(), deadline: new Date(recovering.deadlineAt).toISOString(), expiring })
    if (this.recovering === recovering && !turn.settled) {
      this.host.activity({ type: 'capacity_retry', ordinal: recovering.ordinal, deadline: recovering.deadlineAt, ...(nextRetryAt === null ? {} : { nextRetryAt }) })
    }
    return true
  }

  /** The session decided `turn` (any outcome, any path): recovery of it ends now, before anything is published. */
  settled(turn: CodexTurnState): void {
    if (this.recovering?.turn === turn) this.cancel()
  }

  /** L13: a steer prepared for `turn` while it waits for a retry supersedes it; true when the turn was settled interrupted. */
  supersede(turn: CodexTurnState, interrupted: AgentErrorInfo): boolean {
    if (this.recovering?.turn !== turn || this.recovering.due === null) return false
    this.host.settle(turn, 'interrupted', interrupted, 'interrupted')
    return turn.settled
  }

  private cancel(): void {
    this.token += 1
    if (this.timer !== null) this.clock.clearTimer(this.timer)
    this.timer = null
    this.recovering = null
  }

  private arm(recovering: Recovering, due: number): void {
    const { clock } = this
    if (this.timer !== null) clock.clearTimer(this.timer)
    const token = ++this.token
    recovering.due = due
    this.timer = clock.setTimer(Math.max(0, due - clock.monotonic()), () => this.wake(token))
  }

  private wake(token: number): void {
    const recovering = this.recovering
    if (token !== this.token || recovering === null || recovering.due === null) return
    this.timer = null
    const { turn } = recovering
    if (turn.settled || turn !== this.host.open() || this.host.stopBegun()) return this.cancel()
    const decision = capacityWake(this.clock.monotonic(), recovering.due, recovering.deadline)
    if (decision === 'wait') return this.arm(recovering, recovering.due)
    if (decision === 'expire') {
      const error = recovering.error
      this.cancel()
      this.host.emit({ type: 'notice', kind: 'capacity_recovery', text: EXHAUSTED })
      return this.host.settle(turn, 'failed', error, 'error_during_execution', 'serverOverloaded')
    }
    this.token += 1
    recovering.due = null
    this.dispatch(recovering)
  }

  /** L9: one continuation request on the current generation's thread. */
  private dispatch(recovering: Recovering): void {
    const { turn, ordinal } = recovering
    const generation = this.host.current()
    // A retired generation's exit settles the turn itself (L12); if it has not, the turn ends rather than hang.
    if (!generation || generation.retired) return this.host.settle(turn, 'failed', recovering.error, 'error_during_execution', 'serverOverloaded')
    const params = { ...(turn.startParams ?? this.host.turnParams(generation.threadId)), threadId: generation.threadId, input: [{ type: 'text', text: CODEX_CAPACITY_CONTINUATION, text_elements: [] }], clientUserMessageId: crypto.randomUUID() }
    this.host.unbound(turn)
    const token = this.token
    let write!: (reply: Promise<unknown>) => void
    const written = new Promise<Promise<unknown>>((resolve) => (write = resolve))
    const job = this.host.runOwned(`capacity:${turn.turnId}:${ordinal}`, async () => {
      try {
        const id = ((await (await written)) as { turn?: { id?: unknown } } | null)?.turn?.id
        // A reply after a Stop binds the cancelled attempt only: its owed cleanup interrupt (L1).
        if (typeof id === 'string') this.host.bindNative(turn, id)
      } catch (error) {
        // A refused start never binds: it must not take a later turn's turn/started id.
        this.host.unbound(turn, false)
        if (this.host.stopBegun() && error instanceof AgentRuntimeError && error.category === 'stopped') return
        if (token === this.token) this.host.settle(turn, 'failed', rpcError(error, 'Codex refused the capacity retry'), 'error_during_execution')
      }
    })
    if (!job) return
    const starting: Promise<void> = job.then(() => {}, () => {}).then(() => void (this.starting === starting && (this.starting = null)))
    this.starting = starting
    try {
      write(generation.transport.request('turn/start', params as JsonObject))
    } catch (error) {
      write(Promise.reject(error))
    }
    if (turn.settled || this.recovering !== recovering) return
    this.host.emit({ type: 'notice', kind: 'capacity_recovery', text: `Retrying after temporary model capacity pressure (retry ${ordinal})` })
    if (!turn.settled) this.host.activity({ type: 'turn_started' })
  }
}

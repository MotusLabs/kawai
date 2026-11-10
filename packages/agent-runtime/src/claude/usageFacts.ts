// The Claude session's usage, context, quota and limit facts (design §6,
// tasks 5.2/5.3; the mapping of Kawai's committed ChatSessionDriver over the
// pure ./usage parsers).
// - Per turn: tool-call and compaction ids (counted once each), the summed
//   provider cost of the turn's stream events, subagents' included, and the
//   tokens of the result bound to it; until then (and when the result carries
//   none) the observed tokens of its own bound main-thread requests, each
//   request once by message id, recorded before any observer runs. Nothing
//   is carried from another turn or a subagent.
// - Sources (review F3/F5, creator notes 229f71ee and 582ce1ec): every main
//   message_start or assistant frame naming a request (message.id, an
//   assistant frame's uuid as fallback) admits that native id once, whether
//   or not it carries counters, to the turn bound then, or to no turn. Every
//   later frame of the id (a replay, a snapshot, a message_delta through the
//   cursor) belongs to that first owner only; counters, when present, merge
//   per field on a live owner. A settled owner's ids retire as soon as it is
//   marked settled (the id stays, the Turn reference goes). The sources live
//   as long as this object: across respawn and resume of the conversation,
//   and a conversation reset clears only the context cursor.
// - Context: the latest main-thread request's usage (assistant frames and
//   stream events, merged per message id), a compaction's post size, the
//   largest model window a result names, the CLI's context report and the
//   launch's CLAUDE_CODE_AUTO_COMPACT_WINDOW. A conversation reset publishes
//   null. Context frames count whatever the turn state.
// - Quota: every rate_limit_event (`push`) and assistant usage_report
//   (`report`), the session's own login; the host-login pull is the session's
//   (quotaSource), not decided here.
// - Limits and waits: an api_retry limit is a non-final failure that starts
//   the turn's wait; a failed assistant message is final. The reset and
//   window come from the latest rejected rate_limit_event still ahead. The
//   wait ends resumed only on a novel phase of a request the bound turn owns
//   (its first message_start or snapshot, or a snapshot with new content;
//   never a duplicate, another turn's or an unowned request, a delta or a
//   failed message) or on its successful result. Otherwise the cause is
//   decided when the turn is marked settled: cancelled, or process-ended for
//   an unexpected exit; it is published after the turn's result.
// Each frame is decided whole (admission, tokens, context, wait) before any
// of its quota, context or limit publications run; limit and wait events go
// out in order through one queue (usage/waits.ts). Every callback runs
// through the session's guarded notify.
import type { AgentCallbacks } from '../options.js'
import { ContextTracker, EMPTY_REQUEST_USAGE, mergeRequestUsage, parsePositiveTokens, sumRequestUsage, type ContextReportSlice, type ContextStep, type RequestUsage } from '../usage/context.js'
import { messageDeltaCost } from '../usage/cost.js'
import { assistantLimitFailure, rejectedResetsAt, rejectedWindow, retryLimitFailure } from '../usage/limits.js'
import { parseRateLimitEvent, parseUsageReport } from '../usage/quota.js'
import { addTokenUsage, mergeClaudeRequestUsage } from '../usage/tokens.js'
import type { LimitEvent, LimitWaitEnd, QuotaReport, TokenUsage } from '../usage/types.js'
import { LimitWaits, OrderedEvents } from '../usage/waits.js'
import type { Turn } from './turns.js'

export interface UsageFactsHost {
  callbacks: AgentCallbacks
  notify(name: string, callback: () => void): void
}

type Frame = Record<string, unknown>

const isObject = (value: unknown): value is Frame => typeof value === 'object' && value !== null && !Array.isArray(value)
const subagent = (frame: Frame) => frame.parent_tool_use_id != null
/** An assistant frame's content identity: each block's type with its tool id or text (a tool input is never serialized). */
const contentSignature = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map((block) => (isObject(block) ? `${String(block.type)}:${typeof block.id === 'string' ? block.id : ''}:${typeof block.text === 'string' ? block.text : ''}` : '?')).join('\u0000')

/** A request first seen with no turn bound: it never has an owner. */
const UNKNOWN = Symbol('unknown')
/** A settled turn's request: the id stays, the turn is gone. */
const RETIRED = Symbol('retired')
interface Source {
  owner: Turn | typeof UNKNOWN | typeof RETIRED
  /** Content signatures of its assistant frames (a repeated one is no new phase). */
  readonly contents: Set<string>
}

export class ClaudeUsageFacts {
  private readonly context = new ContextTracker()
  private readonly waits = new LimitWaits()
  /** The latest main-thread request: the context cursor (a later message_delta continues it). */
  private cursor: { messageId: string | null; usage: RequestUsage } = { messageId: null, usage: EMPTY_REQUEST_USAGE }
  /** Every main-thread request id admitted, to its source. */
  private readonly sources = new Map<string, Source>()
  /** The ids each live turn owns (retired together when it settles). */
  private readonly owned = new Map<Turn, Set<string>>()
  /** Wait ends decided when their turn was marked settled, published after its result. */
  private readonly decided = new Map<string, LimitWaitEnd>()
  /** The publications of the frame being decided; null outside one. */
  private pending: Array<() => void> | null = null
  private limitResetsAt: string | null = null
  private limitWindow: string | null = null
  /** Compaction boundaries already reported (a repeated boundary id is reported once). */
  private readonly boundaries = new Set<string>()
  private lastModel: string | null = null
  private readonly limitEvents = new OrderedEvents<LimitEvent>((event) => {
    const onLimitEvent = this.host.callbacks.onLimitEvent
    if (onLimitEvent) this.host.notify('onLimitEvent', () => onLimitEvent(event))
  })

  constructor(private readonly host: UsageFactsHost) {}

  /** The launch's profile window, read at each spawn from the explicit child environment. */
  spawned(childEnv: Readonly<Record<string, string>>): void {
    this.step(this.context.setProfileWindow(parsePositiveTokens(childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW)))
  }

  /** A session-level frame (rate_limit_event, conversation_reset); true when it was one. */
  sessionFrame(frame: Frame): boolean {
    if (frame.type === 'rate_limit_event') this.decide(() => this.rateLimitEvent(frame))
    else if (frame.type === 'conversation_reset') this.decide(() => this.conversationReset())
    else return false
    return true
  }

  private rateLimitEvent(frame: Frame): void {
    const info = frame.rate_limit_info
    if (rejectedResetsAt(info) !== null) {
      this.limitResetsAt = rejectedResetsAt(info)
      this.limitWindow = rejectedWindow(info)
    }
    this.quotaReport(parseRateLimitEvent(info))
  }

  /** An assistant frame; `turn` is the turn its content belongs to, or null. */
  assistant(frame: Frame, turn: Turn | null): void {
    this.decide(() => {
      const report = parseUsageReport(frame.usage_report)
      if (report) this.quotaReport(report)
      if (subagent(frame)) return
      const message = isObject(frame.message) ? frame.message : {}
      const messageId = String(message.id ?? frame.uuid ?? '')
      let novel = false
      if (messageId) {
        const { source, first } = this.admit(messageId, turn)
        const signature = contentSignature(message.content)
        novel = first || !source.contents.has(signature)
        source.contents.add(signature)
        this.sighting(messageId, source, message.usage)
        novel &&= this.live(source) === turn
      }
      if (!turn) return
      if (frame.error) {
        const content = Array.isArray(message.content) ? message.content : []
        const text = content.map((block) => (isObject(block) && block.type === 'text' ? String(block.text ?? '') : '')).join('\n')
        const { resetsAt, window } = this.currentLimit()
        this.publish(assistantLimitFailure(frame.error, text, resetsAt, window))
      } else if (novel) this.progressed(turn)
    })
  }

  /** A stream event; `turn` is the active turn whatever the frame binding (cost counts every call of it). */
  partial(frame: Frame, turn: Turn | null, bound: Turn | null): void {
    this.decide(() => {
      const event = isObject(frame.event) ? frame.event : {}
      const cost = turn ? messageDeltaCost(event) : null
      if (turn && cost !== null) turn.providerCost = (turn.providerCost ?? 0) + cost
      if (subagent(frame)) return
      if (event.type === 'message_start') {
        const message = isObject(event.message) ? event.message : {}
        if (typeof message.id !== 'string' || !message.id) return
        const { source, first } = this.admit(message.id, bound)
        this.sighting(message.id, source, message.usage)
        // Only its first start is a new phase; a repeated start is not.
        if (bound && first && this.live(source) === bound) this.progressed(bound)
      } else if (event.type === 'message_delta' && isObject(event.usage) && this.cursor.messageId) {
        // A delta names no request: it continues the cursor's, on that request's own owner. It is no new phase.
        const source = this.sources.get(this.cursor.messageId)
        if (source) this.sighting(this.cursor.messageId, source, event.usage)
      }
    })
  }

  /** A system/api_retry frame on the bound turn. */
  apiRetry(frame: Frame, turn: Turn | null): void {
    const { resetsAt, window } = this.currentLimit()
    const failure = retryLimitFailure(frame, resetsAt, window)
    // The wait is registered before any observer runs (a reentrant interrupt then ends it, after its start).
    const start = failure && !failure.final && turn && !turn.settled ? this.waits.retried(turn.turnId, window, resetsAt) : null
    this.decide(() => this.later(() => this.limitEvents.publish(failure, start)))
  }

  /** A compaction boundary on the active turn (or none); reported once per id, true the first time. */
  compacted(boundaryId: string, preTokens: number | null, postTokens: unknown, turn: Turn | null): boolean {
    turn?.compactionIds.add(boundaryId)
    this.step(this.context.compact(typeof postTokens === 'number' ? postTokens : null, new Date().toISOString()))
    if (this.boundaries.has(boundaryId)) return false
    this.boundaries.add(boundaryId)
    const onCompaction = this.host.callbacks.onCompaction
    const turnId = turn?.turnId ?? null
    if (onCompaction) this.host.notify('onCompaction', () => onCompaction({ boundaryId, turnId, preTokens }))
    return true
  }

  /** The model an init names; reported when it changes. */
  model(model: unknown): void {
    if (typeof model !== 'string' || !model || model === this.lastModel) return
    this.lastModel = model
    const onModel = this.host.callbacks.onModel
    if (onModel) this.host.notify('onModel', () => onModel(model))
  }

  /** A quota report the session obtained itself (the host-login pull). */
  quotaReport(report: QuotaReport): void {
    const onQuotaReport = this.host.callbacks.onQuotaReport
    if (onQuotaReport) this.later(() => this.host.notify('onQuotaReport', () => onQuotaReport(report)))
  }

  private conversationReset(): void {
    this.cursor = { messageId: null, usage: EMPTY_REQUEST_USAGE }
    this.step(this.context.resetConversation())
  }

  /** Every result names its model windows, whatever the turn state (threshold fallback). */
  result(frame: Frame): void {
    const models = isObject(frame.modelUsage) ? Object.values(frame.modelUsage) : []
    for (const usage of models) if (isObject(usage)) this.step(this.context.noteModelWindow(usage.contextWindow))
  }

  /** The CLI's context-usage report. */
  contextReport(report: ContextReportSlice): void {
    this.step(this.context.applyReport(report))
  }

  /**
   * A turn is marked settled, before any of its events or callbacks: every id
   * it owns retires and its open wait's end is decided with `cause`.
   */
  turnSettling(turn: Turn, cause: LimitWaitEnd['cause']): void {
    for (const messageId of this.owned.get(turn) ?? []) this.sources.get(messageId)!.owner = RETIRED
    this.owned.delete(turn)
    const end = this.waits.ended(turn.turnId, cause)
    if (end) this.decided.set(turn.turnId, end)
  }

  /** A turn's result was published: its decided wait end goes out. */
  turnSettled(turn: Turn): void {
    const end = this.decided.get(turn.turnId)
    if (!end) return
    this.decided.delete(turn.turnId)
    this.publish(end)
  }

  /** A stop or unexpected exit: every open wait ends. */
  endAll(cause: 'cancelled' | 'process-ended'): void {
    for (const end of this.waits.endAll(cause)) this.publish(end)
  }

  private progressed(turn: Turn): void {
    const end = this.waits.progressed(turn.turnId)
    if (end) this.publish(end)
  }

  /** Admit `messageId` on its first sighting: owned by `bound` when live, else UNKNOWN for good. */
  private admit(messageId: string, bound: Turn | null): { source: Source; first: boolean } {
    const known = this.sources.get(messageId)
    if (known) return { source: known, first: false }
    const owner = bound && !bound.settled ? bound : UNKNOWN
    const source: Source = { owner, contents: new Set() }
    this.sources.set(messageId, source)
    if (owner !== UNKNOWN) {
      const ids = this.owned.get(owner) ?? new Set<string>()
      ids.add(messageId)
      this.owned.set(owner, ids)
    }
    return { source, first: true }
  }

  /** The source's owner while it is a live turn; null when unknown, retired or settled. */
  private live(source: Source): Turn | null {
    const owner = source.owner
    return typeof owner === 'symbol' || owner.settled ? null : owner
  }

  /**
   * One sighting of an admitted request: it becomes the context cursor even
   * without counters. Counters, when present, merge per field on its live
   * owner (a repeated snapshot counts once) and update the context reading.
   */
  private sighting(messageId: string, source: Source, incoming: unknown): void {
    const same = this.cursor.messageId === messageId
    const counters = isObject(incoming) ? incoming : null
    const usage = counters ? mergeRequestUsage(same ? this.cursor.usage : EMPTY_REQUEST_USAGE, counters) : same ? this.cursor.usage : EMPTY_REQUEST_USAGE
    this.cursor = { messageId, usage }
    if (!counters) return
    const owner = this.live(source)
    if (owner) {
      owner.requests.set(messageId, mergeClaudeRequestUsage(owner.requests.get(messageId) ?? null, counters)!)
      owner.usage = [...owner.requests.values()].reduce<TokenUsage | null>((sum, request) => addTokenUsage(sum, request), null)
    }
    this.step(this.context.readRequest(sumRequestUsage(usage), new Date().toISOString()))
  }

  /** Decide one frame whole, then run its publications in order (a nested call joins the outer frame). */
  private decide(body: () => void): void {
    if (this.pending) return body()
    const pending: Array<() => void> = []
    this.pending = pending
    try {
      body()
    } finally {
      this.pending = null
    }
    for (const publication of pending) publication()
  }

  /** A publication: queued while a frame is being decided, else now. */
  private later(publication: () => void): void {
    if (this.pending) this.pending.push(publication)
    else publication()
  }

  /** The announced reset and its window while still ahead. */
  private currentLimit(): { resetsAt: string | null; window: string | null } {
    if (this.limitResetsAt && Date.parse(this.limitResetsAt) <= Date.now()) {
      this.limitResetsAt = null
      this.limitWindow = null
    }
    return { resetsAt: this.limitResetsAt, window: this.limitWindow }
  }

  private publish(event: LimitEvent | null): void {
    if (event) this.later(() => this.limitEvents.publish(event))
  }

  private step(step: ContextStep): void {
    if (step.kind === 'none') return
    const onContextUsage = this.host.callbacks.onContextUsage
    const usage = step.kind === 'clear' ? null : step.usage
    if (onContextUsage) this.later(() => this.host.notify('onContextUsage', () => onContextUsage(usage)))
  }
}

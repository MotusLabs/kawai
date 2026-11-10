// The Claude session's usage, context, quota and limit facts (design §6,
// tasks 5.2/5.3; the mapping of Kawai's committed ChatSessionDriver over the
// pure ./usage parsers).
// - Per turn: tool-call and compaction ids (counted once each), the summed
//   provider cost of the turn's stream events, subagents' included, and the
//   tokens of the result bound to it. Nothing is carried from another turn.
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
//   wait ends resumed on the turn's next request frame after it (a
//   message_start or an assistant frame without an error) or its successful
//   result, else when the turn settles: cancelled, or process-ended for an
//   unexpected exit.
// Limit and wait events go out in order through one queue (usage/waits.ts).
// Every callback runs through the session's guarded notify.
import type { AgentCallbacks } from '../options.js'
import { ContextTracker, EMPTY_REQUEST_USAGE, mergeRequestUsage, parsePositiveTokens, sumRequestUsage, type ContextReportSlice, type ContextStep, type RequestUsage } from '../usage/context.js'
import { messageDeltaCost } from '../usage/cost.js'
import { assistantLimitFailure, rejectedResetsAt, rejectedWindow, retryLimitFailure } from '../usage/limits.js'
import { parseRateLimitEvent, parseUsageReport } from '../usage/quota.js'
import type { LimitEvent, LimitWaitEnd, QuotaReport } from '../usage/types.js'
import { LimitWaits, OrderedEvents } from '../usage/waits.js'
import type { Turn } from './turns.js'

export interface UsageFactsHost {
  callbacks: AgentCallbacks
  notify(name: string, callback: () => void): void
}

type Frame = Record<string, unknown>

const isObject = (value: unknown): value is Frame => typeof value === 'object' && value !== null && !Array.isArray(value)
const subagent = (frame: Frame) => frame.parent_tool_use_id != null

export class ClaudeUsageFacts {
  private readonly context = new ContextTracker()
  private readonly waits = new LimitWaits()
  private request: { messageId: string | null; usage: RequestUsage } = { messageId: null, usage: EMPTY_REQUEST_USAGE }
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
    if (frame.type === 'rate_limit_event') this.rateLimitEvent(frame)
    else if (frame.type === 'conversation_reset') this.conversationReset()
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
    const report = parseUsageReport(frame.usage_report)
    if (report) this.quotaReport(report)
    const message = isObject(frame.message) ? frame.message : {}
    if (!subagent(frame) && isObject(message.usage)) this.requestUsage(String(message.id ?? frame.uuid ?? ''), message.usage)
    if (!turn || subagent(frame)) return
    if (frame.error) {
      const content = Array.isArray(message.content) ? message.content : []
      const text = content.map((block) => (isObject(block) && block.type === 'text' ? String(block.text ?? '') : '')).join('\n')
      const { resetsAt, window } = this.currentLimit()
      this.limitEvents.publish(assistantLimitFailure(frame.error, text, resetsAt, window))
    } else this.progressed(turn)
  }

  /** A stream event; `turn` is the active turn whatever the frame binding (cost counts every call of it). */
  partial(frame: Frame, turn: Turn | null, bound: Turn | null): void {
    const event = isObject(frame.event) ? frame.event : {}
    const cost = turn ? messageDeltaCost(event) : null
    if (turn && cost !== null) turn.providerCost = (turn.providerCost ?? 0) + cost
    if (subagent(frame)) return
    if (event.type === 'message_start') {
      const message = isObject(event.message) ? event.message : {}
      if (typeof message.id === 'string' && message.id && isObject(message.usage)) this.requestUsage(message.id, message.usage)
      if (bound) this.progressed(bound)
    } else if (event.type === 'message_delta' && isObject(event.usage) && this.request.messageId) {
      this.requestUsage(this.request.messageId, event.usage)
    }
  }

  /** A system/api_retry frame on the bound turn. */
  apiRetry(frame: Frame, turn: Turn | null): void {
    const { resetsAt, window } = this.currentLimit()
    const failure = retryLimitFailure(frame, resetsAt, window)
    // The wait is registered before any observer runs (a reentrant interrupt then ends it, after its start).
    const start = failure && !failure.final && turn && !turn.settled ? this.waits.retried(turn.turnId, window, resetsAt) : null
    this.limitEvents.publish(failure, start)
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
    if (onQuotaReport) this.host.notify('onQuotaReport', () => onQuotaReport(report))
  }

  private conversationReset(): void {
    this.request = { messageId: null, usage: EMPTY_REQUEST_USAGE }
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

  /** A turn's result is decided and published: its open wait ends. */
  turnSettled(turnId: string, cause: LimitWaitEnd['cause']): void {
    const end = this.waits.ended(turnId, cause)
    if (end) this.publish(end)
  }

  /** A stop or unexpected exit: every open wait ends. */
  endAll(cause: 'cancelled' | 'process-ended'): void {
    for (const end of this.waits.endAll(cause)) this.publish(end)
  }

  private progressed(turn: Turn): void {
    const end = this.waits.progressed(turn.turnId)
    if (end) this.publish(end)
  }

  private requestUsage(messageId: string, incoming: Frame): void {
    const base = this.request.messageId === messageId ? this.request.usage : EMPTY_REQUEST_USAGE
    const usage = mergeRequestUsage(base, incoming)
    this.request = { messageId, usage }
    this.step(this.context.readRequest(sumRequestUsage(usage), new Date().toISOString()))
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
    this.limitEvents.publish(event)
  }

  private step(step: ContextStep): void {
    if (step.kind === 'none') return
    const onContextUsage = this.host.callbacks.onContextUsage
    const usage = step.kind === 'clear' ? null : step.usage
    if (onContextUsage) this.host.notify('onContextUsage', () => onContextUsage(usage))
  }
}

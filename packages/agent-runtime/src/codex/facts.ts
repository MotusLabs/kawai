// The Codex session's observed facts (tasks 4.2, 4.5, 5.2, 5.3): content
// events, the turn's own tool, compaction and token facts, context usage,
// quota reports, limit failures and limit waits, from the notifications
// events.ts maps, over the pure ./usage helpers. Facts bind to the turn the
// session resolved by native id; a notification for no open turn changes no
// turn (R03). Tool and compaction items count once per item id within a turn,
// so a successor turn or generation reusing an id is a distinct fact. Every
// host callback runs through the session's guarded notify (R11), and the
// names-only observer never sees tool input (P14).
// - Tokens: the generation's consecutive thread totals (usage/tokens.ts); a
//   new generation starts from its own first update, and a stale lower total
//   adds nothing.
// - Quota: account/rateLimits/updated (`push`) and the session's one
//   account/rateLimits/read reply (`report`), both the session's own login.
// - Limits: a retrying `error` notification of a limit kind is a non-final
//   failure and starts the turn's wait; a failed turn's limit is final. The
//   reset is the latest exhausted window of the latest snapshot.
// - Waits end resumed on the turn's next item, delta or token update after
//   the retry, or its successful completion; cancelled when it ends any other
//   way; process-ended on an unexpected exit. No clock ends one.
import type { AgentErrorInfo } from '../errors.js'
import type { EventBody } from '../eventStream.js'
import type { JsonValue } from '../json.js'
import type { AgentCallbacks, CodexAuditHooks, ToolObservation } from '../options.js'
import type { TurnOutcome } from '../contract.js'
import { codexLimitFailure } from '../usage/limits.js'
import { codexQuotaReport, codexReadSnapshot } from '../usage/quota.js'
import { addTokenUsage, codexRequestUsage, codexUpdateRequests, type CodexTokenBreakdown } from '../usage/tokens.js'
import type { LimitEvent } from '../usage/types.js'
import { LimitWaits, OrderedEvents } from '../usage/waits.js'
import { codexErrorCategory, codexErrorKind } from './auth.js'
import { mapCodexNotification } from './events.js'
import type { CodexTurnState } from './turns.js'

export interface FactsHost {
  emit(body: EventBody): void
  notify(name: string, callback: () => void): void
  callbacks: AgentCallbacks
  onToolObservation?(observation: ToolObservation): void
  auditHooks?: CodexAuditHooks
}

type TurnError = { message?: unknown; codexErrorInfo?: unknown } | null

/** Notifications that show the runtime working on their turn again (a wait's resumption). */
/** Notifications that are the turn's own work; a token update counts only when it grew a counter (FRESH-B). */
const PROGRESS = new Set(['item/started', 'item/completed', 'item/agentMessage/delta'])

export class CodexFacts {
  /** The generation's last reported token total (deltas between totals are a turn's requests). */
  private lastTotal: CodexTokenBreakdown | null = null
  private snapshot: Record<string, unknown> | null = null
  private readonly toolNames = new Map<string, string>()
  private readonly compactions = new Set<string>()
  private readonly published = new Set<string>()
  private readonly waits = new LimitWaits()
  private lastModel: string | null = null
  private readonly limitEvents = new OrderedEvents<LimitEvent>((event) => {
    const onLimitEvent = this.host.callbacks.onLimitEvent
    if (onLimitEvent) this.host.notify('onLimitEvent', () => onLimitEvent(event))
  })

  constructor(private readonly host: FactsHost) {}

  /** The thread's model as last reported. */
  get model(): string | null {
    return this.lastModel
  }

  /** A new generation: its token totals are its own. */
  generation(): void {
    this.lastTotal = null
  }

  notification(method: string, params: Record<string, unknown>, turn: CodexTurnState | null): void {
    if (method === 'item/started' || method === 'item/completed') this.audit(params.item)
    let grew = false
    for (const output of mapCodexNotification(method, params, turn?.turnId ?? null)) {
      switch (output.kind) {
        case 'event':
          this.event(output.body)
          break
        case 'agent_text':
          if (turn) turn.finalText = output.text
          break
        case 'tool':
          turn?.toolIds.add(output.itemId)
          break
        case 'compaction':
          this.compacted(output.itemId, turn)
          break
        case 'token_usage':
          // FRESH-B: only an accepted update that grew a counter is progress; a stale or repeated total is not.
          grew = this.tokens(output.total, output.last, output.window, turn)
          break
        case 'rate_limits':
          this.quota(output.snapshot, 'push')
          break
        case 'retry_error':
          if (output.willRetry) this.retried(output.error, turn)
          break
        default:
          break
      }
    }
    if (turn && (grew || PROGRESS.has(method))) this.endWait(turn.turnId, 'resumed')
  }

  /** The thread's model (thread/start or thread/resume); reported when it changes. */
  reportModel(model: string | null): void {
    if (!model || model === this.lastModel) return
    this.lastModel = model
    const onModel = this.host.callbacks.onModel
    if (onModel) this.host.notify('onModel', () => onModel(model))
  }

  /** The account/rateLimits/read reply: a `report`; it fills the reset source only when no push came first. */
  quotaRead(result: unknown): void {
    const snapshot = codexReadSnapshot(result)
    if (snapshot) this.quota(snapshot, 'report')
  }

  /** The completed turn's last agent message, when it carries one. */
  finalText(turn: CodexTurnState, items: unknown[] | undefined): void {
    const last = [...(items ?? [])].reverse().find((item) => (item as { type?: unknown } | null)?.type === 'agentMessage') as { text?: unknown } | undefined
    if (typeof last?.text === 'string' && last.text) turn.finalText = last.text
  }

  /** A failed turn's error, most specific category first (R02). Pure: it publishes nothing (F2). */
  turnError(error: TurnError): AgentErrorInfo {
    const kind = codexErrorKind(error?.codexErrorInfo)
    const message = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : 'The Codex turn failed'
    return { category: codexErrorCategory(error?.codexErrorInfo, 'provider'), message: kind ? `${message} (${kind})` : message, ...(kind ? { code: kind } : {}) }
  }

  /** The final limit failure of a failed turn, reported once after its outcome is decided (F2). */
  finalLimit(error: TurnError): void {
    this.publish(codexLimitFailure(error, true, this.snapshot))
  }

  terminalReason(error: TurnError): string | null {
    return codexErrorKind(error?.codexErrorInfo)
  }

  /** A turn's result was decided and published: its open wait ends (resumed only for a success). */
  turnSettled(turnId: string, outcome: TurnOutcome): void {
    this.endWait(turnId, outcome === 'success' ? 'resumed' : outcome === 'process-ended' ? 'process-ended' : 'cancelled')
  }

  /** A stop or unexpected exit: every open wait ends. */
  endAll(cause: 'cancelled' | 'process-ended'): void {
    for (const end of this.waits.endAll(cause)) this.publish(end)
  }

  private event(body: EventBody): void {
    // A repeated tool item (same turn, id and phase) is published once (R03).
    if (body.type === 'tool_call' || body.type === 'tool_result') {
      const key = `${body.turnId}:${body.type}:${body.toolCallId}`
      if (this.published.has(key)) return
      this.published.add(key)
    }
    this.host.emit(body)
    const observe = this.host.onToolObservation
    if (!observe) return
    if (body.type === 'tool_call') {
      this.toolNames.set(body.toolCallId, body.tool)
      this.host.notify('onToolObservation', () => observe({ phase: 'call', tool: body.tool, toolCallId: body.toolCallId, turnId: body.turnId }))
    } else if (body.type === 'tool_result') {
      const tool = this.toolNames.get(body.toolCallId) ?? 'unknown'
      this.host.notify('onToolObservation', () => observe({ phase: 'result', tool, toolCallId: body.toolCallId, turnId: body.turnId, isError: body.isError }))
    }
  }

  private audit(item: unknown): void {
    const onItem = this.host.auditHooks?.onItem
    const raw = item as { id?: unknown; type?: unknown } | null
    if (!onItem || typeof raw?.id !== 'string') return
    const detail = JSON.parse(JSON.stringify(item)) as JsonValue
    this.host.notify('auditHooks.onItem', () => onItem({ kind: String(raw.type ?? 'unknown'), itemId: raw.id as string, detail }))
  }

  private compacted(itemId: string, turn: CodexTurnState | null): void {
    turn?.compactionIds.add(itemId)
    const key = `${turn?.turnId ?? ''}:${itemId}`
    if (this.compactions.has(key)) return
    this.compactions.add(key)
    this.host.emit({ type: 'notice', text: 'The conversation was compacted', kind: 'compacted' })
    const onCompaction = this.host.callbacks.onCompaction
    if (onCompaction) this.host.notify('onCompaction', () => onCompaction({ boundaryId: itemId, turnId: turn?.turnId ?? null, preTokens: null }))
  }

  /** Returns whether the update is new work: accepted, with some counter grown. */
  private tokens(total: CodexTokenBreakdown | null, last: CodexTokenBreakdown | null, window: number | null, turn: CodexTurnState | null): boolean {
    const { requests, total: measured } = codexUpdateRequests(total, last, this.lastTotal)
    this.lastTotal = measured
    if (turn) turn.usage = addTokenUsage(turn.usage, codexRequestUsage(requests))
    const grew = requests !== null && Object.values(requests).some((value) => typeof value === 'number' && value > 0)
    const onContextUsage = this.host.callbacks.onContextUsage
    const input = typeof last?.inputTokens === 'number' ? last.inputTokens : null
    const output = typeof last?.outputTokens === 'number' ? last.outputTokens : null
    if (!onContextUsage || window === null || window <= 0 || input === null || output === null) return grew
    const used = input + output
    const usage = { usedTokens: used, thresholdTokens: window, percentage: Math.round((used / window) * 1000) / 10, at: new Date().toISOString(), thresholdApproximate: true }
    this.host.notify('onContextUsage', () => onContextUsage(usage))
    return grew
  }

  private quota(snapshot: Record<string, unknown>, source: 'push' | 'report'): void {
    if (source === 'push' || this.snapshot === null) this.snapshot = snapshot
    const report = codexQuotaReport(snapshot, source)
    if (source === 'report' && report.windows.length === 0) return
    const onQuotaReport = this.host.callbacks.onQuotaReport
    if (onQuotaReport) this.host.notify('onQuotaReport', () => onQuotaReport(report))
  }

  /** A retrying limit error: a non-final failure, and the turn's wait starts. */
  private retried(error: { message?: unknown; codexErrorInfo?: unknown }, turn: CodexTurnState | null): void {
    const failure = codexLimitFailure(error, false, this.snapshot)
    if (!failure) return
    // The wait is registered before any observer runs (a reentrant interrupt then ends it, after its start).
    const start = turn && !turn.settled ? this.waits.retried(turn.turnId, failure.window, failure.resetsAt) : null
    this.limitEvents.publish(failure, start)
  }

  private endWait(turnId: string, cause: 'resumed' | 'cancelled' | 'process-ended'): void {
    this.publish(this.waits.ended(turnId, cause))
  }

  private publish(event: LimitEvent | null): void {
    this.limitEvents.publish(event)
  }
}

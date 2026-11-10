// The Codex session's observed facts (tasks 4.2, 4.5): content events, the
// turn's own tool, compaction and token facts, context usage, quota reports
// and limit failures, from the notifications events.ts maps. Facts bind to the
// turn the session resolved by native id; a notification for no open turn
// changes no turn (R03). Tool and compaction items count once per item id.
// Every host callback runs through the session's guarded notify (R11), and the
// names-only observer never sees tool input (P14).
import type { AgentErrorInfo } from '../errors.js'
import type { EventBody } from '../eventStream.js'
import type { JsonValue } from '../json.js'
import type { AgentCallbacks, CodexAuditHooks, ToolObservation } from '../options.js'
import { codexErrorCategory, codexErrorKind } from './auth.js'
import { addUsage, exhaustedReset, mapCodexNotification, quotaReport, turnUsage, usageDelta, type CodexTokenBreakdown } from './events.js'
import type { CodexTurnState } from './turns.js'

export interface FactsHost {
  emit(body: EventBody): void
  notify(name: string, callback: () => void): void
  callbacks: AgentCallbacks
  onToolObservation?(observation: ToolObservation): void
  auditHooks?: CodexAuditHooks
}

type TurnError = { message?: unknown; codexErrorInfo?: unknown } | null

const LIMIT_CATEGORIES = new Set(['quota', 'rate-limit'])

export class CodexFacts {
  /** The thread's last reported token total (deltas between totals are a turn's requests). */
  private lastTotal: CodexTokenBreakdown | null = null
  private snapshot: Record<string, unknown> | null = null
  private readonly toolNames = new Map<string, string>()
  private readonly compactions = new Set<string>()
  private readonly published = new Set<string>()

  constructor(private readonly host: FactsHost) {}

  notification(method: string, params: Record<string, unknown>, turn: CodexTurnState | null): void {
    if (method === 'item/started' || method === 'item/completed') this.audit(params.item)
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
          this.tokens(output.total, output.last, output.window, turn)
          break
        case 'rate_limits':
          this.quota(output.snapshot)
          break
        case 'retry_error':
          if (output.willRetry) this.limit(output.error, false)
          break
        default:
          break
      }
    }
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
    if (error) this.limit(error, true)
  }

  terminalReason(error: TurnError): string | null {
    return codexErrorKind(error?.codexErrorInfo)
  }

  private event(body: EventBody): void {
    // A repeated tool item (same id and phase) is published once (R03).
    if (body.type === 'tool_call' || body.type === 'tool_result') {
      const key = `${body.type}:${body.toolCallId}`
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
    if (this.compactions.has(itemId)) return
    this.compactions.add(itemId)
    this.host.emit({ type: 'notice', text: 'The conversation was compacted', kind: 'compacted' })
    const onCompaction = this.host.callbacks.onCompaction
    if (onCompaction) this.host.notify('onCompaction', () => onCompaction({ boundaryId: itemId, turnId: turn?.turnId ?? null, preTokens: null }))
  }

  private tokens(total: CodexTokenBreakdown | null, last: CodexTokenBreakdown | null, window: number | null, turn: CodexTurnState | null): void {
    const requests = this.lastTotal ? usageDelta(total, this.lastTotal) : last
    if (total) this.lastTotal = total
    if (turn) turn.usage = addUsage(turn.usage, turnUsage(requests))
    const onContextUsage = this.host.callbacks.onContextUsage
    const input = typeof last?.inputTokens === 'number' ? last.inputTokens : null
    const output = typeof last?.outputTokens === 'number' ? last.outputTokens : null
    if (!onContextUsage || window === null || window <= 0 || input === null || output === null) return
    const used = input + output
    const usage = { usedTokens: used, thresholdTokens: window, percentage: Math.round((used / window) * 1000) / 10, at: new Date().toISOString(), thresholdApproximate: true }
    this.host.notify('onContextUsage', () => onContextUsage(usage))
  }

  private quota(snapshot: Record<string, unknown>): void {
    this.snapshot = snapshot
    const onQuotaReport = this.host.callbacks.onQuotaReport
    const report = quotaReport(snapshot)
    if (onQuotaReport) this.host.notify('onQuotaReport', () => onQuotaReport(report))
  }

  /** A limit-kind failure (quota or rate limit): retried (final false) or the turn's end. */
  private limit(error: { message?: unknown; codexErrorInfo?: unknown }, final: boolean): void {
    const onLimitEvent = this.host.callbacks.onLimitEvent
    const kind = codexErrorKind(error.codexErrorInfo)
    if (!onLimitEvent || !kind || !LIMIT_CATEGORIES.has(codexErrorCategory(error.codexErrorInfo))) return
    const event = {
      type: 'failure' as const, kind, final, status: null,
      message: typeof error.message === 'string' && error.message.trim() ? error.message : null,
      resetsAt: exhaustedReset(this.snapshot), window: null,
    }
    this.host.notify('onLimitEvent', () => onLimitEvent(event))
  }
}

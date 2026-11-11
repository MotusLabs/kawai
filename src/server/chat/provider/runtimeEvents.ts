// Translation from @motuslabs/agent-runtime's public shapes to Kawai's chat
// shapes (task 6.1): the package moved these shapes out of Kawai, so most map
// field for field. Kawai keeps its own event identity: one increasing
// sequence per Kawai driver across every inner package driver it builds
// (a respawn's fresh package stream continues Kawai's), `evt-<uuid>` ids and
// an empty `at` for an unknown time. A package `caller` decision is Kawai's
// `user`; an error event carries its message only.
import type { AgentEvent, AgentNotification, LimitEvent, QuotaReport } from '@motuslabs/agent-runtime'
import type { ChatEvent, ChatNotification, ChatUsageReport, ChatUsageSource } from '../../../shared/chat'
import type { ChatLimitSignal } from '../limitSignals'

/** A chat event without the identity fields the sequencer adds. */
export type ChatEventDraft = ChatEvent extends infer E ? (E extends ChatEvent ? Omit<E, 'id' | 'sequence' | 'at'> : never) : never

/** Kawai's event identity for every event one chat driver emits. */
export class ChatEventSequencer {
  private sequence = 0

  stamp(draft: ChatEventDraft, at?: string | null): ChatEvent {
    this.sequence += 1
    return { ...draft, id: `evt-${crypto.randomUUID()}`, sequence: this.sequence, at: at ?? new Date().toISOString() } as ChatEvent
  }
}

/**
 * One package event as a Kawai draft, or null when Kawai shows nothing for
 * it. Request events are the adapter's (policy and card input); this maps the
 * conversation events.
 */
export function chatDraftOf(event: AgentEvent): ChatEventDraft | null {
  switch (event.type) {
    case 'turn_started':
      return { type: 'turn_started', turnId: event.turnId, ...(event.trigger ? { trigger: event.trigger } : {}) }
    case 'user_message':
      return { type: 'user_message', turnId: event.turnId, text: event.text, messageUuid: event.messageUuid }
    case 'command_output':
      return { type: 'command_output', turnId: event.turnId, text: event.text }
    case 'assistant_text':
      return { type: 'assistant_text', turnId: event.turnId, messageId: event.messageId, text: event.text }
    case 'assistant_delta':
      return { type: 'assistant_delta', turnId: event.turnId, messageId: event.messageId, delta: event.delta }
    case 'tool_call':
      return { type: 'tool_call', turnId: event.turnId, toolCallId: event.toolCallId, tool: event.tool, input: event.input }
    case 'tool_result':
      return { type: 'tool_result', turnId: event.turnId, toolCallId: event.toolCallId, output: event.output, ...(event.isError ? { isError: true } : {}) }
    case 'turn_completed':
      return {
        type: 'turn_completed',
        turnId: event.turnId,
        subtype: event.subtype as Extract<ChatEvent, { type: 'turn_completed' }>['subtype'],
        ...(event.isError ? { isError: true } : {}),
        ...(event.terminalReason ? { terminalReason: event.terminalReason } : {}),
        ...(event.usage ? { usage: { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0, cacheReadTokens: event.usage.cacheReadTokens ?? 0, cacheCreationTokens: event.usage.cacheCreationTokens ?? 0 } } : {}),
        ...(event.finalText !== null && !event.isError && event.subtype === 'success' ? { finalText: event.finalText } : {}),
        ...(event.totalCostUsd !== null ? { totalCostUsd: event.totalCostUsd } : {}),
        ...(event.providerCostUsd !== null ? { providerCostUsd: event.providerCostUsd } : {}),
        ...(event.numTurns !== null ? { numTurns: event.numTurns } : {}),
      }
    case 'turn_interrupted':
      return { type: 'turn_interrupted', turnId: event.turnId }
    case 'notice':
      return { type: 'notice', text: event.text, ...(event.kind ? { kind: event.kind } : {}) }
    case 'error':
      return { type: 'error', message: event.error.message }
    default:
      return null
  }
}

/** A package quota report as Kawai's usage report; `report` is a session read (Codex `provider`, Claude `pull`). */
export function chatUsageReport(report: QuotaReport, readSource: ChatUsageSource): ChatUsageReport {
  const source: ChatUsageSource = report.source === 'push' ? 'push' : report.source === 'host-login-pull' ? 'pull' : report.source === 'host-supplied' ? 'provider' : readSource
  return {
    status: report.status,
    windows: report.windows.map((window) => ({ key: window.key, label: window.label, percentUsed: window.percentUsed, resetsAt: window.resetsAt, ...(window.periodMs !== null ? { periodMs: window.periodMs } : {}) })),
    receivedAt: report.receivedAt,
    source,
  }
}

/** A limit failure as Kawai's signal; the package's wait edges have no Kawai counterpart. */
export function chatLimitSignal(event: LimitEvent): ChatLimitSignal | null {
  if (event.type !== 'failure') return null
  return { kind: event.kind, final: event.final, status: event.status, message: event.message, resetsAt: event.resetsAt, window: event.window }
}

/** An agent notice; every runtime notice is the agent's own. */
export function chatNotification(notice: AgentNotification): ChatNotification {
  return { key: notice.key, source: 'agent', severity: notice.severity, priority: notice.priority, text: notice.text, ...(notice.hint ? { hint: notice.hint } : {}), receivedAt: notice.receivedAt }
}

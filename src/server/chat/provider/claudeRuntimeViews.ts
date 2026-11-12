// Pure views and mappings of Kawai's Claude chat adapter (claudeRuntime.ts;
// task 6.1): the rosters merged over recovered rows, the background task's
// private output file (contract D: kept in the server-side record, stripped
// from every client view), the prompt envelope (R4), the deadline's answer
// texts and its note (R5), the resolved event, and the host callbacks forwarded as-is.
import type { AgentEvent, BackgroundTask, ClaudeDriverOptions, PromptEnvelope, SubmitContext, Worker } from '@motuslabs/agent-runtime'
import type { ChatBackgroundTask, ChatPeerMessage, ChatQuestionAnswer, ChatWorker } from '../../../shared/chat'
import { workspaceContextBlock, type WorkspaceMessageContext } from '../../../shared/planWorkspace'
import type { BackgroundTaskRecord } from '../chatBackgroundTasks'
import type { ChatSessionDriverOptions } from './claudeDriverTypes'
import type { ChatDriverCallbacks } from './driver'
import { chatLimitSignal, chatNotification, chatUsageReport, type ChatEventDraft } from './runtimeEvents'

/** A live package task as the client sees it: never its output file. */
export function taskView(task: BackgroundTask): ChatBackgroundTask {
  const { outputFile: _private, ...view } = task
  return view as ChatBackgroundTask
}

/** Recovered rows the live roster does not name, then the live ones. */
export function mergedTasks(live: readonly BackgroundTask[], recovered: readonly BackgroundTaskRecord[]): ChatBackgroundTask[] {
  const ids = new Set(live.map((task) => task.taskId))
  const rows = recovered.filter((row) => !ids.has(row.taskId)).map((row): ChatBackgroundTask => {
    const { outputFile: _private, ...view } = row
    return { ...view, live: false, elapsedMs: (row.endedAtMs ?? row.startedAtMs) - row.startedAtMs }
  })
  return [...rows, ...live.map(taskView)]
}

/**
 * The sidecar's records: identity, outcome and the output file — the live
 * task's observed path, else the one its recovered row recorded.
 */
export function mergedTaskRecords(live: readonly BackgroundTask[], recovered: readonly BackgroundTaskRecord[]): BackgroundTaskRecord[] {
  const byId = new Map(recovered.map((row) => [row.taskId, row]))
  const rows = live.map((task): BackgroundTaskRecord => {
    const outputFile = task.outputFile ?? byId.get(task.taskId)?.outputFile
    return {
      taskId: task.taskId,
      ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
      kind: task.kind,
      ...(task.description ? { description: task.description } : {}),
      status: task.status,
      ...(task.summary ? { summary: task.summary } : {}),
      ...(outputFile ? { outputFile } : {}),
      startedAtMs: task.startedAtMs,
      ...(task.endedAtMs !== undefined ? { endedAtMs: task.endedAtMs } : {}),
    }
  })
  const ids = new Set(rows.map((row) => row.taskId))
  return [...recovered.filter((row) => !ids.has(row.taskId)), ...rows]
}

export function mergedWorkers(live: readonly Worker[], recovered: readonly ChatWorker[]): ChatWorker[] {
  const ids = new Set(live.map((worker) => worker.workerId))
  return [...recovered.filter((row) => !ids.has(row.workerId)), ...(live as ChatWorker[])]
}

/**
 * R4: Kawai's two envelope sites on the one outer prompt — a workspace
 * context rides `pasted_content` (the typed text stays literal), a peer
 * turn carries its sender (`human` when the envelope names no session).
 */
export function promptEnvelope(submission: SubmitContext, peer: ChatPeerMessage | undefined): PromptEnvelope | undefined {
  const context = submission.context as WorkspaceMessageContext | undefined
  if (context) return { pastedContent: [workspaceContextBlock(context)] }
  if (peer) return { origin: { kind: 'peer', from: peer.senderSession ?? 'human' } }
  return undefined
}

/**
 * A contextual send's one DB write (plan-workspace §4 I1) under the
 * package's turn id; null when recorded, else Kawai's refusal text.
 */
export function recordedContext(options: Pick<ChatSessionDriverOptions, 'sessionId' | 'recordWorkspaceContext'>, submission: SubmitContext, context: WorkspaceMessageContext): string | null {
  try {
    const recorded = options.recordWorkspaceContext?.({ sessionId: options.sessionId, messageUuid: submission.messageUuid, turnId: submission.turnId, context })
    if (recorded?.ok) return null
    return `${recorded?.message ?? 'The plan context could not be recorded.'} The message was not sent.`
  } catch (error) {
    return `The plan context could not be recorded (${error instanceof Error ? error.message : String(error)}); the message was not sent.`
  }
}

/** R5: the note a deadline's answer explains itself with (question-auto-answer). */
export function timeoutNote(waitMs: number): string {
  const minutes = Math.round(waitMs / 60000)
  return `No answer from the user within ${minutes} minute${minutes === 1 ? '' : 's'}; the recommended option was selected automatically.`
}

/**
 * Kawai's resolved event: who decided (Kawai's own policy grant reads as
 * policy, the package's caller as the user), the policy's tool, and a
 * deadline's answer texts.
 */
export function resolvedDraft(event: Extract<AgentEvent, { type: 'request_resolved' }>, grantedByPolicy: boolean, tool: string | undefined, deadlineAnswers: Record<string, ChatQuestionAnswer> | undefined): ChatEventDraft {
  const decidedBy = grantedByPolicy || event.decidedBy === 'policy' ? 'policy' : event.decidedBy === 'timeout' ? 'timeout' : event.decidedBy === 'caller' ? 'user' : undefined
  return {
    type: 'request_resolved',
    requestId: event.requestId,
    outcome: event.outcome,
    ...(decidedBy ? { decidedBy } : {}),
    ...(decidedBy === 'policy' && tool ? { tool } : {}),
    ...(decidedBy === 'timeout' && deadlineAnswers ? { answers: joinedAnswers(deadlineAnswers) } : {}),
  } as ChatEventDraft
}

/** The answer text a deadline gave each question (the resolved event's `answers`). */
export function joinedAnswers(answers: Record<string, ChatQuestionAnswer>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, [...(answer.options ?? []), ...(answer.text ? [answer.text] : [])].join(', ')]))
}

export function callKey(tool: string, input: unknown): string {
  return `${tool}\u0000${JSON.stringify(input)}`
}

/** Host callbacks forwarded as-is through `hosted`, which owns a returned promise (A10). */
export function forwardedCallbacks(options: ChatDriverCallbacks, hosted: (label: string, fn: () => unknown) => void) {
  return {
    onModel: (model) => hosted('onModel', () => options.onModel?.(model)),
    onActivity: (activity) => hosted('onActivity', () => options.onActivity?.(activity)),
    onContextUsage: (usage, meta) => hosted('onContextUsage', () => options.onContextUsage?.(usage, meta)),
    onCompactionObservation: (o) =>
      hosted('onCompaction', () => options.onCompaction?.({ trigger: o.trigger, startedAt: o.startedAt, endedAt: o.endedAt, preTokens: o.preTokens, postTokens: o.postTokens, durationSeconds: o.durationSeconds, outcome: o.outcome }, o.sourceId ?? undefined)),
    onQuotaReport: (report) =>
      hosted('onQuotaReport', () => (report.source === 'push' ? options.onRateLimit?.(chatUsageReport(report, 'push')) : options.onUsageReport?.(chatUsageReport(report, 'report')))),
    onQuotaNoData: () => hosted('onUsageNoData', () => options.onUsageNoData?.()),
    onLimitEvent: (event) => {
      const signal = chatLimitSignal(event)
      if (signal) hosted('onLimitEvent', () => options.onLimitEvent?.(signal))
    },
    onNotification: (notice, timeoutMs) => hosted('onNotification', () => options.onNotification?.(chatNotification(notice), timeoutMs)),
    onCwdChanged: (cwd) => hosted('onCwdChanged', () => options.onCwdChanged?.(cwd)),
  } satisfies Partial<ClaudeDriverOptions['callbacks']>
}

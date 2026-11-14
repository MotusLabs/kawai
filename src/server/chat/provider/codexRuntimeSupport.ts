// Pure helpers of Kawai's Codex chat adapter (codexRuntime.ts; task 6.1):
// the package's exit-cause text and the quiescence check over it, the
// package logger, approval card inputs, the team tool table as a package
// tool set, the per-spawn launch fields, the forwarded host callbacks,
// the request-answer outcome texts, the pending-request view, and an
// agentMessage's async questions as Kawai's question cards (moved verbatim
// from codex/codexEvents.ts, task-ce05430a R2).
import os from 'node:os'
import type { AnswerOutcome, CodexDriverOptions, Logger, PendingRequest, ToolSet } from '@motuslabs/agent-runtime'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatPendingRequest, ChatQuestion } from '../../../shared/chat'
import { logger } from '../../logger'
import type { CodexSessionDriverOptions } from './codexDriverTypes'
import { TEAM_MCP_SERVER } from '../../team/teamPrompt'
import { chatLimitSignal, chatUsageReport } from './runtimeEvents'

/**
 * The package's own description of a generation's unexpected exit, as its
 * stop reports it (one native-exit cause per crashed generation).
 */
export function exitCause(generation: number, code: number | null, signal: string | null): string {
  return `agent process generation ${generation} ${signal ? `ended by ${signal}` : `exited with code ${code}`} before the stop`
}

/**
 * Whether a rejected kill still left its owner quiesced. The package rejects
 * a stop only after its terminal join, and an unexpected exit is itself one
 * of the stop's causes. So a rejection whose every cause is exactly an exit
 * this adapter already heard through onProcessEnd quiesced, as does the very
 * start failure it already reported (`heard`: a start that never opened is
 * owned work its stop reports again); any other cause (a teardown that could
 * not confirm the exit, another owned failure) did not, and nothing respawns
 * over it.
 */
export function quiesced(error: unknown, exits: readonly string[], heard: readonly unknown[] = []): boolean {
  if (!(error instanceof AgentRuntimeError) || error.category !== 'stop') return false
  const remaining = [...exits]
  for (const cause of error.causes) {
    if (heard.includes(cause)) continue
    const at = cause instanceof AgentRuntimeError && cause.category === 'transport' ? remaining.indexOf(cause.message) : -1
    if (at < 0) return false
    remaining.splice(at, 1)
  }
  return error.causes.length > 0
}

/** A package logger writing Kawai's structured log. */
export function runtimeLogger(sessionId: string): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error') => (obj: object, msg?: string) => logger[level](msg ?? 'agent_runtime', { sessionId, ...(obj as Record<string, unknown>) })
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** The approval card's input: what the request names, plus the started item's paths (codexRequests D5). */
export function cardInput(tool: string, params: Record<string, unknown>, item: Record<string, unknown> | undefined): Record<string, unknown> {
  const reason = typeof params.reason === 'string' && params.reason ? { reason: params.reason } : {}
  if (tool === 'Bash') return { command: params.command ?? item?.command ?? '', ...(params.cwd ? { cwd: params.cwd } : {}), ...reason }
  if (tool === 'Edit') return { file_path: item?.file_path ?? '', paths: item?.paths ?? [], ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}), ...reason }
  return { permissions: params.permissions ?? {}, ...(params.cwd ? { cwd: params.cwd } : {}), ...reason }
}

export interface Card {
  tool: string
  itemId: string
  input: Record<string, unknown>
}

export interface AsyncQuestion {
  requestId: string
  turnId: string
  questions: ChatQuestion[]
  at: string
}

/** Kawai's team tools as one package tool set; a handler's throw is the tool's error result. */
export function teamToolSet(table: NonNullable<CodexSessionDriverOptions['teamTools']>): ToolSet | undefined {
  if (!table.length) return undefined
  return {
    namespace: TEAM_MCP_SERVER,
    tools: table.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema,
      handler: async (input: unknown) => {
        try {
          return { content: JSON.stringify(await tool.handler(input)) }
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true }
        }
      },
    })),
  }
}

/**
 * The per-spawn launch fields (see codexRuntime.ts's header): the logger, the
 * launch inputs, the one workspace-write sandbox with the Git common
 * directory as its extra root, the wire, waiting requests, and the R2 claim.
 */
export function launchFields(options: CodexSessionDriverOptions, cwd: string, env: Record<string, string>, commonDir: string | null) {
  return {
    logger: runtimeLogger(options.sessionId),
    launch: { cwd, childEnv: env, executablePath: options.executable, homeDir: options.codexHome, cacheDir: os.tmpdir(), tempDir: os.tmpdir() },
    permissions: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: options.network, writableRoots: commonDir ? [commonDir] : [], userInput: 'enabled', elicitation: 'disabled' },
    wire: { record: (frame) => options.wire.record(frame.direction, frame.text) },
    unansweredRequests: 'wait',
    ...(options.claimRateLimitsRead ? { claimRateLimitsRead: options.claimRateLimitsRead } : {}),
  } satisfies Partial<CodexDriverOptions>
}

/** Host callbacks forwarded as-is through `hosted`, which owns a returned promise (A10). */
export function forwardedCallbacks(options: CodexSessionDriverOptions, hosted: (label: string, fn: () => unknown) => void) {
  return {
    onModel: (model) => hosted('onModel', () => options.onModel?.(model)),
    onActivity: (activity) => hosted('onActivity', () => options.onActivity?.(activity)),
    onContextUsage: (usage, meta) => hosted('onContextUsage', () => options.onContextUsage?.(usage, meta)),
    onCompactionObservation: (o) =>
      hosted('onCompaction', () => options.onCompaction?.({ trigger: o.trigger, startedAt: o.startedAt, endedAt: o.endedAt, preTokens: o.preTokens, postTokens: o.postTokens, durationSeconds: o.durationSeconds, outcome: o.outcome }, o.sourceId ?? undefined)),
    onQuotaReport: (report) => hosted('onRateLimit', () => options.onRateLimit?.(chatUsageReport(report, 'provider'))),
    onQuotaNoData: () => hosted('onUsageNoData', () => options.onUsageNoData?.()),
    onLimitEvent: (event) => {
      const signal = chatLimitSignal(event)
      if (signal) hosted('onLimitEvent', () => options.onLimitEvent?.(signal))
    },
  } satisfies Partial<CodexDriverOptions['callbacks']>
}

/** A package answer as Kawai's result; nothing pending keeps Kawai's text. */
export function requestOutcome(outcome: AnswerOutcome | undefined, kind: 'approval' | 'question', requestId: string): { ok: true } | { ok: false; error: string } {
  if (!outcome || (!outcome.ok && outcome.reason === 'not-pending')) return { ok: false, error: `No pending ${kind} with id ${requestId}; it may already be answered or cancelled` }
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.message }
}

/** Why a hold is refused: Codex chats never arm an auto-answer deadline (QA-U4). */
export function holdRefusal(requestId: string, ownQuestion: boolean, pending: readonly PendingRequest[]): { ok: false; error: string } {
  const isQuestion = ownQuestion || pending.some((r) => r.requestId === requestId && r.kind === 'question')
  if (isQuestion) return { ok: false, error: `Request ${requestId} has no auto-answer deadline to hold` }
  const approval = pending.some((r) => r.requestId === requestId)
  return { ok: false, error: approval ? `Request ${requestId} is not a question` : `No pending question with id ${requestId}; it may already be answered or cancelled` }
}

/** A package request as Kawai's pending view; an approval shows its card's input. */
export function pendingOf(request: PendingRequest, cards: ReadonlyMap<string, Card>): ChatPendingRequest {
  if (request.kind === 'question') return { kind: 'question', requestId: request.requestId, questions: request.questions as ChatQuestion[], at: request.at }
  return { kind: 'approval', requestId: request.requestId, tool: request.tool, input: cards.get(request.requestId)?.input ?? request.input, at: request.at }
}

/** Async questions (title + options) as question cards; null when none. */
export function asyncQuestions(raw: unknown): ChatQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: ChatQuestion[] = []
  for (const entry of raw) {
    const title = (entry as { title?: unknown } | null)?.title
    if (typeof title !== 'string' || title.trim() === '') continue
    const options = (entry as { options?: unknown }).options
    questions.push({
      question: title,
      header: '',
      multiSelect: false,
      options: Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string').map(label => ({ label })) : [],
    })
  }
  return questions.length > 0 ? questions : null
}

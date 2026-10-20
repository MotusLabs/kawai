// The Codex driver's launch surface (codex-chat-sessions D2/D5): its options,
// the parameters every thread start and resume carries — the one sandbox,
// `approvalPolicy: "on-request"` with `approvalsReviewer: "user"` so every
// escalation reaches Kawai whatever the home's configuration says, and the
// prompt append as developerInstructions — the effort mapping for
// turn/start, and the context reading a token-usage update yields. The
// driver's observational side-reports live here too (spawn provenance,
// compaction facts, an async question's answer), so CodexSessionDriver stays
// the state machine.
import type { ChatApprovalPolicy, ChatContextUsage } from '../../../shared/chat'
import { logger } from '../../logger'
import type { OutboundAuditSink } from '../../outbound/observer'
import type { TeamToolSpec } from '../../team/mailboxTools'
import type { ChatDriverCallbacks, ChatEffort } from '../provider/driver'
import type { ChatWireRecorder } from '../wireTap'
import type { AppServerClient, AppServerClientOptions } from './appServerClient'
import { codexSandbox, gitCommonDir } from './codexSandbox'
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown'

/** The client surface the driver uses; injectable for tests. */
export type CodexClient = Pick<AppServerClient, 'start' | 'request' | 'initialize' | 'end'>

export interface CodexSessionDriverOptions extends ChatDriverCallbacks {
  sessionId: string
  projectPath: string
  /** The resolved Codex executable (codexExecutable.ts). */
  executable: string
  /** The resolved CODEX_HOME of the session's profile. */
  codexHome: string
  /** Sandbox network access (profile `network`, default on). */
  network: boolean
  /** The profile's model; omitted = the home's configuration decides. */
  model?: string
  /** The stored thread to resume on the first spawn (undefined = fresh). */
  resumeThreadId?: string
  /** Read at each request, so a live policy switch applies to the next one. */
  getApprovalPolicy?: () => ChatApprovalPolicy
  /** developerInstructions, read at every spawn (role, team, security note). */
  getSystemPromptAppend?: () => string | undefined
  /** turn/start effort, read at every turn. */
  getEffort?: () => ChatEffort | undefined
  /**
   * The kawai-team tools (D6), registered as one dynamic-tool namespace at
   * thread start and served on `item/tool/call` for this thread only.
   */
  teamTools?: readonly TeamToolSpec[]
  /** Observes commands and external MCP calls (design D13); observational. */
  outbound?: OutboundAuditSink
  wire: ChatWireRecorder
  createTurnId?: () => string
  /** The server environment the child's env derives from; default process.env. */
  serverEnv?: Record<string, string | undefined>
  /**
   * The catalog-named credential variables the child never inherits
   * (openrouter-provider D3, task 1.8); required, so no launch path can
   * forget it.
   */
  withheldCredentials: ReadonlySet<string>
  /** Builds the app-server client; default the real AppServerClient. */
  createClient?: (options: AppServerClientOptions) => CodexClient
  /** How long interrupt waits for the app-server's acknowledgement. */
  interruptTimeoutMs?: number
}

export const CLIENT_INFO = { name: 'kawai', title: 'Kawai', version: '1' }

/** The parameters thread/start and thread/resume share. */
export async function threadParams(input: { cwd: string; network: boolean; instructions: string; model?: string }): Promise<Record<string, unknown>> {
  return {
    cwd: input.cwd,
    approvalPolicy: 'on-request',
    // Every escalation reaches Kawai, whatever the home's config says (D5).
    approvalsReviewer: 'user',
    ...codexSandbox({ network: input.network, commonDir: await gitCommonDir(input.cwd) }),
    ...(input.instructions ? { developerInstructions: input.instructions } : {}),
    ...(input.model ? { model: input.model } : {}),
  }
}

/** Kawai's effort levels on Codex: `max` is `xhigh`, raw numbers are dropped. */
export function codexEffort(effort: ChatEffort | undefined): string | undefined {
  if (effort === undefined || typeof effort === 'number') return undefined
  return effort === 'max' ? 'xhigh' : effort
}

/**
 * The context reading of the latest request: its tokens over the model's
 * window — an approximation of the compaction threshold, marked so.
 */
export function codexContextUsage(last: TokenUsageBreakdown, window: number): ChatContextUsage {
  const used = last.inputTokens + last.outputTokens
  return {
    usedTokens: used,
    thresholdTokens: window,
    percentage: Math.round((used / window) * 1000) / 10,
    at: new Date().toISOString(),
    thresholdApproximate: true,
  }
}

/** Agent-start provenance (team-process-metrics D2): one observational report per constructed query; a throw never fails the spawn. */
export function reportSpawn(
  options: Pick<CodexSessionDriverOptions, 'sessionId' | 'model' | 'onSpawn'>,
  input: { cwd: string; instructions: string; effort: ChatEffort | undefined; env: Record<string, string>; resumed: boolean },
): void {
  try {
    options.onSpawn?.({
      cwd: input.cwd,
      systemPromptAppend: input.instructions,
      effort: input.effort ?? null,
      model: options.model ?? null,
      env: input.env,
      resumed: input.resumed,
    })
  } catch (error) {
    logger.warn('chat_spawn_hook_failed', { sessionId: options.sessionId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Compaction facts for process observability (observation/reconciliation); observational like the spawn report. */
export function reportCompaction(options: Pick<CodexSessionDriverOptions, 'onCompaction'>, itemId: string): void {
  try {
    options.onCompaction?.({
      trigger: 'auto', startedAt: null, endedAt: new Date().toISOString(), preTokens: null, postTokens: null,
      durationSeconds: null, outcome: 'completed',
    }, `boundary:${itemId}`)
  } catch {
    logger.warn('chat_compaction_observation_failed')
  }
}

/** An async question's answer: a text input on the same turn (item/tool/call D6); a dead process surfaces through onExit. */
export function answerAsyncQuestion(client: CodexClient | null, threadId: string | null, text: string): void {
  if (!client || !threadId) return
  client.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }).catch(() => {
    // The process is ending; nothing to answer.
  })
}

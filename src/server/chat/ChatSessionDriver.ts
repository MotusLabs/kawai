// One long-lived Claude Agent SDK query() per chat session, in streaming-input
// mode: user turns are pushed into a TurnQueue the query consumes, events are
// mapped to ChatEvents, approvals/questions ride a cancellable promise bridge
// over canUseTool, and status (working/permission/waiting) is derived from
// driver state — never from log parsing. All SDK types are confined to this
// module; the SDK itself is injected as a queryFactory (the manager does the
// dynamic import), mirroring the SpawnFn convention in server/terminal/.
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatEvent,
  ChatPendingRequest,
  ChatQuestion,
  ChatQuestionAnswer,
} from '../../shared/chat'
import type { SessionStatus } from '../../shared/types'
import {
  ASK_USER_QUESTION_TOOL,
  parseQuestions,
  toolResultText,
} from './contentBlocks'
import {
  activityBody,
  contentBlockToInput,
  initialChatActivityState,
  projectActivity,
  reduceActivity,
  systemFrameToInput,
  type ChatActivityInput,
  type ChatActivityState,
} from './chatActivity'
import type { ChatProviderEnv } from './chatProviderEnv'
import { decideApproval } from './approvalPolicy'
import { resolveClaudeProfile } from './ClaudeProfiles'
import { TurnQueue } from './TurnQueue'
import { createWireTappedSpawn, type ChatWireRecorder } from './wireTap'

/**
 * The SDK `query()` — injected so tests run against a fake. `wire` is the
 * session's protocol-frame recorder: the real SDK is tapped through
 * `options.spawnClaudeCodeProcess`, while a fake that never spawns a process
 * (the development fixture) records synthetic frames into it directly.
 */
export type ChatQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
  wire?: ChatWireRecorder
}) => Query

export interface ChatSessionDriverOptions {
  /** Agentboard session id (chat-<uuid>); used for logging context only. */
  sessionId: string
  projectPath: string
  queryFactory: ChatQueryFactory
  /** SDK session id to resume on the first turn (undefined = fresh). */
  resumeSessionId?: string
  /** Provider overrides, read at each spawn so Settings changes apply. */
  getProviderEnv?: () => ChatProviderEnv
  /**
   * Session approval policy, read at each canUseTool call so a live policy
   * switch applies to the next request without a respawn (design D2).
   * Omitted = manual (today's behavior).
   */
  getApprovalPolicy?: () => ChatApprovalPolicy
  /** Persisted session profile; omitted for legacy Default sessions. */
  claudeProfileId?: string
  /**
   * Externally installed Claude Code executable passed to the SDK as
   * pathToClaudeCodeExecutable. Omitted when a fake runtime is injected
   * (tests, development fixture), leaving SDK resolution unchanged.
   */
  claudeExecutablePath?: string
  onEvent: (event: ChatEvent) => void
  /** Applied immediately on every derived status change. */
  onStatus: (status: SessionStatus) => void
  /**
   * Live activity of the in-flight turn (design D3): called only when the
   * projected phase changes, with null when the turn ends. Ephemeral — never
   * sequenced, buffered, or replayed like events.
   */
  onActivity?: (activity: ChatActivity | null) => void
  /** Fired once when the SDK init message reveals the session id. */
  onSdkSessionId?: (sdkSessionId: string) => void
  /** Records the raw protocol of every spawned process (chat debug view). */
  wire?: ChatWireRecorder
}

interface PendingRequest {
  requestId: string
  kind: 'approval' | 'question'
  turnId: string
  tool: string
  /** Raw canUseTool input (AskUserQuestion validation reads questions). */
  input: Record<string, unknown>
  questions?: ChatQuestion[]
  at: string
  settled: boolean
  settle: (result: PermissionResult) => void
}

/** Omit that distributes over the ChatEvent union, keeping each member's type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never
type ChatEventDraft = DistributiveOmit<ChatEvent, 'id' | 'sequence' | 'at'>

export class ChatSessionDriver {
  private readonly options: ChatSessionDriverOptions
  private readonly queue = new TurnQueue()
  private query: Query | null = null
  private sequence = 0
  private turnCounter = 0
  private activeTurnId: string | null = null
  private streamingMessageId: string | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  /** Tool use ids this live stream has seen (call or result). */
  private readonly seenToolCallIds = new Set<string>()
  /** Echo suppression: texts we submitted that the SDK may echo back. */
  private readonly sentEchoTexts = new Map<string, number>()
  private capturedSdkSessionId: string | undefined
  private lastStatus: SessionStatus = 'waiting'
  /** Live-turn activity state (design D3); null phase when no turn runs. */
  private activityState: ChatActivityState = initialChatActivityState()
  private dead = false
  /** Updated by the manager before a respawn; see setClaudeExecutablePath. */
  private claudeExecutablePath: string | undefined
  private killed = false

  constructor(options: ChatSessionDriverOptions) {
    this.options = options
    this.claudeExecutablePath = options.claudeExecutablePath
  }

  get isDead(): boolean {
    return this.dead
  }

  /**
   * Executable for the next spawn. The manager re-verifies the executable
   * before respawning a dead driver; the CLI may have moved since the first
   * spawn, so the freshly verified path replaces the stored one.
   */
  setClaudeExecutablePath(path: string | undefined): void {
    this.claudeExecutablePath = path
  }

  /** Submit a user turn. Spawns the SDK lazily on the first turn. */
  send(text: string): void {
    if (this.killed) return
    // A crashed SDK process does not end the chat session: respawn with
    // resume on the next send. Sequence numbers keep counting so clients
    // never see a reused sequence after a respawn.
    this.dead = false
    if (!this.query) {
      this.spawnQuery()
    }
    if (!this.activeTurnId) {
      this.turnCounter += 1
      this.activeTurnId = `turn-${this.turnCounter}`
      this.emit({ type: 'turn_started', turnId: this.activeTurnId })
    }
    this.trackEcho(text)
    this.emit({ type: 'user_message', turnId: this.activeTurnId, text })
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
    this.refreshStatus()
  }

  /** Stop button: abort the in-flight turn, drop queued sends, cancel asks. */
  interrupt(): void {
    this.queue.clearPending()
    this.cancelAllRequests('interrupted')
    if (this.activeTurnId) {
      const turnId = this.activeTurnId
      this.activeTurnId = null
      this.emit({ type: 'turn_interrupted', turnId })
    }
    const query = this.query
    if (query) {
      void query.interrupt().catch(() => {
        // The process may already be gone; the stream loop handles death.
      })
    }
    this.refreshStatus()
  }

  /** Kill the session: abort, settle pending approvals with a denial, stop. */
  kill(): void {
    this.killed = true
    this.queue.end()
    this.cancelAllRequests('killed')
    this.activeTurnId = null
    const query = this.query
    this.query = null
    if (query) {
      try {
        void query.interrupt().catch(() => {})
        query.close()
      } catch {
        // Already gone.
      }
    }
  }

  /** Server shutdown: same settlement as kill (callbacks cannot survive it). */
  shutdown(): void {
    this.kill()
  }

  /**
   * A live policy switch (design D4): switching to auto grants approvals
   * already pending as cards; questions stay with the user. Switching to
   * manual affects only later requests, so it is a no-op here.
   */
  onApprovalPolicyChanged(policy: ChatApprovalPolicy): void {
    if (policy !== 'auto') return
    for (const pending of Array.from(this.pendingRequests.values())) {
      if (pending.kind !== 'approval' || pending.settled) continue
      this.pendingRequests.delete(pending.requestId)
      pending.settled = true
      pending.settle({ behavior: 'allow' })
      this.emit({
        type: 'request_resolved',
        requestId: pending.requestId,
        outcome: 'allowed',
        decidedBy: 'policy',
        tool: pending.tool,
      })
    }
    this.refreshStatus()
  }

  /** Answer an approval card. First valid answer wins; stale answers error. */
  resolveApproval(
    requestId: string,
    decision: ChatApprovalDecision
  ): { ok: true } | { ok: false; error: string } {    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.settled) {
      return {
        ok: false,
        error: `No pending approval with id ${requestId}; it may already be answered or cancelled`,
      }
    }
    if (pending.kind !== 'approval') {
      return { ok: false, error: `Request ${requestId} is not an approval` }
    }
    this.pendingRequests.delete(requestId)
    pending.settled = true
    if (decision === 'allow') {
      pending.settle({ behavior: 'allow' })
      this.emit({ type: 'request_resolved', requestId, outcome: 'allowed', decidedBy: 'user' })
    } else {
      pending.settle({
        behavior: 'deny',
        message: 'User denied this tool use in Agentboard',
      })
      this.emit({ type: 'request_resolved', requestId, outcome: 'denied', decidedBy: 'user' })
    }
    this.refreshStatus()
    return { ok: true }
  }

  /** Answer a question_request; validates against the offered questions. */
  answerQuestion(
    requestId: string,
    answers: Record<string, ChatQuestionAnswer>
  ): { ok: true } | { ok: false; error: string } {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.settled) {
      return {
        ok: false,
        error: `No pending question with id ${requestId}; it may already be answered or cancelled`,
      }
    }
    if (pending.kind !== 'question' || !pending.questions) {
      return { ok: false, error: `Request ${requestId} is not a question` }
    }
    const validated = validateAnswers(pending.questions, answers)
    if (!validated.ok) {
      return validated
    }
    this.pendingRequests.delete(requestId)
    pending.settled = true
    pending.settle({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        answers: validated.answers,
        ...(validated.response !== undefined
          ? { response: validated.response }
          : {}),
      },
    })
    this.emit({ type: 'request_resolved', requestId, outcome: 'answered', decidedBy: 'user' })
    this.refreshStatus()
    return { ok: true }
  }

  /** Snapshot of still-pending approvals/questions (for chat-snapshot). */
  getPendingRequests(): ChatPendingRequest[] {
    return Array.from(this.pendingRequests.values()).map((pending) =>
      pending.kind === 'approval'
        ? {
            kind: 'approval',
            requestId: pending.requestId,
            tool: pending.tool,
            input: pending.input,
            at: pending.at,
          }
        : {
            kind: 'question',
            requestId: pending.requestId,
            questions: pending.questions ?? [],
            at: pending.at,
          }
    )
  }

  /**
   * Tool use ids this live stream has produced events for. Transcript replay
   * uses it to avoid marking in-flight tools as dead requests.
   */
  getSeenToolCallIds(): Set<string> {
    return new Set(this.seenToolCallIds)
  }

  // ---------------------------------------------------------------- internals

  private spawnQuery(): void {
    const resume = this.capturedSdkSessionId ?? this.options.resumeSessionId
    const launch = resolveClaudeProfile(this.options.claudeProfileId, this.options.getProviderEnv?.() ?? {})
    const wire = this.options.wire
    const options: Options = {
      cwd: this.options.projectPath,
      // Option parity with a terminal `claude` session in the project dir.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      ...(this.claudeExecutablePath
        ? { pathToClaudeCodeExecutable: this.claudeExecutablePath }
        : {}),
      ...(resume ? { resume } : {}),
      ...launch,
      ...(wire ? { spawnClaudeCodeProcess: createWireTappedSpawn(wire) } : {}),
    }
    const query = this.options.queryFactory({
      prompt: this.queue,
      options,
      ...(wire ? { wire } : {}),
    })
    this.query = query
    void this.runQueryLoop(query)
  }

  private async runQueryLoop(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.killed) break
        this.handleSdkMessage(message)
      }
      if (!this.killed) {
        this.markDead('The agent process exited unexpectedly')
      }
    } catch (error) {
      if (!this.killed) {
        this.markDead(
          `The agent process failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  }

  /** Only a session crash marks the driver dead; per-turn errors do not. */
  private markDead(reason: string): void {
    this.dead = true
    this.query = null
    this.activeTurnId = null
    this.feedActivity({ type: 'turn_end' })
    this.cancelAllRequests('killed')
    this.emit({ type: 'error', message: reason })
    this.refreshStatus()
  }

  private handleSdkMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'assistant':
        this.handleAssistant(message)
        return
      case 'user':
        this.handleUser(message)
        return
      case 'result':
        this.handleResult(message)
        return
      case 'stream_event':
        this.handlePartial(message)
        return
      case 'system':
        this.handleSystem(message)
        return
      default:
        // Trailing informational frames (prompt suggestions, status, hooks,
        // ...) are tolerated and ignored — a result ends a turn, not the
        // stream, and unknown frames must never kill the session.
        return
    }
  }

  private handleAssistant(message: SDKAssistantMessage): void {
    const turnId = this.activeTurnId
    if (!turnId) return
    const messageId = message.message.id ?? message.uuid
    for (const block of message.message.content) {
      if (block.type === 'text') {
        this.emit({
          type: 'assistant_text',
          turnId,
          messageId,
          text: block.text,
        })
      } else if (block.type === 'tool_use') {
        this.seenToolCallIds.add(block.id)
        this.emit({
          type: 'tool_call',
          turnId,
          toolCallId: block.id,
          tool: block.name,
          input: block.input,
        })
        if (!isSubagentFrame(message)) {
          this.feedActivity({
            type: 'tool_call',
            toolCallId: block.id,
            tool: block.name,
          })
        }
      }
      // thinking and other block kinds are not surfaced in the transcript.
    }
  }

  private handlePartial(message: SDKPartialAssistantMessage): void {
    const turnId = this.activeTurnId
    if (!turnId) return
    const event = message.event
    if (event.type === 'message_start') this.streamingMessageId = event.message.id
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      this.emit({
        type: 'assistant_delta',
        turnId,
        messageId: this.streamingMessageId ?? message.uuid,
        delta: event.delta.text,
      })
    }
    if (event.type === 'content_block_start' && !isSubagentFrame(message)) {
      const input = contentBlockToInput(event.content_block)
      if (input) this.feedActivity(input)
    }
  }

  private handleUser(message: SDKUserMessage): void {
    const turnId = this.activeTurnId
    if (!turnId) return
    const content = message.message.content
    if (typeof content === 'string') {
      this.maybeEchoUserText(content, turnId)
      return
    }
    for (const block of content) {
      if (block.type === 'tool_result') {
        this.seenToolCallIds.add(block.tool_use_id)
        this.emit({
          type: 'tool_result',
          turnId,
          toolCallId: block.tool_use_id,
          output: toolResultText(block.content),
          isError: block.is_error,
        })
        if (!isSubagentFrame(message)) {
          this.feedActivity({ type: 'tool_result', toolCallId: block.tool_use_id })
        }
      } else if (block.type === 'text') {
        this.maybeEchoUserText(block.text, turnId)
      }
    }
  }

  /** The SDK echoes streamed user turns; suppress the copy we already sent. */
  private maybeEchoUserText(text: string, turnId: string): void {
    const outstanding = this.sentEchoTexts.get(text) ?? 0
    if (outstanding > 0) {
      this.sentEchoTexts.set(text, outstanding - 1)
      return
    }
    this.emit({ type: 'user_message', turnId, text })
  }

  private trackEcho(text: string): void {
    this.sentEchoTexts.set(text, (this.sentEchoTexts.get(text) ?? 0) + 1)
  }

  private handleResult(message: SDKResultMessage): void {
    const turnId = this.activeTurnId
    if (!turnId) {
      // Already reported via turn_interrupted (or no turn ran); a trailing
      // result for an ended turn must not resurrect one.
      return
    }
    this.activeTurnId = null
    this.emit({
      type: 'turn_completed',
      turnId,
      subtype: message.subtype,
      totalCostUsd: message.total_cost_usd,
      numTurns: message.num_turns,
      // Final text only on a success subtype.
      ...(message.subtype === 'success' ? { finalText: message.result } : {}),
    })
    if (message.subtype !== 'success') {
      // Per-turn error results keep the streaming session usable; surface the
      // failure in the transcript and return to waiting.
      const detail =
        'errors' in message && message.errors.length > 0
          ? message.errors.join('; ')
          : `The turn ended with ${message.subtype}`
      this.emit({ type: 'error', message: detail })
    }
    this.refreshStatus()
  }

  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'init') {
      if (!this.capturedSdkSessionId && message.session_id) {
        this.capturedSdkSessionId = message.session_id
        this.options.onSdkSessionId?.(message.session_id)
      }
      return
    }
    if (message.subtype === 'compact_boundary') {
      this.emit({ type: 'notice', text: 'Context compacted' })
    }
    if (isSubagentFrame(message)) return
    const input = systemFrameToInput(message)
    if (input) this.feedActivity(input)
    // Other system subtypes are informational; ignored.
  }

  private readonly canUseTool: CanUseTool = (toolName, input, toolOptions) => {
    const requestId = `req-${crypto.randomUUID()}`
    const turnId = this.activeTurnId ?? 'turn-0'
    const policy = this.options.getApprovalPolicy?.() ?? 'manual'
    if (decideApproval(policy, toolName) === 'allow') {
      // Auto policy (design D3): grant without a card. No pending request is
      // created, so the session never enters permission status for this use.
      this.emit({
        type: 'request_resolved',
        requestId,
        outcome: 'allowed',
        decidedBy: 'policy',
        tool: toolName,
      })
      return Promise.resolve({ behavior: 'allow' } as PermissionResult)
    }
    const answer = new Promise<PermissionResult>((resolve) => {
      const pending: PendingRequest = {
        requestId,
        kind: 'approval',
        turnId,
        tool: toolName,
        input,
        at: new Date().toISOString(),
        settled: false,
        settle: resolve,
      }
      if (toolName === ASK_USER_QUESTION_TOOL) {
        const questions = parseQuestions(input)
        if (questions) {
          pending.kind = 'question'
          pending.questions = questions
          this.pendingRequests.set(requestId, pending)
          this.emit({
            type: 'question_request',
            turnId,
            requestId,
            questions,
          })
          this.refreshStatus()
          return
        }
        // Unparseable AskUserQuestion input degrades to a plain approval card.
      }
      this.pendingRequests.set(requestId, pending)
      this.emit({
        type: 'approval_request',
        turnId,
        requestId,
        tool: toolName,
        input,
      })
      this.refreshStatus()
    })
    // Race the answer against SDK cancellation (interrupt/turn end/kill): a
    // cancelled ask settles as an interrupting denial so the tool never runs.
    const cancellation = new Promise<PermissionResult>((resolve) => {
      toolOptions.signal.addEventListener('abort', () => {
        this.cancelRequest(requestId, 'cancelled')
        resolve({
          behavior: 'deny',
          message: 'The request was cancelled',
          interrupt: true,
        })
      })
    })
    return Promise.race([answer, cancellation])
  }

  private cancelRequest(requestId: string, reason: string): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.settled) return
    this.pendingRequests.delete(requestId)
    pending.settled = true
    pending.settle({
      behavior: 'deny',
      message: `The request was cancelled (${reason})`,
      interrupt: true,
    })
    this.emit({ type: 'request_resolved', requestId, outcome: 'cancelled' })
    this.refreshStatus()
  }

  private cancelAllRequests(reason: string): void {
    for (const requestId of Array.from(this.pendingRequests.keys())) {
      this.cancelRequest(requestId, reason)
    }
  }

  private refreshStatus(): void {
    const next: SessionStatus =
      this.pendingRequests.size > 0
        ? 'permission'
        : this.activeTurnId
          ? 'working'
          : 'waiting'
    if (next !== this.lastStatus) {
      this.lastStatus = next
      this.options.onStatus(next)
    }
  }

  /**
   * One activity input (design D3). The state always advances; onActivity
   * fires only when the projected phase (not its elapsed time) changes.
   */
  private feedActivity(input: ChatActivityInput): void {
    const previous = activityBody(this.activityState)
    this.activityState = reduceActivity(this.activityState, input)
    const current = activityBody(this.activityState)
    if (
      this.options.onActivity &&
      JSON.stringify(previous) !== JSON.stringify(current)
    ) {
      this.options.onActivity(projectActivity(this.activityState))
    }
  }

  private emit(draft: ChatEventDraft): void {
    this.sequence += 1
    const event: ChatEvent = {
      ...draft,
      id: `evt-${crypto.randomUUID()}`,
      sequence: this.sequence,
      at: new Date().toISOString(),
    } as ChatEvent
    this.options.onEvent(event)
    // Turn lifecycle and request resolutions are top-level driver semantics
    // (never subagent frames), so they ride the emit points directly.
    if (draft.type === 'turn_started') {
      this.feedActivity({ type: 'turn_started' })
    } else if (
      draft.type === 'turn_completed' ||
      draft.type === 'turn_interrupted'
    ) {
      this.feedActivity({ type: 'turn_end' })
    } else if (draft.type === 'request_resolved') {
      this.feedActivity({ type: 'request_resolved' })
    }
  }
}

/**
 * Subagent frames (a Task tool's own requests, thinking, and tool traffic)
 * must not disturb the parent turn's activity row (design D3): without this,
 * a running Task would flicker between "Thinking" and "Running Task".
 */
function isSubagentFrame(frame: object): boolean {
  const parent = (frame as { parent_tool_use_id?: unknown }).parent_tool_use_id
  return parent != null
}

function validateAnswers(
  questions: ChatQuestion[],
  answers: Record<string, ChatQuestionAnswer>
):
  | { ok: true; answers: Record<string, string>; response?: string }
  | { ok: false; error: string } {
  const result: Record<string, string> = {}
  let response: string | undefined
  for (const question of questions) {
    const answer = answers[question.question]
    if (!answer || (!answer.options?.length && !answer.text?.trim())) {
      return { ok: false, error: `Missing answer for "${question.question}"` }
    }
    const labels = new Set(question.options.map((option) => option.label))
    if (answer.options?.length) {
      if (!question.multiSelect && answer.options.length > 1) {
        return {
          ok: false,
          error: `"${question.question}" accepts only one choice`,
        }
      }
      for (const label of answer.options) {
        if (!labels.has(label)) {
          return {
            ok: false,
            error: `"${label}" is not an offered choice for "${question.question}"`,
          }
        }
      }
      result[question.question] = answer.options.join(', ')
    } else if (answer.text?.trim()) {
      result[question.question] = answer.text.trim()
      response = answer.text.trim()
    }
  }
  return {
    ok: true,
    answers: result,
    ...(response !== undefined ? { response } : {}),
  }
}

// Approvals and questions over the SDK's canUseTool (design §5, moved from
// Kawai's ChatSessionDriver in task 4.1). Each request is registered first,
// with its abort listener, then its event is published, then onRequest runs in
// the same dispatch, so a caller may answer inline and the resolved event
// follows the request event. The first terminal action wins: a valid answer,
// an abort, interrupt, stop or process death; a later or invalid answer is
// refused with a reason. A request still pending after onRequest returns is
// denied at once unless the host chose `wait` (Kawai's UI and its own
// deadlines). A signal already aborted at entry, or a stopping session, is an
// interrupting denial with no request published. Cancellations are
// interrupting denials, so a cancelled tool never runs. The SDK input and the
// parsed questions are kept as private detached copies: every event, callback
// and list view gets its own copy, so a host or SDK-side mutation never changes
// what an allow executes or how an answer is validated. The SDK's own tool-use
// ID, when it is a nonempty string, is copied unchanged onto the request
// before it is registered, so every view and event carries it (never
// derived; requestId alone settles). Nothing here waits for
// a UI or arms a timer.
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerOptions, AnswerOutcome } from '../contract.js'
import type { EventBody } from '../eventStream.js'
import type { AgentQuestion, PendingRequest, QuestionAnswers } from '../events.js'
import type { JsonValue } from '../json.js'
import { questionResponse, unsupportedResponse } from '../common/answerResponse.js'
import { validateAnswers } from './answers.js'
import { ASK_USER_QUESTION_TOOL, parseQuestions } from './contentBlocks.js'

export interface RequestHost {
  emit(body: EventBody): void
  /** The turn a request belongs to; empty when none is active. */
  turnId(): string
  onRequest?(request: PendingRequest): void
  /** Run a host callback; a throw is retained and changes nothing here. */
  notify(name: string, callback: () => void): void
  unanswered: 'deny' | 'wait'
  /** The pending set changed (status). */
  changed?(): void
}

interface Entry {
  /** Private: never handed out; views are detached copies. */
  request: PendingRequest
  input: Record<string, unknown>
  settled: boolean
  settle(result: PermissionResult): void
  /** Removes the abort listener once the request is decided. */
  detach(): void
}

/** A deep copy of JSON data, so no view aliases the private facts. */
const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export class ClaudeRequests {
  private readonly pending = new Map<string, Entry>()
  private closed = false

  constructor(private readonly host: RequestHost) {}

  get size(): number {
    return this.pending.size
  }

  /** Requests registered and not yet settled, oldest first. */
  list(): PendingRequest[] {
    return [...this.pending.values()].map((entry) => detached(entry.request))
  }

  readonly canUseTool: CanUseTool = (tool, sdkInput, { signal, toolUseID }) => {
    if (this.closed) return Promise.resolve({ behavior: 'deny', message: 'The session is stopping', interrupt: true })
    if (signal.aborted) return Promise.resolve(cancelled('cancelled'))
    const requestId = `req-${crypto.randomUUID()}`
    const turnId = this.host.turnId()
    const at = new Date().toISOString()
    const input = detached(sdkInput)
    const questions = tool === ASK_USER_QUESTION_TOOL ? parseQuestions(input) : null
    // The runtime's own tool-call ID, exactly as given; anything but a nonempty string is omitted.
    const native = typeof toolUseID === 'string' && toolUseID.length > 0 ? { toolCallId: toolUseID } : {}
    const request: PendingRequest = questions
      ? { kind: 'question', requestId, turnId, questions: detached(questions as AgentQuestion[]), at, ...native }
      : { kind: 'approval', requestId, turnId, tool, input: detached(input) as JsonValue, at, ...native }
    // Registered with its abort listener before anything can reenter.
    const abort = () => this.cancel(requestId, 'cancelled')
    const answer = new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { request, input, settled: false, settle: resolve, detach: () => signal.removeEventListener('abort', abort) })
    })
    signal.addEventListener('abort', abort, { once: true })
    this.host.emit(
      request.kind === 'question'
        ? { type: 'question_request', turnId, requestId, questions: detached(request.questions), ...native }
        : { type: 'approval_request', turnId, requestId, tool, input: detached(request.input), ...native },
    )
    this.host.changed?.()
    const onRequest = this.host.onRequest
    if (onRequest) this.host.notify('onRequest', () => onRequest(detached(request)))
    if (!this.decided(requestId) && this.host.unanswered === 'deny') {
      this.settle(requestId, { behavior: 'deny', message: 'No answer was given; the request is denied' }, 'denied', 'policy')
    }
    return answer
  }

  resolveApproval(requestId: string, decision: 'allow' | 'deny', options: AnswerOptions = {}): AnswerOutcome {
    const entry = this.lookup(requestId)
    if (!('request' in entry)) return entry
    if (entry.request.kind !== 'approval') return { ok: false, reason: 'invalid', message: `Request ${requestId} is not an approval` }
    const unsupported = unsupportedResponse(options, 'an approval')
    if (unsupported) return unsupported
    if (decision === 'allow') this.settle(requestId, { behavior: 'allow', updatedInput: entry.input }, 'allowed', options.decidedBy ?? 'caller')
    else this.settle(requestId, { behavior: 'deny', message: 'The tool use was denied' }, 'denied', options.decidedBy ?? 'caller')
    return { ok: true }
  }

  answerQuestion(requestId: string, answers: QuestionAnswers, options: AnswerOptions = {}): AnswerOutcome {
    const entry = this.lookup(requestId)
    if (!('request' in entry)) return entry
    if (entry.request.kind !== 'question') return { ok: false, reason: 'invalid', message: `Request ${requestId} is not a question` }
    const validated = validateAnswers(entry.request.questions, answers)
    if (!validated.ok) return { ok: false, reason: 'invalid', message: validated.error }
    // R5: an explicit response only after the answers validated; it takes the derived one's place.
    const explicit = questionResponse(options)
    if ('ok' in explicit) return explicit
    const response = explicit.response ?? validated.response
    const updatedInput = { ...entry.input, answers: validated.answers, ...(response !== undefined ? { response } : {}) }
    this.settle(requestId, { behavior: 'allow', updatedInput }, 'answered', options.decidedBy ?? 'caller')
    return { ok: true }
  }

  /** Cancel every pending request as an interrupting denial. */
  cancelAll(reason: string): void {
    for (const requestId of Array.from(this.pending.keys())) this.cancel(requestId, reason)
  }

  /** Stop has begun: cancel everything and refuse later requests and answers. */
  close(): void {
    this.closed = true
    this.cancelAll('stopped')
  }

  private lookup(requestId: string): Entry | Extract<AnswerOutcome, { ok: false }> {
    if (this.closed) return { ok: false, reason: 'stopped', message: 'The session is stopped' }
    const entry = this.pending.get(requestId)
    if (!entry || entry.settled) return { ok: false, reason: 'not-pending', message: `No pending request with id ${requestId}; it may already be answered or cancelled` }
    return entry
  }

  private decided(requestId: string): boolean {
    return this.pending.get(requestId)?.settled !== false
  }

  private cancel(requestId: string, reason: string): void {
    this.settle(requestId, cancelled(reason), 'cancelled')
  }

  private settle(requestId: string, result: PermissionResult, outcome: 'allowed' | 'denied' | 'answered' | 'cancelled', decidedBy?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.settled) return
    entry.settled = true
    this.pending.delete(requestId)
    entry.detach()
    entry.settle(result)
    this.host.emit({
      type: 'request_resolved',
      requestId,
      outcome,
      ...(decidedBy ? { decidedBy } : {}),
      ...(entry.request.kind === 'approval' ? { tool: entry.request.tool } : {}),
    })
    this.host.changed?.()
  }
}

const cancelled = (reason: string): PermissionResult => ({ behavior: 'deny', message: `The request was cancelled (${reason})`, interrupt: true })

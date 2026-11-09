// Approvals and questions over the SDK's canUseTool (design §5, moved from
// Kawai's ChatSessionDriver in task 4.1). Each request is registered first,
// then its event is published, then onRequest runs in the same dispatch, so a
// caller may answer inline and the resolved event follows the request event.
// The first valid answer wins; a later or invalid answer is refused with a
// reason. A request still pending after onRequest returns is denied at once
// unless the host chose `wait` (Kawai's UI and its own deadlines). Interrupt,
// stop, the SDK's abort signal and process death cancel pending requests as
// interrupting denials, so a cancelled tool never runs. Nothing here waits
// for a UI or arms a timer.
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerOptions, AnswerOutcome } from '../contract.js'
import type { EventBody } from '../eventStream.js'
import type { AgentQuestion, PendingRequest, QuestionAnswers } from '../events.js'
import type { JsonValue } from '../json.js'
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
  request: PendingRequest
  input: Record<string, unknown>
  settled: boolean
  settle(result: PermissionResult): void
}

export class ClaudeRequests {
  private readonly pending = new Map<string, Entry>()
  private closed = false

  constructor(private readonly host: RequestHost) {}

  get size(): number {
    return this.pending.size
  }

  /** Requests registered and not yet settled, oldest first. */
  list(): PendingRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  readonly canUseTool: CanUseTool = (tool, input, { signal }) => {
    if (this.closed) return Promise.resolve({ behavior: 'deny', message: 'The session is stopping', interrupt: true })
    const requestId = `req-${crypto.randomUUID()}`
    const turnId = this.host.turnId()
    const at = new Date().toISOString()
    const questions = tool === ASK_USER_QUESTION_TOOL ? parseQuestions(input) : null
    const request: PendingRequest = questions
      ? { kind: 'question', requestId, turnId, questions: questions as AgentQuestion[], at }
      : { kind: 'approval', requestId, turnId, tool, input: input as JsonValue, at }
    const answer = new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { request, input, settled: false, settle: resolve })
    })
    this.host.emit(
      request.kind === 'question'
        ? { type: 'question_request', turnId, requestId, questions: request.questions }
        : { type: 'approval_request', turnId, requestId, tool, input: request.input },
    )
    this.host.changed?.()
    const onRequest = this.host.onRequest
    if (onRequest) this.host.notify('onRequest', () => onRequest(request))
    if (this.pending.get(requestId)?.settled === false && this.host.unanswered === 'deny') {
      this.settle(requestId, { behavior: 'deny', message: 'No answer was given; the request is denied' }, 'denied', 'policy')
    }
    if (signal.aborted) this.cancel(requestId, 'cancelled')
    else signal.addEventListener('abort', () => this.cancel(requestId, 'cancelled'), { once: true })
    return answer
  }

  resolveApproval(requestId: string, decision: 'allow' | 'deny', options: AnswerOptions = {}): AnswerOutcome {
    const entry = this.lookup(requestId)
    if (!('request' in entry)) return entry
    if (entry.request.kind !== 'approval') return { ok: false, reason: 'invalid', message: `Request ${requestId} is not an approval` }
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
    const updatedInput = { ...entry.input, answers: validated.answers, ...(validated.response !== undefined ? { response: validated.response } : {}) }
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

  private cancel(requestId: string, reason: string): void {
    this.settle(requestId, { behavior: 'deny', message: `The request was cancelled (${reason})`, interrupt: true }, 'cancelled')
  }

  private settle(requestId: string, result: PermissionResult, outcome: 'allowed' | 'denied' | 'answered' | 'cancelled', decidedBy?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.settled) return
    entry.settled = true
    this.pending.delete(requestId)
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

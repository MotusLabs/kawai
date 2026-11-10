// Codex approvals and questions (design §5, task 4.3; from Kawai's committed
// codexRequests.ts). One server request the session's policy routes to the
// host becomes one pending request:
//
// - Ordering. The request's private facts are registered first, with the
//   transport's abort listener, then its event is published, then onRequest
//   runs in the same dispatch, so an inline answer settles it and its resolved
//   event follows the request event.
// - First terminal action wins: a valid answer, the signal's abort, an
//   interrupt, stop or process end. A later, duplicate or invalid answer is
//   refused with a reason and changes nothing.
// - A request still pending after onRequest returns is denied at once unless
//   the host chose `wait` (Q04); nothing here waits for a UI or arms a timer.
// - The protocol input and parsed questions are private detached copies, so a
//   host mutation never changes what is answered or how answers validate.
// - Cancellation answers Codex `cancel` (or the method's equivalent).
import type { AnswerOptions, AnswerOutcome } from '../contract.js'
import type { EventBody } from '../eventStream.js'
import type { AgentQuestion, PendingRequest, QuestionAnswers, RequestOutcome } from '../events.js'
import type { JsonValue } from '../json.js'

export interface CodexRequestHost {
  emit(body: EventBody): void
  /** The runtime turn a request belongs to; empty when none. */
  turnId(params: Record<string, unknown>): string
  onRequest?(request: PendingRequest): void
  notify(name: string, callback: () => void): void
  unanswered: 'deny' | 'wait'
}

type Settlement = 'allow' | 'deny' | 'cancel'

interface Entry {
  request: PendingRequest
  settled: boolean
  /** Questions: Codex question ids, parallel to request.questions. */
  questionIds: string[]
  reply(settlement: Settlement, answers?: string[][]): unknown
  settle(result: unknown): void
  detach(): void
}

const APPROVAL_TOOLS: Record<string, string> = {
  'item/commandExecution/requestApproval': 'Bash',
  execCommandApproval: 'Bash',
  'item/fileChange/requestApproval': 'Edit',
  applyPatchApproval: 'Edit',
  'item/permissions/requestApproval': 'Permissions',
  'mcpServer/elicitation/request': 'Elicitation',
}
const USER_INPUT = 'item/tool/requestUserInput'
const ELICITATION = 'mcpServer/elicitation/request'
/** Elicitation modes an allow/deny answer represents exactly (no structured content). */
const CONTENT_FREE_MODES = new Set(['url', 'openai/userVerification'])

/**
 * A form-mode elicitation needs structured content matching its
 * requestedSchema, which the public answers (allow/deny, question answers)
 * cannot carry: it is declined at once with this reason, never accepted
 * with invented content.
 */
export function formElicitation(method: string, params: Record<string, unknown>): string | null {
  if (method !== ELICITATION || CONTENT_FREE_MODES.has(String(params.mode))) return null
  return `elicitation mode ${JSON.stringify(params.mode ?? null)} needs structured content the public answers cannot express; it was declined`
}

const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T

/** The JSON-RPC result of one settled approval-kind request. */
function approvalReply(method: string, params: Record<string, unknown>, settlement: Settlement): unknown {
  if (method === 'item/permissions/requestApproval') {
    const requested = (params.permissions ?? {}) as Record<string, unknown>
    const granted: Record<string, unknown> = {}
    if (settlement === 'allow') for (const key of ['network', 'fileSystem']) if (requested[key] != null) granted[key] = requested[key]
    return { permissions: granted, scope: 'turn' }
  }
  if (method === ELICITATION) {
    // Only content-free modes reach the host (formElicitation): accept carries no content.
    return { action: settlement === 'allow' ? 'accept' : settlement === 'deny' ? 'decline' : 'cancel', content: null, _meta: null }
  }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return settlement === 'allow' ? { decision: 'approved' } : settlement === 'deny' ? { decision: { denied: { rejection: 'denied by the host' } } } : { decision: 'abort' }
  }
  return { decision: settlement === 'allow' ? 'accept' : settlement === 'deny' ? 'decline' : 'cancel' }
}

function parseQuestions(params: Record<string, unknown>): { ids: string[]; questions: AgentQuestion[] } {
  const raw = Array.isArray(params.questions) ? (params.questions as Array<Record<string, unknown>>) : []
  return {
    ids: raw.map((q) => String(q?.id ?? '')),
    questions: raw.map((q) => ({
      question: String(q?.question ?? ''),
      header: String(q?.header ?? ''),
      multiSelect: false,
      options: Array.isArray(q?.options)
        ? (q.options as Array<{ label?: unknown; description?: unknown }>).map((o) => ({ label: String(o?.label ?? ''), ...(typeof o?.description === 'string' && o.description ? { description: o.description } : {}) }))
        : [],
      ...(typeof q?.isOther === 'boolean' ? { isOther: q.isOther } : {}),
      ...(q?.isSecret === true ? { isSecret: true } : {}),
    })),
  }
}

/** Per question, in order: the chosen label or the typed answer. */
function validate(questions: AgentQuestion[], answers: QuestionAnswers): { ok: true; answers: string[][] } | { ok: false; error: string } {
  const result: string[][] = []
  for (const question of questions) {
    const answer = answers?.[question.question]
    const text = typeof answer?.text === 'string' ? answer.text.trim() : ''
    const options = Array.isArray(answer?.options) ? answer.options : []
    if (!answer || (options.length === 0 && !text)) return { ok: false, error: `Missing answer for "${question.question}"` }
    if (options.length > 1) return { ok: false, error: `"${question.question}" accepts only one choice` }
    if (options.length > 0 && text) return { ok: false, error: `"${question.question}" takes one answer: choose an option or type your own, not both` }
    if (text && question.isOther === false) return { ok: false, error: `"${question.question}" accepts only an offered choice` }
    const labels = new Set(question.options.map((o) => o.label))
    for (const label of options) if (!labels.has(label)) return { ok: false, error: `"${label}" is not an offered choice for "${question.question}"` }
    result.push(options.length > 0 ? [...options] : [text])
  }
  return { ok: true, answers: result }
}

/** The cancelling answer to a request the session will not route (retired generation, foreign thread). */
export function cancelReply(method: string, params: Record<string, unknown>): unknown {
  return method === USER_INPUT ? { answers: {} } : approvalReply(method, params, 'cancel')
}

export class CodexRequests {
  private readonly pending = new Map<string, Entry>()
  private closed = false

  constructor(private readonly host: CodexRequestHost) {}

  list(): PendingRequest[] {
    return [...this.pending.values()].map((entry) => detached(entry.request))
  }

  /** Serve one host-routed server request; resolves with the JSON-RPC result. */
  serve(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const question = method === USER_INPUT
    const tool = APPROVAL_TOOLS[method] ?? 'unknown'
    if (this.closed || signal.aborted) return Promise.resolve(cancelReply(method, params))
    const requestId = `req-${crypto.randomUUID()}`
    const turnId = this.host.turnId(params)
    const at = new Date().toISOString()
    const parsed = question ? parseQuestions(params) : null
    const request: PendingRequest = parsed
      ? { kind: 'question', requestId, turnId, questions: detached(parsed.questions), at }
      : { kind: 'approval', requestId, turnId, tool, input: detached(params) as JsonValue, at }
    const abort = () => this.settle(requestId, 'cancel', 'cancelled')
    const reply = (settlement: Settlement, answers?: string[][]) => {
      if (!parsed) return approvalReply(method, params, settlement)
      const keyed: Record<string, { answers: string[] }> = {}
      if (answers) parsed.ids.forEach((id, i) => (keyed[id] = { answers: answers[i]! }))
      return { answers: keyed }
    }
    const answer = new Promise<unknown>((resolve) => {
      this.pending.set(requestId, { request, settled: false, questionIds: parsed?.ids ?? [], reply, settle: resolve, detach: () => signal.removeEventListener('abort', abort) })
    })
    signal.addEventListener('abort', abort, { once: true })
    this.host.emit(
      request.kind === 'question'
        ? { type: 'question_request', turnId, requestId, questions: detached(request.questions) }
        : { type: 'approval_request', turnId, requestId, tool, input: detached(request.input) },
    )
    const onRequest = this.host.onRequest
    if (onRequest) this.host.notify('onRequest', () => onRequest(detached(request)))
    if (this.pending.get(requestId)?.settled === false && this.host.unanswered === 'deny') this.settle(requestId, 'deny', 'denied', 'policy')
    return answer
  }

  resolveApproval(requestId: string, decision: 'allow' | 'deny', options: AnswerOptions = {}): AnswerOutcome {
    const entry = this.lookup(requestId)
    if (!('request' in entry)) return entry
    if (entry.request.kind !== 'approval') return { ok: false, reason: 'invalid', message: `Request ${requestId} is not an approval` }
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, reason: 'invalid', message: 'decision must be allow or deny' }
    this.settle(requestId, decision, decision === 'allow' ? 'allowed' : 'denied', options.decidedBy ?? 'caller')
    return { ok: true }
  }

  answerQuestion(requestId: string, answers: QuestionAnswers, options: AnswerOptions = {}): AnswerOutcome {
    const entry = this.lookup(requestId)
    if (!('request' in entry)) return entry
    if (entry.request.kind !== 'question') return { ok: false, reason: 'invalid', message: `Request ${requestId} is not a question` }
    const validated = validate(entry.request.questions, answers)
    if (!validated.ok) return { ok: false, reason: 'invalid', message: validated.error }
    this.settle(requestId, 'allow', 'answered', options.decidedBy ?? 'caller', validated.answers)
    return { ok: true }
  }

  /** Cancel every pending request (interrupt, process end). */
  cancelAll(): void {
    for (const requestId of Array.from(this.pending.keys())) this.settle(requestId, 'cancel', 'cancelled')
  }

  /** Stop has begun: cancel everything and refuse later requests and answers. */
  close(): void {
    this.closed = true
    this.cancelAll()
  }

  private lookup(requestId: string): Entry | Extract<AnswerOutcome, { ok: false }> {
    if (this.closed) return { ok: false, reason: 'stopped', message: 'The session is stopped' }
    const entry = this.pending.get(requestId)
    if (!entry || entry.settled) return { ok: false, reason: 'not-pending', message: `No pending request with id ${requestId}; it may already be answered or cancelled` }
    return entry
  }

  private settle(requestId: string, settlement: Settlement, outcome: RequestOutcome, decidedBy?: string, answers?: string[][]): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.settled) return
    entry.settled = true
    this.pending.delete(requestId)
    entry.detach()
    entry.settle(entry.reply(settlement, answers))
    this.host.emit({
      type: 'request_resolved',
      requestId,
      outcome,
      ...(decidedBy ? { decidedBy } : {}),
      ...(entry.request.kind === 'approval' ? { tool: entry.request.tool } : {}),
    })
  }
}

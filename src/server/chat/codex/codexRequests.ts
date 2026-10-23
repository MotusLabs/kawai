// Codex approvals and questions (codex-chat-sessions design D5): every
// escalation reaches Kawai (`approvalsReviewer: "user"`), and the session's
// approval policy — read when each request arrives, so a live toggle applies
// without touching the thread — decides who answers. Under manual a command,
// file-change, or permissions request shows an approval card (allow →
// `accept`, deny → `decline`); under auto Kawai accepts at once and records a
// policy grant. Questions — the blocking `item/tool/requestUserInput` request
// and 0.163.0's async agentMessage questions — always show a card and are
// never answered automatically; blocking answers return keyed by question id.
// One card covers one request: `acceptForSession` is never sent.
import type {
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatPendingRequest,
  ChatQuestion,
  ChatQuestionAnswer,
} from '../../../shared/chat'
import type { CodexEventDraft } from './codexEvents'

/** The approval server requests and the Kawai tool name each card shows. */
const APPROVAL_TOOLS: Record<string, string> = {
  'item/commandExecution/requestApproval': 'Bash',
  'item/fileChange/requestApproval': 'Edit',
  'item/permissions/requestApproval': 'Permissions',
}
export const USER_INPUT_REQUEST = 'item/tool/requestUserInput'

type Settlement = 'allow' | 'deny' | 'cancel'

interface Pending {
  requestId: string
  kind: 'approval' | 'question'
  turnId: string
  tool: string
  input: unknown
  questions?: ChatQuestion[]
  /** Codex question ids, parallel to `questions` (blocking requests only). */
  questionIds?: string[]
  at: string
  /** Approvals: the reply for a decision. */
  approve?: (settlement: Settlement) => void
  /** Questions: deliver the validated answers (per question, in order), or cancel. */
  answer?: (answers: string[][] | null) => void
}

export interface CodexRequestsDeps {
  emit(draft: CodexEventDraft): void
  refreshStatus(): void
  policy(): ChatApprovalPolicy
  /** The Kawai turn a request arriving now belongs to. */
  turnId(): string
  /** The started item an approval names, for the card's input (file paths). */
  itemInput(itemId: string): Record<string, unknown> | undefined
  /** A declined or cancelled approval, for the outbound audit (D13). */
  denied(use: { tool: string; itemId: string; input: unknown; reason?: string }): void
}

let counter = 0
const newRequestId = () => `req-codex-${Date.now().toString(36)}-${(counter++).toString(36)}`

export class CodexRequests {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: CodexRequestsDeps) {}

  get size(): number {
    return this.pending.size
  }

  /** Whether `method` is a request this module answers. */
  handles(method: string): boolean {
    return method in APPROVAL_TOOLS || method === USER_INPUT_REQUEST
  }

  /** Answer one approval or blocking-question server request. */
  serverRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === USER_INPUT_REQUEST) return this.userInput(params)
    const tool = APPROVAL_TOOLS[method]!
    const itemId = typeof params.itemId === 'string' ? params.itemId : ''
    const input = approvalInput(method, params, this.deps.itemInput(itemId))
    const reply = (settlement: Settlement) => approvalReply(method, params, settlement)
    if (this.deps.policy() === 'auto') {
      this.deps.emit({ type: 'request_resolved', requestId: newRequestId(), outcome: 'allowed', decidedBy: 'policy', tool })
      return Promise.resolve(reply('allow'))
    }
    return new Promise((resolve) => {
      const requestId = newRequestId()
      const turnId = this.deps.turnId()
      this.pending.set(requestId, {
        requestId, kind: 'approval', turnId, tool, input, at: new Date().toISOString(),
        approve: (settlement) => {
          if (settlement !== 'allow') this.deps.denied({ tool, itemId, input, ...(settlement === 'cancel' ? { reason: 'interrupted' } : {}) })
          resolve(reply(settlement))
        },
      })
      this.deps.emit({ type: 'approval_request', turnId, requestId, tool, input })
      this.deps.refreshStatus()
    })
  }

  /** An async question (an agentMessage with `questions`): answered as turn input. */
  asyncQuestion(questions: ChatQuestion[], deliver: (text: string) => void): void {
    const requestId = newRequestId()
    const turnId = this.deps.turnId()
    this.pending.set(requestId, {
      requestId, kind: 'question', turnId, tool: 'AskUserQuestion', input: { questions }, questions,
      at: new Date().toISOString(),
      answer: (answers) => {
        if (!answers) return
        deliver(questions.map((question, i) => `${question.question}: ${answers[i]!.join(', ')}`).join('\n'))
      },
    })
    this.deps.emit({ type: 'question_request', turnId, requestId, questions })
    this.deps.refreshStatus()
  }

  resolveApproval(requestId: string, decision: ChatApprovalDecision): { ok: true } | { ok: false; error: string } {
    const pending = this.pending.get(requestId)
    if (!pending) return { ok: false, error: `No pending approval with id ${requestId}; it may already be answered or cancelled` }
    if (pending.kind !== 'approval') return { ok: false, error: `Request ${requestId} is not an approval` }
    this.pending.delete(requestId)
    pending.approve!(decision === 'allow' ? 'allow' : 'deny')
    this.deps.emit({ type: 'request_resolved', requestId, outcome: decision === 'allow' ? 'allowed' : 'denied', decidedBy: 'user' })
    this.deps.refreshStatus()
    return { ok: true }
  }

  answerQuestion(requestId: string, answers: Record<string, ChatQuestionAnswer>): { ok: true } | { ok: false; error: string } {
    const pending = this.pending.get(requestId)
    if (!pending) return { ok: false, error: `No pending question with id ${requestId}; it may already be answered or cancelled` }
    if (pending.kind !== 'question' || !pending.questions) return { ok: false, error: `Request ${requestId} is not a question` }
    const validated = validateAnswers(pending.questions, answers)
    if (!validated.ok) return validated
    this.pending.delete(requestId)
    pending.answer!(validated.answers)
    this.deps.emit({ type: 'request_resolved', requestId, outcome: 'answered', decidedBy: 'user' })
    this.deps.refreshStatus()
    return { ok: true }
  }

  /** A live switch to auto grants pending approval cards; questions stay. */
  policyChanged(policy: ChatApprovalPolicy): void {
    if (policy !== 'auto') return
    for (const pending of Array.from(this.pending.values())) {
      if (pending.kind !== 'approval') continue
      this.pending.delete(pending.requestId)
      pending.approve!('allow')
      this.deps.emit({ type: 'request_resolved', requestId: pending.requestId, outcome: 'allowed', decidedBy: 'policy', tool: pending.tool })
    }
    this.deps.refreshStatus()
  }

  /** Interrupt, kill, or process end: every card is cancelled (Codex hears `cancel`). */
  cancelAll(): void {
    for (const pending of Array.from(this.pending.values())) {
      this.pending.delete(pending.requestId)
      if (pending.approve) pending.approve('cancel')
      else pending.answer?.(null)
      this.deps.emit({ type: 'request_resolved', requestId: pending.requestId, outcome: 'cancelled' })
    }
    this.deps.refreshStatus()
  }

  snapshot(): ChatPendingRequest[] {
    return Array.from(this.pending.values()).map(pending => pending.kind === 'approval'
      ? { kind: 'approval', requestId: pending.requestId, tool: pending.tool, input: pending.input, at: pending.at }
      : { kind: 'question', requestId: pending.requestId, questions: pending.questions ?? [], at: pending.at })
  }

  private userInput(params: Record<string, unknown>): Promise<unknown> {
    const raw = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : []
    const questionIds = raw.map(question => String(question.id ?? ''))
    const questions: ChatQuestion[] = raw.map(question => ({
      question: String(question.question ?? ''),
      header: String(question.header ?? ''),
      multiSelect: false,
      options: Array.isArray(question.options)
        ? (question.options as Array<{ label?: unknown; description?: unknown }>).map(option => ({
            label: String(option.label ?? ''),
            ...(typeof option.description === 'string' && option.description ? { description: option.description } : {}),
          }))
        : [],
      // F3 (codex-chat-sessions): carry the answer-shape flags into the card —
      // free text only where Codex allows another answer, masked where secret.
      // Absent fields read as today, so a sender omitting them cannot make a
      // card unanswerable.
      ...(typeof question.isOther === 'boolean' ? { isOther: question.isOther } : {}),
      ...(question.isSecret === true ? { isSecret: true } : {}),
    }))
    return new Promise((resolve) => {
      const requestId = newRequestId()
      const turnId = this.deps.turnId()
      this.pending.set(requestId, {
        requestId, kind: 'question', turnId, tool: 'AskUserQuestion', input: { questions }, questions, questionIds,
        at: new Date().toISOString(),
        answer: (answers) => {
          const keyed: Record<string, { answers: string[] }> = {}
          if (answers) questionIds.forEach((id, i) => { keyed[id] = { answers: answers[i]! } })
          resolve({ answers: keyed })
        },
      })
      this.deps.emit({ type: 'question_request', turnId, requestId, questions })
      this.deps.refreshStatus()
    })
  }
}

/** The card's input: what the request names, plus the started item's paths. */
function approvalInput(method: string, params: Record<string, unknown>, item: Record<string, unknown> | undefined): Record<string, unknown> {
  const reason = typeof params.reason === 'string' && params.reason ? { reason: params.reason } : {}
  if (method === 'item/commandExecution/requestApproval') {
    return { command: params.command ?? item?.command ?? '', ...(params.cwd ? { cwd: params.cwd } : {}), ...reason }
  }
  if (method === 'item/fileChange/requestApproval') {
    return { file_path: item?.file_path ?? '', paths: item?.paths ?? [], ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}), ...reason }
  }
  return { permissions: params.permissions ?? {}, ...(params.cwd ? { cwd: params.cwd } : {}), ...reason }
}

/** The JSON-RPC result for one settled approval. */
function approvalReply(method: string, params: Record<string, unknown>, settlement: Settlement): unknown {
  if (method === 'item/permissions/requestApproval') {
    // Allow grants the requested profile for this turn; anything else grants nothing.
    const requested = (params.permissions ?? {}) as Record<string, unknown>
    const granted: Record<string, unknown> = {}
    if (settlement === 'allow') for (const key of ['network', 'fileSystem']) if (requested[key] != null) granted[key] = requested[key]
    return { permissions: granted, scope: 'turn' }
  }
  return { decision: settlement === 'allow' ? 'accept' : settlement === 'deny' ? 'decline' : 'cancel' }
}

/** Per question, in order: the chosen labels plus any typed answer. */
function validateAnswers(
  questions: ChatQuestion[],
  answers: Record<string, ChatQuestionAnswer>,
): { ok: true; answers: string[][] } | { ok: false; error: string } {
  const result: string[][] = []
  for (const question of questions) {
    const answer = answers[question.question]
    const text = answer?.text?.trim()
    const options = answer?.options ?? []
    if (!answer || (options.length === 0 && !text)) return { ok: false, error: `Missing answer for "${question.question}"` }
    if (options.length > 1) return { ok: false, error: `"${question.question}" accepts only one choice` }
    const labels = new Set(question.options.map(option => option.label))
    for (const label of options) {
      if (!labels.has(label)) return { ok: false, error: `"${label}" is not an offered choice for "${question.question}"` }
    }
    result.push([...options, ...(text ? [text] : [])])
  }
  return { ok: true, answers: result }
}

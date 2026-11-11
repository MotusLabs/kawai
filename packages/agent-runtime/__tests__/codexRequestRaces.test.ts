// I5 for Codex over fixed-seed permutations (design §5: 0xA605, 256 cases;
// task 4.3 Codex portion). Each case drives the production CodexRequests
// bridge, the one the Codex session routes every host request through, with
// a controlled abort signal per request (the transport's handler signal) and
// the session's interrupt (cancelAll) and stop (close) steps. Each step is
// taken from the request event, from onRequest or after the call, and the
// ordered request/resolved trace, every answer outcome, the onRequest count
// and the JSON-RPC reply Codex receives must match oracles/requestModel.ts,
// with the model's settlement mapped to the protocol reply. Real stdio
// composition of the same bridge is codexRequests.test.ts.
import { describe, expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { CodexRequests } from '../src/codex/requests.js'
import { EventStream } from '../src/eventStream.js'
import type { AgentEvent, PendingRequest, QuestionAnswers } from '../src/events.js'
import type { AnswerOutcome } from '../src/contract.js'
import { COMMAND, QUESTION, expectRequests, generateCase, type Action, type Expected, type RequestCase, type Where } from './oracles/requestModel.js'

const SEED = 0xa605
const RED: QuestionAnswers = { 'Which colour?': { options: ['Red'] } }
const GREEN: QuestionAnswers = { 'Which colour?': { options: ['Green'] } }
const METHOD = { question: 'item/tool/requestUserInput', approval: 'item/commandExecution/requestApproval' } as const
/** The model's question as the protocol sends it (question ids). */
const CODEX_QUESTION = { questions: QUESTION.questions.map((q, i) => ({ id: `q${i}`, question: q.question, header: q.header, options: q.options })) }

/** The JSON-RPC result Codex must receive for the model's settlement. */
function reply(kind: 'question' | 'approval', result: PermissionResult): unknown {
  if (result.behavior === 'allow') return kind === 'question' ? { answers: { q0: { answers: ['Red'] } } } : { decision: 'accept' }
  if (kind === 'question') return { answers: {} }
  return { decision: result.interrupt ? 'cancel' : 'decline' }
}

type View = AgentEvent | PendingRequest | undefined

function mutate(view: View): void {
  if (!view) return
  if ('input' in view && view.input && typeof view.input === 'object') Object.assign(view.input, { command: 'rm', nested: { path: '/etc' } })
  if ('questions' in view) for (const q of view.questions) Object.assign(q, { multiSelect: true, options: [{ label: 'Green' }] })
}

interface Observed extends Omit<Expected, 'results'> {
  replies: unknown[]
}

async function observe(c: RequestCase): Promise<Observed> {
  const ids: (string | undefined)[] = []
  const trace: string[] = []
  const outcomes: string[] = []
  const controllers = c.requests.map(() => new AbortController())
  let current = 0
  let onRequestCalls = 0
  let closed = false
  let requests!: CodexRequests
  const said = (o: AnswerOutcome) => (o.ok ? 'ok' : o.reason)
  const answer = (i: number, id: string, how: 'valid' | 'invalid' | 'wrong-kind' | 'deny') => {
    const question = c.requests[i]!.kind === 'question'
    if (how === 'deny') return said(requests.resolveApproval(id, 'deny'))
    if (how === 'invalid') return said(requests.answerQuestion(id, GREEN))
    if ((how === 'valid') === question) return said(requests.answerQuestion(id, RED))
    return said(requests.resolveApproval(id, 'allow'))
  }
  const execute = (i: number, action: Action, view: View): string => {
    const id = ids[i]!
    switch (action) {
      case 'valid':
      case 'deny':
      case 'invalid':
      case 'wrong-kind': return answer(i, id, action)
      case 'unknown': return answer(i, 'req-unknown', 'valid')
      case 'other': return answer(0, ids[0] ?? 'req-unknown', 'valid')
      case 'abort':
        controllers[i]!.abort()
        return '-'
      case 'interrupt':
        if (closed) return 'refused'
        requests.cancelAll()
        return 'ok'
      case 'kill':
        closed = true
        requests.close()
        return '-'
      case 'mutate':
        mutate(view)
        return '-'
    }
  }
  const perform = (where: Where, view: View) => {
    for (const step of c.requests[current]!.steps) if (step.where === where) outcomes.push(execute(current, step.action, view))
  }
  const events = new EventStream((e) => {
    if (e.type === 'question_request' || e.type === 'approval_request') {
      ids[current] = e.requestId
      trace.push(`request:${current}`)
      perform('event', e)
    } else if (e.type === 'request_resolved') {
      trace.push(`resolved:${ids.indexOf(e.requestId)}:${e.outcome}:${e.decidedBy ?? '-'}`)
    }
  })
  requests = new CodexRequests({
    emit: (body) => events.emit(body),
    turnId: () => 'turn',
    onRequest: (request) => {
      onRequestCalls += 1
      perform('callback', request)
    },
    notify: (_name, callback) => callback(),
    unanswered: c.mode,
  })
  const replies: Promise<unknown>[] = []
  c.requests.forEach((spec, i) => {
    current = i
    if (spec.preAborted) controllers[i]!.abort()
    const params = structuredClone(spec.kind === 'question' ? CODEX_QUESTION : COMMAND) as Record<string, unknown>
    replies.push(requests.serve(METHOD[spec.kind], params, controllers[i]!.signal))
    if (ids[i] !== undefined) perform('after', requests.list().find((r) => r.requestId === ids[i]))
  })
  closed = true
  requests.close()
  return { trace, outcomes, onRequestCalls, replies: await Promise.all(replies) }
}

function check(from: number, to: number) {
  return async () => {
    for (let n = from; n < to; n++) {
      const c = generateCase(SEED + n * 7919)
      const expected = expectRequests(c)
      const observed = await observe(c)
      const label = `case ${n}: ${JSON.stringify(c)}`
      const { results, ...rest } = expected
      expect({ label, ...observed }).toEqual({ label, ...rest, replies: results.map((r, i) => reply(c.requests[i]!.kind, r)) })
    }
  }
}

describe('Codex requests: I5 over fixed-seed permutations', () => {
  test('I5: every Codex request settles once and replies as the model derives from action order (cases 0-127)', check(0, 128))
  test('I5: every Codex request settles once and replies as the model derives from action order (cases 128-255)', check(128, 256))
})

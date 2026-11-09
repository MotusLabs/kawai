// The I5 reference model (design §5 table, task 4.3 Claude portion): what a
// case of requests and responses must produce, derived only from the original
// request facts and the order of the input actions, never from the driver.
// Rules: a stopping session publishes nothing and refuses at entry; a signal
// aborted at entry is an interrupting denial with nothing published. A
// published request is pending until its first terminal action: a valid
// answer, an abort of its own signal, an interrupt or stop (which cancel every
// pending request, oldest first), or the default denial after the callback in
// `deny` mode. Answers to a stopped session report `stopped`; to an unknown or
// settled request `not-pending`; an invalid or wrong-kind answer to a pending
// request `invalid` and settles nothing. A mutation of a public view changes
// nothing. Every case ends with a stop.
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

export const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
export const COMMAND = { command: 'ls', nested: { path: '/tmp/safe', args: ['-l'] } }

export type Where = 'event' | 'callback' | 'after'
/** `other` is a valid answer addressed to the case's first request. */
export type Action = 'valid' | 'deny' | 'invalid' | 'wrong-kind' | 'unknown' | 'other' | 'abort' | 'interrupt' | 'kill' | 'mutate'
export interface Step { where: Where; action: Action }
export interface RequestSpec { kind: 'question' | 'approval'; preAborted: boolean; steps: Step[] }
export interface RequestCase { mode: 'deny' | 'wait'; requests: RequestSpec[] }

export interface Expected {
  /** `request:<i>` and `resolved:<i>:<outcome>:<decidedBy|->` in emission order. */
  trace: string[]
  /** One per executed step: ok, invalid, not-pending, stopped, refused (interrupt), or - (no outcome). */
  outcomes: string[]
  results: PermissionResult[]
  onRequestCalls: number
}

interface Settlement { outcome: 'answered' | 'allowed' | 'denied' | 'cancelled'; decidedBy: string; result: PermissionResult }

const cancelled = (reason: string): Settlement => ({ outcome: 'cancelled', decidedBy: '-', result: { behavior: 'deny', message: `The request was cancelled (${reason})`, interrupt: true } })
const ANSWERED: Settlement = { outcome: 'answered', decidedBy: 'caller', result: { behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' } } } }
const ALLOWED: Settlement = { outcome: 'allowed', decidedBy: 'caller', result: { behavior: 'allow', updatedInput: COMMAND } }
const DENIED: Settlement = { outcome: 'denied', decidedBy: 'caller', result: { behavior: 'deny', message: 'The tool use was denied' } }
const POLICY: Settlement = { outcome: 'denied', decidedBy: 'policy', result: { behavior: 'deny', message: 'No answer was given; the request is denied' } }
const STOPPING: PermissionResult = { behavior: 'deny', message: 'The session is stopping', interrupt: true }

export function expectRequests(c: RequestCase): Expected {
  let closed = false
  const state: ('unpublished' | 'pending' | Settlement)[] = c.requests.map(() => 'unpublished')
  const results: PermissionResult[] = []
  const trace: string[] = []
  const outcomes: string[] = []
  let onRequestCalls = 0

  const settle = (i: number, s: Settlement) => {
    if (state[i] !== 'pending') return
    state[i] = s
    trace.push(`resolved:${i}:${s.outcome}:${s.decidedBy}`)
  }
  const cancelAll = (reason: string) => state.forEach((_, i) => settle(i, cancelled(reason)))
  const respond = (target: number | null, validity: 'valid' | 'invalid', s: Settlement): string => {
    if (closed) return 'stopped'
    if (target === null || state[target] !== 'pending') return 'not-pending'
    if (validity === 'invalid') return 'invalid'
    settle(target, s)
    return 'ok'
  }
  const validFor = (i: number) => (c.requests[i]!.kind === 'question' ? ANSWERED : ALLOWED)

  const apply = (i: number, action: Action): string => {
    switch (action) {
      case 'valid': return respond(i, 'valid', validFor(i))
      case 'deny': return respond(i, 'valid', DENIED)
      case 'invalid':
      case 'wrong-kind': return respond(i, 'invalid', validFor(i))
      case 'unknown': return respond(null, 'valid', validFor(i))
      case 'other': return state[0] === 'unpublished' ? respond(null, 'valid', validFor(0)) : respond(0, 'valid', validFor(0))
      case 'abort':
        settle(i, cancelled('cancelled'))
        return '-'
      case 'interrupt':
        if (closed) return 'refused'
        cancelAll('interrupted')
        return 'ok'
      case 'kill':
        if (!closed) {
          closed = true
          cancelAll('stopped')
        }
        return '-'
      case 'mutate': return '-'
    }
  }
  const run = (i: number, where: Where) => {
    for (const step of c.requests[i]!.steps) if (step.where === where) outcomes.push(apply(i, step.action))
  }

  c.requests.forEach((spec, i) => {
    if (closed) return void (results[i] = STOPPING)
    if (spec.preAborted) return void (results[i] = cancelled('cancelled').result)
    state[i] = 'pending'
    trace.push(`request:${i}`)
    run(i, 'event')
    onRequestCalls += 1
    run(i, 'callback')
    if (c.mode === 'deny') settle(i, POLICY)
    run(i, 'after')
  })
  closed = true
  cancelAll('stopped')
  state.forEach((s, i) => {
    if (typeof s === 'object') results[i] = s.result
  })
  return { trace, outcomes, results, onRequestCalls }
}

const ACTIONS: Record<RequestSpec['kind'], Action[]> = {
  question: ['valid', 'invalid', 'wrong-kind', 'unknown', 'other', 'abort', 'interrupt', 'kill', 'mutate'],
  approval: ['valid', 'deny', 'wrong-kind', 'unknown', 'other', 'abort', 'interrupt', 'kill', 'mutate'],
}
const WHERE: Where[] = ['event', 'callback', 'after']

/** A fixed-seed case: two requests, each with up to four steps. */
export function generateCase(seed: number): RequestCase {
  let state = seed >>> 0
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) >>> 0
    return (state >>> 16) % n
  }
  const mode = next(2) === 0 ? 'deny' : 'wait'
  const requests = [0, 1].map((): RequestSpec => {
    const kind = next(2) === 0 ? 'question' : 'approval'
    const preAborted = next(16) === 0
    const steps = Array.from({ length: next(5) }, () => ({ where: WHERE[next(3)]!, action: ACTIONS[kind][next(9)]! }))
    return { kind, preAborted, steps }
  })
  return { mode, requests }
}

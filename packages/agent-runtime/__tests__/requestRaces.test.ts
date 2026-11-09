// I5 over fixed-seed permutations (design §5: 0xA605, 256 cases, task 4.3
// Claude portion). Each case runs on the production ClaudeSession over a
// controlled query: it calls the canUseTool the session passed in its SDK
// options, takes each step from the request event, from onRequest or after
// the call, and compares the SDK results, the ordered request/resolved
// events, every response outcome and the onRequest count with the reference
// model in oracles/requestModel.ts. Finite permutations, not every schedule.
import { describe, expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, PendingRequest, QuestionAnswers } from '../src/events.js'
import type { AnswerOutcome } from '../src/contract.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'
import { COMMAND, QUESTION, expectRequests, generateCase, type Action, type Expected, type RequestCase, type Where } from './oracles/requestModel.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const SEED = 0xa605
const RED: QuestionAnswers = { 'Which colour?': { options: ['Red'] } }
const GREEN: QuestionAnswers = { 'Which colour?': { options: ['Green'] } }

async function idle(hooks: DriverHooks): Promise<Driver> {
  const f = driver(hooks)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

type View = AgentEvent | PendingRequest | undefined

/** Changes every nested fact a view exposes; the model says nothing changes. */
function mutate(view: View): void {
  if (!view) return
  if ('input' in view && view.input && typeof view.input === 'object') Object.assign(view.input, { command: 'rm', nested: { path: '/etc', args: ['-rf'] } })
  if ('questions' in view) for (const q of view.questions) Object.assign(q, { multiSelect: true, options: [{ label: 'Green' }] })
}

interface Observed extends Expected {
  stops: string[]
}

async function observe(c: RequestCase): Promise<Observed> {
  const ids: (string | undefined)[] = []
  const trace: string[] = []
  const outcomes: (string | Promise<string>)[] = []
  const stops: Promise<string>[] = []
  const controllers = c.requests.map(() => new AbortController())
  let current = 0
  let onRequestCalls = 0
  const said = (o: AnswerOutcome) => (o.ok ? 'ok' : o.reason)
  const kindOf = (i: number) => c.requests[i]!.kind
  const answer = (f: Driver, i: number, id: string, how: 'valid' | 'invalid' | 'wrong-kind' | 'deny') => {
    const question = kindOf(i) === 'question'
    if (how === 'deny') return said(f.d.resolveApproval(id, 'deny'))
    if (how === 'invalid') return said(f.d.answerQuestion(id, GREEN))
    if ((how === 'valid') === question) return said(f.d.answerQuestion(id, RED))
    return said(f.d.resolveApproval(id, 'allow'))
  }
  const execute = (f: Driver, i: number, action: Action, view: View): string | Promise<string> => {
    const id = ids[i]!
    switch (action) {
      case 'valid':
      case 'deny':
      case 'invalid':
      case 'wrong-kind': return answer(f, i, id, action)
      case 'unknown': return answer(f, i, 'req-unknown', 'valid')
      case 'other': return answer(f, 0, ids[0] ?? 'req-unknown', 'valid')
      case 'abort':
        controllers[i]!.abort()
        return '-'
      case 'interrupt': return f.d.interrupt().then(() => 'ok', () => 'refused')
      case 'kill':
        stops.push(f.d.kill().then(() => 'settled', (e: unknown) => `rejected: ${String(e)}`))
        return '-'
      case 'mutate':
        mutate(view)
        return '-'
    }
  }
  const perform = (f: Driver, where: Where, view: View) => {
    for (const step of c.requests[current]!.steps) if (step.where === where) outcomes.push(execute(f, current, step.action, view))
  }
  const f: Driver = await idle({
    unansweredRequests: c.mode,
    onEvent: (e) => {
      if (e.type === 'question_request' || e.type === 'approval_request') {
        ids[current] = e.requestId
        trace.push(`request:${current}`)
        perform(f, 'event', e)
      } else if (e.type === 'request_resolved') {
        trace.push(`resolved:${ids.indexOf(e.requestId)}:${e.outcome}:${e.decidedBy ?? '-'}`)
      }
    },
    onRequest: (request) => {
      onRequestCalls += 1
      perform(f, 'callback', request)
    },
  })
  const results: Promise<PermissionResult | null>[] = []
  c.requests.forEach((spec, i) => {
    current = i
    if (spec.preAborted) controllers[i]!.abort()
    const canUseTool = f.q().options.canUseTool!
    results.push(canUseTool(spec.kind === 'question' ? 'AskUserQuestion' : 'Bash', structuredClone(spec.kind === 'question' ? QUESTION : COMMAND), { signal: controllers[i]!.signal, suggestions: [], toolUseID: `toolu_${i}` } as never))
    if (ids[i] !== undefined) perform(f, 'after', f.d.pendingRequests().find((r) => r.requestId === ids[i]))
  })
  stops.push(f.d.kill().then(() => 'settled', (e: unknown) => `rejected: ${String(e)}`))
  return {
    trace,
    outcomes: await Promise.all(outcomes),
    results: (await Promise.all(results)) as PermissionResult[],
    onRequestCalls,
    stops: await Promise.all(stops),
  }
}

async function check(from: number, to: number): Promise<void> {
  for (let n = from; n < to; n++) {
    const c = generateCase(SEED + n * 7919)
    const expected = expectRequests(c)
    const observed = await observe(c)
    const label = `case ${n}: ${JSON.stringify(c)}`
    expect({ label, ...observed }).toEqual({ label, ...expected, stops: observed.stops.map(() => 'settled') })
  }
}

describe('Claude requests: I5 over fixed-seed permutations', () => {
  test('I5: every request settles once as the model derives from action order (cases 0-63)', async () => {
    await check(0, 64)
  })
  test('I5: every request settles once as the model derives from action order (cases 64-127)', async () => {
    await check(64, 128)
  })
  test('I5: every request settles once as the model derives from action order (cases 128-191)', async () => {
    await check(128, 192)
  })
  test('I5: every request settles once as the model derives from action order (cases 192-255)', async () => {
    await check(192, 256)
  })

  test('I5: the 256 generated cases reach every action, place and mode', () => {
    const seen = new Set<string>()
    for (let n = 0; n < 256; n++) {
      const c = generateCase(SEED + n * 7919)
      seen.add(`mode:${c.mode}`)
      for (const r of c.requests) {
        seen.add(`kind:${r.kind}`)
        if (r.preAborted) seen.add('pre-aborted')
        for (const s of r.steps) seen.add(`${s.where}:${s.action}`)
      }
    }
    const actions: Action[] = ['valid', 'deny', 'invalid', 'wrong-kind', 'unknown', 'other', 'abort', 'interrupt', 'kill', 'mutate']
    const wanted = ['mode:deny', 'mode:wait', 'kind:question', 'kind:approval', 'pre-aborted', ...(['event', 'callback', 'after'] as Where[]).flatMap((w) => actions.map((a) => `${w}:${a}`))]
    expect(wanted.filter((w) => !seen.has(w))).toEqual([])
  })
})

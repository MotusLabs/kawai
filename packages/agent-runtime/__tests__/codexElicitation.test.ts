// Codex form elicitations through the unchanged public question callback
// (task 4.3 Codex portion, A3): all three form aliases (`form`,
// `openai/form`, `openaiForm`) reach onRequest as one question whose typed
// text is one JSON object; the private captured schema validates it and the
// app-server receives the native structured content. Decline and Cancel are
// the question's options; an invalid answer is refused and stays pending; a
// duplicate is refused; headless denial, wait, interrupt and disabled
// elicitation keep their rules; nested object schemas validate at every level
// (F4); impossible calendar values are invalid answers, never thrown errors
// (F3); an unsupported schema shape is declined and reported once with its
// exact shape. The decode tables check the codec against the schema directly.
import { afterEach, describe, expect, test } from 'bun:test'
import type { AnswerOutcome, CodexAgentDriver } from '../src/contract.js'
import type { AgentEvent, PendingRequest } from '../src/events.js'
import { compileForm } from '../src/codex/elicitationForm.js'
import { codexDriver, PERMISSIONS, stopDrivers, waitFor, type HarnessOptions } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const SCHEMA = {
  type: 'object',
  properties: {
    count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 },
    remember: { type: 'boolean' },
    email: { type: 'string', format: 'email' },
    size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 2 },
  },
  required: ['count', 'remember'],
}
const form = (mode: string, requestedSchema: unknown = SCHEMA) => ({ mode, serverName: 'srv', message: 'Configure it', requestedSchema, _meta: null })
const ask = (params: unknown) => `/ask mcpServer/elicitation/request ${JSON.stringify(params)}`
const parsed = (text: string | null): unknown => {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

type Answer = (driver: CodexAgentDriver, request: PendingRequest) => void

async function run(texts: string[], options: HarnessOptions = {}, answer?: Answer) {
  let driver: CodexAgentDriver | null = null
  const h = codexDriver(answer ? { ...options, callbacks: { ...options.callbacks, onRequest: (request) => answer(driver!, request) } } : options)
  driver = h.driver
  await h.driver.start()
  const replies: unknown[] = []
  for (const text of texts) replies.push(parsed((await (await h.driver.send(text)).result).finalText))
  return { h, replies }
}

const question = (request: PendingRequest) => (request.kind === 'question' ? request.questions[0]!.question : '')
const errors = (events: AgentEvent[]) => events.filter((e) => e.type === 'error')

describe('Codex form elicitations through the question callback', () => {
  for (const mode of ['form', 'openai/form', 'openaiForm']) {
    // @covers: agent-runtime › Requests can be answered immediately › Inline response
    test(`${mode}: a typed JSON answer validated against the captured schema replies accept with that content`, async () => {
      const outcomes: AnswerOutcome[] = []
      let seen: PendingRequest | null = null
      const content = { count: 2, remember: true, size: 'l', tags: ['a'] }
      const { h, replies } = await run([ask(form(mode))], {}, (driver, request) => {
        seen = request
        // The host's copy is mutated before answering: the captured schema still decides.
        if (request.kind === 'question') request.questions[0]!.question = 'tampered'
        outcomes.push(driver.answerQuestion(request.requestId, { [`Configure it\n\nAnswer with one JSON object matching this schema: ${JSON.stringify(SCHEMA)}`]: { text: JSON.stringify(content) } }))
        outcomes.push(driver.answerQuestion(request.requestId, { tampered: { options: ['Decline'] } }))
      })
      expect(seen).toMatchObject({ kind: 'question', questions: [{ header: 'srv', multiSelect: false, isOther: true, options: [{ label: 'Decline' }, { label: 'Cancel' }] }] })
      expect(outcomes).toEqual([{ ok: true }, expect.objectContaining({ ok: false, reason: 'not-pending' })])
      expect(replies).toEqual([{ action: 'accept', content, _meta: null }])
      expect(h.events.filter((e) => e.type === 'request_resolved')).toEqual([expect.objectContaining({ outcome: 'answered', decidedBy: 'caller' })])
      expect(errors(h.events)).toEqual([])
    })
  }

  test('an invalid answer is refused and the request stays pending; a valid one then settles it', async () => {
    const outcomes: AnswerOutcome[] = []
    const { replies } = await run([ask(form('form'))], {}, (driver, request) => {
      const key = question(request)
      for (const text of ['not json', '[1]', '{"count":2}', '{"count":9,"remember":true}', '{"count":2.5,"remember":true}', '{"count":2,"remember":"yes"}', '{"count":2,"remember":true,"extra":1}', '{"count":2,"remember":true,"email":"nope"}', '{"count":2,"remember":true,"size":"m"}', '{"count":2,"remember":true,"tags":["a","b","a"]}']) {
        outcomes.push(driver.answerQuestion(request.requestId, { [key]: { text } }))
      }
      outcomes.push(driver.resolveApproval(request.requestId, 'allow'))
      outcomes.push(driver.answerQuestion(request.requestId, { [key]: { text: '{"count":1,"remember":false,"email":"a@b.c"}' } }))
    })
    expect(outcomes.slice(0, -1).map((o) => (o.ok ? 'ok' : o.reason))).toEqual(Array(11).fill('invalid'))
    expect(outcomes.at(-1)).toEqual({ ok: true })
    expect(replies).toEqual([{ action: 'accept', content: { count: 1, remember: false, email: 'a@b.c' }, _meta: null }])
  })

  test('Decline and Cancel options reply decline and cancel', async () => {
    const choices = ['Decline', 'Cancel']
    const { h, replies } = await run([ask(form('form')), ask(form('openaiForm'))], {}, (driver, request) => void driver.answerQuestion(request.requestId, { [question(request)]: { options: [choices.shift()!] } }))
    expect(replies).toEqual([{ action: 'decline', content: null, _meta: null }, { action: 'cancel', content: null, _meta: null }])
    expect(h.events.filter((e) => e.type === 'request_resolved').map((e) => e.type === 'request_resolved' && e.outcome)).toEqual(['denied', 'cancelled'])
  })

  test('an unanswered form is declined by default; with wait it stays pending until an interrupt cancels it', async () => {
    const denied = await run([ask(form('openai/form'))])
    expect(denied.replies).toEqual([{ action: 'decline', content: null, _meta: null }])
    expect(denied.h.events.find((e) => e.type === 'request_resolved')).toMatchObject({ outcome: 'denied', decidedBy: 'policy' })
    const h = codexDriver({ unansweredRequests: 'wait' })
    await h.driver.start()
    const handle = await h.driver.send(ask(form('form')))
    await waitFor(() => h.driver.pendingRequests().length > 0)
    await h.driver.interrupt()
    expect(h.events.find((e) => e.type === 'request_resolved')).toMatchObject({ outcome: 'cancelled' })
    expect((await handle.result).outcome).not.toBe('success')
  })

  test('disabled elicitation declines a form at once with no request published', async () => {
    let requested = 0
    const { h, replies } = await run([ask(form('form'))], { permissions: { ...PERMISSIONS, elicitation: 'disabled' }, callbacks: { onRequest: () => void requested++ } })
    expect(replies).toEqual([{ action: 'decline', content: null, _meta: null }])
    expect(requested).toBe(0)
    expect(h.types().filter((t) => t.endsWith('_request'))).toEqual([])
  })

  test('Contract: an unsupported schema shape is declined, never narrowed, and its exact shape is reported once', async () => {
    let requested = 0
    const negated = { type: 'object', properties: { v: { not: { type: 'string' } } } }
    const { h, replies } = await run([ask(form('openai/form', negated)), ask(form('openai/form', negated))], { callbacks: { onRequest: () => void requested++ } })
    expect(replies).toEqual([{ action: 'decline', content: null, _meta: null }, { action: 'decline', content: null, _meta: null }])
    expect(requested).toBe(0)
    expect(errors(h.events)).toEqual([
      expect.objectContaining({ error: { category: 'unsupported', message: 'elicitation mode "openai/form": requestedSchema.properties.v has an unsupported type: {"not":{"type":"string"}}; it was declined' } }),
    ])
  })

  const NESTED = { type: 'object', properties: { address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }, required: ['address'] }
  for (const mode of ['form', 'openai/form', 'openaiForm']) {
    // @covers: agent-runtime › Requests can be answered immediately › Inline response
    test(`F4 ${mode}: a valid nested requestedSchema reaches onRequest, refuses a missing nested field and accepts the nested content`, async () => {
      const outcomes: string[] = []
      const { h, replies } = await run([ask(form(mode, NESTED))], {}, (driver, request) => {
        const key = question(request)
        for (const text of ['{"address":{}}', '{"address":{"city":3}}', '{"address":"Yerevan"}', '{"address":{"city":"Yerevan","zip":1}}', '{"address":{"city":"Yerevan"}}']) {
          const outcome = driver.answerQuestion(request.requestId, { [key]: { text } })
          outcomes.push(outcome.ok ? 'ok' : outcome.reason)
        }
      })
      expect(outcomes).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'ok'])
      expect(replies).toEqual([{ action: 'accept', content: { address: { city: 'Yerevan' } }, _meta: null }])
      expect(errors(h.events)).toEqual([])
    })
  }

  for (const [format, bad, good] of [['date', '2024-99-01', '2024-01-01'], ['date', '2026-02-30', '2026-02-28'], ['date-time', '2026-02-30T12:00:00Z', '2026-02-28T12:00:00Z'], ['date-time', '2026-01-01T25:00:00Z', '2026-01-01T23:59:59+04:00']] as const) {
    test(`F3: a ${format} answer ${bad} is refused invalid without throwing, stays pending, and ${good} then settles it`, async () => {
      let thrown: unknown = null
      const outcomes: string[] = []
      const schema = { type: 'object', properties: { d: { type: 'string', format } }, required: ['d'] }
      const { replies } = await run([ask(form('form', schema))], {}, (driver, request) => {
        const key = question(request)
        try {
          for (const value of [bad, good]) {
            const outcome = driver.answerQuestion(request.requestId, { [key]: { text: JSON.stringify({ d: value }) } })
            outcomes.push(outcome.ok ? 'ok' : outcome.reason)
          }
        } catch (error) {
          thrown = error
        }
      })
      expect(thrown).toBeNull()
      expect(outcomes).toEqual(['invalid', 'ok'])
      expect(replies).toEqual([{ action: 'accept', content: { d: good }, _meta: null }])
    })
  }

  test('F3: a prototype-named format is an unsupported shape, never a thrown predicate', async () => {
    let requested = 0
    const schema = { type: 'object', properties: { d: { type: 'string', format: '__proto__' } }, required: ['d'] }
    const { h, replies } = await run([ask(form('form', schema))], { callbacks: { onRequest: () => void requested++ } })
    expect(replies).toEqual([{ action: 'decline', content: null, _meta: null }])
    expect(requested).toBe(0)
    expect(errors(h.events)).toEqual([expect.objectContaining({ error: expect.objectContaining({ category: 'unsupported' }) })])
  })
})

describe('form codec against the captured schema', () => {
  const compiled = compileForm(form('form'))
  if (!compiled.ok) throw new Error(compiled.shape)
  const rows: Array<[string, boolean]> = [
    ['{"count":1,"remember":true}', true],
    ['{"count":5,"remember":false,"tags":[]}', true],
    ['{"count":3,"remember":true,"email":"x@y"}', true],
    ['{"count":0,"remember":true}', false],
    ['{"count":6,"remember":true}', false],
    ['{"count":"2","remember":true}', false],
    ['{"remember":true}', false],
    ['{"count":2}', false],
    ['{"count":2,"remember":true,"size":"Small"}', false],
    ['{"count":2,"remember":true,"tags":["c"]}', false],
    ['{"count":2,"remember":true,"toString":1}', false],
    ['null', false],
    ['{"count":2,"remember":true,"__proto__":{"x":1}}', false],
  ]
  for (const [text, ok] of rows) {
    test(`decode ${text} -> ${ok ? 'accepted' : 'refused'}`, () => {
      expect(compiled.form.decode(text).ok).toBe(ok)
    })
  }

  const calendar = compileForm(form('form', { type: 'object', properties: { day: { type: 'string', format: 'date' }, at: { type: 'string', format: 'date-time' } } }))
  if (!calendar.ok) throw new Error(calendar.shape)
  const dates: Array<[Record<string, string>, boolean]> = [
    [{ day: '2024-02-29' }, true], [{ day: '2000-02-29' }, true], [{ day: '2023-02-29' }, false], [{ day: '1900-02-29' }, false],
    [{ day: '2026-04-31' }, false], [{ day: '2026-00-10' }, false], [{ day: '2026-1-01' }, false],
    [{ at: '2026-12-31T23:59:60Z' }, true], [{ at: '2027-01-01T03:59:60+04:00' }, true], [{ at: '2026-12-31T12:00:60Z' }, false],
    [{ at: '2026-01-01T00:00:00.5-23:59' }, true], [{ at: '2026-01-01T00:00:00+24:00' }, false], [{ at: '2026-01-01T00:60:00Z' }, false], [{ at: '2026-01-01 00:00:00Z' }, false],
  ]
  for (const [answer, ok] of dates) {
    test(`F3 calendar ${JSON.stringify(answer)} -> ${ok ? 'accepted' : 'refused'}`, () => {
      expect(calendar.form.decode(JSON.stringify(answer)).ok).toBe(ok)
    })
  }

  const shapes: Array<[unknown, string]> = [
    [{ type: 'object', properties: { s: { type: 'string', pattern: 'x' } } }, 'requestedSchema.properties.s has unsupported keyword "pattern"'],
    [{ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string', pattern: 'x' } } } } }, 'requestedSchema.properties.a.properties.b has unsupported keyword "pattern"'],
    [{ type: 'object', properties: {}, additionalProperties: {} }, 'requestedSchema has an invalid "additionalProperties"'],
    [{ type: 'object', properties: { d: { type: 'string', format: 'toString' } } }, 'requestedSchema.properties.d has an invalid "format"'],
    [{ type: 'array' }, 'requestedSchema is not of type "object"'],
    [{ type: 'object', properties: { n: { type: 'number', minimum: 'a' } } }, 'requestedSchema.properties.n has an invalid "minimum"'],
    [{ type: 'object', properties: {}, required: ['missing'] }, 'requestedSchema has an invalid "required"'],
    [{ type: 'object', properties: { d: { type: 'string', format: 'hostname' } } }, 'requestedSchema.properties.d has an invalid "format"'],
  ]
  for (const [schema, shape] of shapes) {
    test(`unsupported shape: ${shape}`, () => {
      const result = compileForm(form('openaiForm', schema))
      expect(result.ok).toBe(false)
      expect(!result.ok && result.shape).toStartWith(`elicitation mode "openaiForm": ${shape}: `)
    })
  }
})

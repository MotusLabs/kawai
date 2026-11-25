// redactPull (process-quota-history-and-incident-advice I2/P4; Sol re-checks
// note-d5b9f0e9 and note-90848d06; Lead decision-1e654933): (a) every string
// of a returned pull is Kawai's fixed vocabulary or holds no case-insensitive
// occurrence of a nonempty target credential, of any length; (b) window keys
// stay unique after the rewrite; (c) what the read path logs carries no
// credential either. Unit cases over redactPull, then the real manager
// composition with a five-character mixed-case credential.
import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ChatUsageWindow } from '../../shared/chat'
import type { QuotaPull } from '../chat/quota/QuotaReaderService'
import { OPAQUE_LABEL, REDACTED, redactPull } from '../chat/quota/redactSecrets'
import { logger } from '../logger'
import { advance, CADENCE_MS, historyRows, jsonResponse, quotaCapture, quotaComposition, sessionIn, type QuotaComposition } from './helpers/quotaComposition'

const TOKEN = ['Zq', 'Fake', 'Redact', '91AA'].join('-')
const BALANCE = ['bal', 'fake', 'key', '77'].join('-')
const target = { providerId: 'zai', baseUrl: 'https://zai.test/api/anthropic', token: TOKEN, balanceKey: BALANCE }
const RECEIVED = '2026-11-25T00:00:00.000Z'

const FIXED = new Set([REDACTED, OPAQUE_LABEL, 'allowed', 'warning', 'limited', 'provider', 'unreachable', 'refused', 'failed', 'ok'])
const isFixed = (text: string) => FIXED.has(text) || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) ||
  /^(zai:|openrouter:)?unknown#\d+$/.test(text) || ['zai:time_limit', 'zai:tokens_limit', 'Tool calls', 'Tokens'].includes(text)

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** Condition (a): each string is fixed vocabulary or carries none of the secrets. */
function violations(pull: QuotaPull, secrets: string[]): string[] {
  return strings(pull).filter(text => !isFixed(text) && secrets.some(secret => text.toLowerCase().includes(secret.toLowerCase())))
}

function zaiPull(windows: ChatUsageWindow[]): QuotaPull {
  return { ok: true, report: { status: 'allowed', source: 'provider', receivedAt: RECEIVED, windows } }
}

const win = (key: string, label: string, percentUsed = 1): ChatUsageWindow => ({ key, label, percentUsed, resetsAt: null })

test('redactPull makes a window carrying the credential in any case opaque, keeps approved kinds and credential-free unknown kinds raw', () => {
  const pull = zaiPull([
    win('zai:time_limit', 'Tool calls', 40),
    win(`zai:${TOKEN.toLowerCase()}_x`, `${TOKEN}_x`),
    win('zai:mystery', 'MYSTERY'),
    win(`zai:${BALANCE}`, 'b'),
  ])
  const out = redactPull(pull, target)
  expect(out).toEqual(zaiPull([
    win('zai:time_limit', 'Tool calls', 40),
    win('zai:unknown#1', OPAQUE_LABEL),
    win('zai:mystery', 'MYSTERY'),
    win('zai:unknown#2', OPAQUE_LABEL),
  ]))
  expect(violations(out, [TOKEN, BALANCE])).toEqual([])
})

test('a one-character credential leaves approved keys and labels intact and makes every other carrying string opaque or redacted', () => {
  const one = { ...target, token: 'o', balanceKey: undefined }
  const pull = zaiPull([win('zai:time_limit', 'Tool calls', 40), win('zai:tokens_limit', '5-hour tokens', 7), win('zai:other', 'Other'), win('zai:zz', 'ZZ')])
  const out = redactPull(pull, one)
  expect(out.ok && out.report.windows.map(window => [window.key, window.label])).toEqual([
    ['zai:time_limit', 'Tool calls'], ['zai:tokens_limit', 'Tokens'], ['zai:unknown#1', OPAQUE_LABEL], ['zai:zz', 'ZZ'],
  ])
  expect(violations(out, ['o'])).toEqual([])
})

test('opaque keys never clash with a raw unknown kind or its numbered siblings', () => {
  const pull = zaiPull([win('zai:unknown', 'unknown'), win('zai:unknown#1', 'u1'), win(`zai:${TOKEN}`, 'a'), win('zai:unknown#3', 'u3'), win(`zai:${TOKEN}#2`, 'b')])
  const out = redactPull(pull, target)
  const keys = out.ok ? out.report.windows.map(window => window.key) : []
  expect(keys).toEqual(['zai:unknown', 'zai:unknown#1', 'zai:unknown#2', 'zai:unknown#3', 'zai:unknown#4'])
  expect(new Set(keys).size).toBe(keys.length)
})

test('redactPull redacts whole free-text reasons in any case, and leaves a pull unchanged when the target has no credential', () => {
  const failed: QuotaPull = { ok: false, outcome: 'unreachable', reason: `bad ${TOKEN.toUpperCase()} host` }
  expect(redactPull(failed, target)).toEqual({ ok: false, outcome: 'unreachable', reason: REDACTED })
  const credits: QuotaPull = { ok: true, report: { status: 'allowed', receivedAt: RECEIVED, windows: [] }, remainingUsd: null, credits: { outcome: 'refused', reason: `key ${BALANCE}` } }
  expect(redactPull(credits, target)).toMatchObject({ credits: { outcome: 'refused', reason: REDACTED } })
  const plain: QuotaPull = { ok: false, outcome: 'unreachable', reason: 'abc tool' }
  expect(redactPull(plain, { providerId: 'zai', baseUrl: null })).toBe(plain)
  expect(redactPull(plain, { providerId: 'zai', baseUrl: null, token: '' })).toBe(plain)
})

let composition: QuotaComposition | undefined
let restoreLogs: (() => void) | undefined
afterEach(async () => {
  restoreLogs?.()
  restoreLogs = undefined
  await composition?.close()
  composition = undefined
})

// Sol note-90848d06: a five-character credential, echoed by an accepted answer.
test('a five-character mixed-case credential echoed by an accepted answer is sent once and reaches neither the live usage trace, history nor logs', async () => {
  const short = ['Qx', '7Zk'].join('')
  const logs: string[] = []
  const spies = (['debug', 'info', 'warn', 'error'] as const).map(level =>
    spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logs.push(JSON.stringify(args)) }) as never))
  restoreLogs = () => { for (const spy of spies) spy.mockRestore() }
  composition = await quotaComposition({ env: { ZQ_TOKEN: short } })
  composition.writeGroup('workers: [glm]')
  composition.answers.push(jsonResponse(quotaCapture(30, undefined, short.toUpperCase())), new Error(`connect failed ${short}`))
  await sessionIn(composition)
  expect(composition.calls.map(call => call.auth)).toEqual([short])
  const trace = JSON.stringify([composition.usage, composition.manager.providerUsageOf('zai')]).toLowerCase()
  expect(trace).toContain('30')
  expect(trace).not.toContain(short.toLowerCase())
  expect(composition.manager.providerUsageOf('zai')?.windows.map(window => window.key)).toEqual(['zai:time_limit', 'zai:unknown#1'])
  // The next poll fails with an error that names the credential: the failure path logs and records it safely.
  await advance(CADENCE_MS * 1.11)
  expect(composition.calls.length).toBeGreaterThanOrEqual(2)
  expect(historyRows(composition.db).map(row => row.outcome).slice(0, 2)).toEqual(['supported', 'failed'])
  expect(JSON.stringify(historyRows(composition.db)).toLowerCase()).not.toContain(short.toLowerCase())
  expect(logs.join('\n').toLowerCase()).not.toContain(short.toLowerCase())
})

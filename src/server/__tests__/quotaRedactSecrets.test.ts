// redactPull (process-quota-history-and-incident-advice I2; Sol re-check
// note-d5b9f0e9 item 1): every string occurrence of the target's own
// credentials is replaced, in reports and failure reasons alike; compatible
// wire text stays as sent.
import { expect, test } from 'bun:test'
import type { QuotaPull } from '../chat/quota/QuotaReaderService'
import { REDACTED, redactPull } from '../chat/quota/redactSecrets'

const TOKEN = ['zq', 'fake', 'redact', '91aa'].join('-')
const BALANCE = ['bal', 'fake', 'key', '77'].join('-')
const target = { providerId: 'zai', baseUrl: 'https://zai.test/api/anthropic', token: TOKEN, balanceKey: BALANCE }

test('redactPull replaces the token and balance key in every report string and keeps other text', () => {
  const pull: QuotaPull = {
    ok: true,
    report: {
      status: 'allowed', source: 'provider', receivedAt: '2026-11-25T00:00:00.000Z',
      windows: [
        { key: `zai:${TOKEN}_x`, label: `${TOKEN} and ${TOKEN} ${BALANCE}`, percentUsed: 1, resetsAt: null },
        { key: 'zai:time_limit', label: 'Tool calls', percentUsed: 40, resetsAt: null },
      ],
    },
  }
  const out = redactPull(pull, target)
  expect(JSON.stringify(out)).not.toContain(TOKEN)
  expect(JSON.stringify(out)).not.toContain(BALANCE)
  expect(out).toEqual({
    ok: true,
    report: {
      status: 'allowed', source: 'provider', receivedAt: '2026-11-25T00:00:00.000Z',
      windows: [
        { key: `zai:${REDACTED}_x`, label: `${REDACTED} and ${REDACTED} ${REDACTED}`, percentUsed: 1, resetsAt: null },
        { key: 'zai:time_limit', label: 'Tool calls', percentUsed: 40, resetsAt: null },
      ],
    },
  })
})

test('redactPull redacts a failure reason, and leaves a pull unchanged when the target has no credential long enough to match', () => {
  const failed: QuotaPull = { ok: false, outcome: 'unreachable', reason: `bad ${TOKEN}` }
  expect(redactPull(failed, target)).toEqual({ ok: false, outcome: 'unreachable', reason: `bad ${REDACTED}` })
  const short: QuotaPull = { ok: false, outcome: 'unreachable', reason: 'abc tool' }
  expect(redactPull(short, { providerId: 'zai', baseUrl: null, token: 'abc' })).toBe(short)
  expect(redactPull(short, { providerId: 'zai', baseUrl: null })).toBe(short)
})

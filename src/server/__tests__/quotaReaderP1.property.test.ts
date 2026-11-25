// Property P1, one request per key (process-quota-history-and-incident-advice
// D2): seeded sequences of subscribe, unsubscribe, tick, response, timeout,
// config change, restart and shutdown over 1–4 teams and 1–3 account keys,
// through the production ManagerQuota and reader service with an injected
// fetch and fake clock. Checked at every request the transport sees: no other
// request for that key is open, and some team still holds the key; after
// shutdown nothing settles, publishes or is stored. P4 rides along: no stored
// row or log line carries the credential or the body.
import { afterAll, afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshTestDatabase } from './helpers/testDatabase'
import { accountKeyOf, type QuotaTarget } from '../chat/quota/quotaTarget'
import { propertyCases } from './helpers/propertyCases'
import {
  BODY_MARKER, OTHER, QUOTA_TOKEN, QUOTA_TOKEN_B, ZAI, ZAI_B,
  flush, serviceHarness, step, liveTrace, storedRows, sub, type ServiceHarness,
} from './helpers/quotaServiceHarness'

const SEED = 0x51A7
const CASES = 200
const KEYS: QuotaTarget[] = [ZAI, ZAI_B, OTHER]
const OPS = ['subscribe', 'unsubscribe', 'tick', 'response', 'timeout', 'config', 'restart', 'shutdown'] as const

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

// One database for every case: each case empties its quota history.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-quota-p1-')))
const db = freshTestDatabase(path.join(root, 'test.db'))
let h: ServiceHarness | null = null
afterEach(() => {
  h?.close()
  h = null
})
afterAll(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function runCase(index: number): Promise<string[]> {
  const rng = mulberry32(SEED + index)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
  const teams = Array.from({ length: 1 + Math.floor(rng() * 4) }, (_, i) => `team-${i}`)
  const keys = KEYS.slice(0, 1 + Math.floor(rng() * 3))
  const harness = serviceHarness(db)
  h = harness
  harness.random = rng()
  const violations: string[] = []
  // team → key index it holds
  const held = new Map<string, number>()
  const desired = () => [...held].map(([team, key]) => sub(team, keys[key]!))
  const heldKeys = () => new Set([...held.values()].map(key => accountKeyOf(keys[key]!)))
  let stopped = false
  harness.beforeRequest = (key) => {
    if (stopped) violations.push(`request after shutdown for ${key.slice(0, 5)}`)
    if (harness.openKey(key).length > 0) violations.push(`two requests in flight for ${key.slice(0, 5)}`)
    if (!heldKeys().has(key)) violations.push(`request for an unsubscribed key ${key.slice(0, 5)}`)
  }
  let frozen: { settlements: number; rows: number; usage: string } | null = null
  const length = 5 + Math.floor(rng() * 25)
  for (let i = 0; i < length && !stopped; i++) {
    const op = pick(OPS)
    if (op === 'subscribe') held.set(pick(teams), Math.floor(rng() * keys.length))
    else if (op === 'unsubscribe') held.delete(pick(teams))
    else if (op === 'config') {
      const team = pick(teams)
      if (held.has(team)) held.set(team, (held.get(team)! + 1) % keys.length)
    }
    if (op === 'subscribe' || op === 'unsubscribe' || op === 'config') await harness.reconcile(desired())
    else if (op === 'tick') await step(Math.floor(rng() * 12 * 60_000), 10_000)
    else if (op === 'response') {
      const open = harness.requests.filter(request => !request.ended)
      if (open.length > 0) {
        const request = pick(open)
        if (rng() < 0.7) request.ok(Math.floor(rng() * 100))
        else request.fail()
        await flush()
      }
    } else if (op === 'timeout') await step(10_000, 10_000)
    else if (op === 'restart') {
      harness.restart()
      await flush()
    } else if (op === 'shutdown') {
      harness.quota.shutdown()
      stopped = true
      frozen = { settlements: harness.settlements.length, rows: storedRows(harness).length, usage: JSON.stringify(harness.usage.get('zai')) }
    }
  }
  if (frozen) {
    for (const request of harness.requests) if (rng() < 0.5) request.ok()
    await flush()
    await step(40 * 60_000, 10_000)
    if (harness.settlements.length !== frozen.settlements) violations.push('settled after shutdown')
    if (storedRows(harness).length !== frozen.rows) violations.push('stored after shutdown')
    if (JSON.stringify(harness.usage.get('zai')) !== frozen.usage) violations.push('published after shutdown')
  }
  const haystack = [...storedRows(harness), ...harness.logs].join('\n')
  for (const secret of [QUOTA_TOKEN, QUOTA_TOKEN_B, BODY_MARKER]) if (haystack.includes(secret)) violations.push('secret persisted or logged')
  const liveText = liveTrace(harness).join('\n')
  for (const secret of [QUOTA_TOKEN, QUOTA_TOKEN_B]) if (liveText.includes(secret)) violations.push('credential in the live trace')
  harness.close()
  h = null
  return violations.map(violation => `case ${index}: ${violation}`)
}

test('P1: at most one request per account key, none after the last unsubscribe or shutdown (seed 0x51A7, 200 cases)', async () => {
  const violations: string[] = []
  for (let index = 0; index < propertyCases(CASES); index++) violations.push(...await runCase(index))
  expect(violations).toEqual([])
}, 600_000)

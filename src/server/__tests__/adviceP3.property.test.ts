// Property P3, assessments are append-only (process-quota-history-and-
// incident-advice D5, I3): seeded sequences of quota incidents, observations,
// clock steps, replays (re-triggers and startup reconciles) and crashes —
// after an incident commit before its evaluation, and inside the append
// transaction — through the production ManagerAdvice, queue, evaluator and
// stores. After every step no stored assessment or evidence row has changed,
// and versions stay dense; at the end the latest assessment of every
// recommendation equals a fresh evaluation of the final evidence.
import { afterEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { evaluateIncident } from '../metrics/recommendations/evaluator'
import { propertyCases } from './helpers/propertyCases'
import { adviceHarness, MIN, TEAM, type AdviceHarness } from './helpers/adviceHarness'

const SEED = 0xA55E
const CASES = 200
const OPS = ['incident', 'observe', 'observe', 'step', 'replay', 'reconcile', 'crash', 'crash-in-append', 'drain'] as const
const WORKERS = [{ model: 'glm', provider: 'zai', live: 1 }, { model: 'kimi', provider: 'moon' }, { model: 'qwen', provider: 'qwen' }]
const SCOPES = { glm: 'scope-zai', kimi: 'scope-moon', qwen: 'scope-qwen' }

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

let open: AdviceHarness[] = []
afterEach(() => {
  for (const harness of open.reverse()) harness.close()
  open = []
})

function rows(db: Database): Map<string, string> {
  const all = new Map<string, string>()
  for (const row of db.prepare('SELECT * FROM process_assessments').all() as Array<{ id: string }>) all.set(row.id, JSON.stringify(row))
  for (const row of db.prepare('SELECT * FROM process_assessment_evidence').all() as Array<{ assessment_id: string; ordinal: number }>) {
    all.set(`${row.assessment_id}#${row.ordinal}`, JSON.stringify(row))
  }
  return all
}

function runCase(index: number): string[] {
  const rng = mulberry32(SEED + index)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
  const violations: string[] = []
  let h = adviceHarness()
  open.push(h)
  const configure = (harness: AdviceHarness) => {
    harness.workers = WORKERS.map(worker => ({ ...worker }))
    harness.scopes = { ...SCOPES }
  }
  configure(h)
  const restart = () => {
    h.advice.shutdown()
    const records = h.records
    const clock = h.clock.now
    h = adviceHarness({ db: h.db })
    open.push(h)
    configure(h)
    h.records = records
    h.clock.now = clock
    h.advice.start()
  }
  const length = 4 + Math.floor(rng() * 20)
  for (let i = 0; i < length; i++) {
    const before = rows(h.db.db)
    const op = pick(OPS)
    if (op === 'incident') {
      const limited = pick(['glm', 'kimi'])
      h.limit({ profileId: limited, providerId: limited === 'glm' ? 'zai' : 'moon', resetsAt: rng() < 0.3 ? null : new Date(h.clock.now + Math.floor(rng() * 90) * MIN).toISOString() })
    } else if (op === 'observe') {
      const worker = pick(WORKERS)
      h.observe(worker.model, worker.provider, h.clock.now - Math.floor(rng() * 15) * MIN, { percent: pick([10, 60, 100]), outcome: rng() < 0.75 ? 'supported' : 'failed' })
      h.advice.historyWritten([TEAM])
    } else if (op === 'step') h.clock.now += Math.floor(rng() * 40) * MIN
    else if (op === 'replay') {
      h.advice.historyWritten([TEAM])
      h.drain()
      h.advice.historyWritten([TEAM])
      h.drain()
    } else if (op === 'reconcile') {
      h.advice.service.reconcile()
      h.drain()
    } else if (op === 'crash') restart()
    else if (op === 'crash-in-append') {
      // The process dies inside the append transaction, after the assessment
      // row and before its evidence: the transaction must leave nothing.
      const db = h.db.db
      const prepare = db.prepare.bind(db)
      db.prepare = ((sql: string) => {
        if (sql.includes('INSERT INTO process_assessment_evidence')) throw new Error('crash')
        return prepare(sql)
      }) as typeof db.prepare
      try {
        h.drain()
      } finally {
        db.prepare = prepare
      }
      // A quota assessment always cites its incident's limit, so one with no evidence row is a torn write.
      const orphans = db.prepare(`SELECT COUNT(*) AS n FROM process_assessments a JOIN process_recommendations r ON r.id = a.recommendation_id
        WHERE r.kind = 'quota' AND NOT EXISTS (SELECT 1 FROM process_assessment_evidence e WHERE e.assessment_id = a.id)`).get() as { n: number }
      if (orphans.n > 0) violations.push(`case ${index}: assessment without its evidence after a crash in append`)
      restart()
    } else h.drain()
    const after = rows(h.db.db)
    for (const [key, value] of before) {
      if (after.get(key) !== value) violations.push(`case ${index} op ${i} (${op}): stored row ${key} changed`)
    }
    const versions = h.db.db.prepare('SELECT recommendation_id, GROUP_CONCAT(version) AS v FROM process_assessments GROUP BY recommendation_id').all() as Array<{ v: string }>
    for (const { v } of versions) {
      const list = v.split(',').map(Number).sort((a, b) => a - b)
      if (list.some((value, at) => value !== at + 1)) violations.push(`case ${index}: versions not dense (${v})`)
    }
  }
  // Settle: a final restart and drain, then compare with a fresh evaluation
  // of the final evidence at the final time. An open episode's latest must
  // match it (an equal hash is why no further version was written); a
  // resolved one is final: if its provider cools again, a newer episode holds it.
  restart()
  h.drain()
  // A late first assessment enqueues its follow-up (the next coalesced pass).
  h.drain()
  const final = h.clock.now
  for (const entry of h.advice.store.list(TEAM, 200)) {
    const rec = h.advice.store.byId(entry.id)!
    const latest = h.advice.store.latest(rec.id)
    if (!latest) {
      violations.push(`case ${index}: recommendation ${rec.episodeKey} has no assessment after settling`)
      continue
    }
    const until = h.limits.cooldownFor(rec.snapshot.limited.profileId, rec.snapshot.limited.providerId).until
    const providers = [...new Set([rec.snapshot.limited.providerId, ...rec.snapshot.candidates.map(candidate => candidate.providerId)])]
    const fresh = evaluateIncident({
      kind: rec.kind, snapshot: rec.snapshot, cutoff: final,
      observations: h.history.list(TEAM, { until: new Date(final).toISOString() }),
      limits: providers.flatMap(provider => h.limits.forProvider(provider)).map(event => ({ id: event.id, providerId: event.providerId, at: event.at, final: event.final, window: event.window })),
      open: until !== null && Date.parse(until) > final,
      comparisons: 0,
    })
    if (latest.state === 'resolved') {
      // Final: a later limit of the provider opens a newer episode instead.
      const newer = h.advice.store.list(TEAM, 200).some(other => other.providerId === rec.providerId && other.kind === rec.kind &&
        other.createdAt >= latest.createdAt && other.id !== rec.id)
      if (fresh.advice.choice !== 'resolved' && !newer) violations.push(`case ${index}: ${rec.episodeKey} resolved while its incident is in force`)
    } else if (fresh.evidenceHash !== latest.evidenceHash) {
      violations.push(`case ${index}: latest of ${rec.episodeKey} differs from a fresh evaluation`)
    }
  }
  return violations
}

test('P3: stored assessments are never changed and the latest equals a fresh evaluation (seed 0xA55E, 200 cases)', () => {
  const violations: string[] = []
  for (let index = 0; index < propertyCases(CASES); index++) {
    violations.push(...runCase(index))
    for (const harness of open.reverse()) harness.close()
    open = []
  }
  expect(violations.slice(0, 10)).toEqual([])
}, 600_000)

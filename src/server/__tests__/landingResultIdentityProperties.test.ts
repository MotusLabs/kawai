// Kawai accepts the authorizing round's own result (execution-landing-result-
// identity, oracle-binding.md): the ordered reference model (terminal, then
// identity, then the acceptance service), its finite-axis enumeration, and
// the seeded properties P1–P3. Every case is one provisioned change of a real
// execution, its task and results through the real task services, its rounds
// through the execution store, and one landing effect settled done and handed
// to the production mechanism's follow-on (direct or integration-branch).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../logger'
import { afterLanded, type LandingDeps } from '../plans/execution/executionLanding'
import type { ChangeRow, RoundRow } from '../plans/execution/executionRows'
import { propertyCases } from './helpers/propertyCases'
import { commitAll, createMatrixBench, createMatrixWorld, removeMatrixWorld, startedExecution, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'
import { createIntegrationBench, type IntegrationBench } from './integrationMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let n = 0
let seq = 0
let warn: ReturnType<typeof spyOn<typeof logger, 'warn'>>

beforeAll(async () => { matrix = await createMatrixWorld('kawai-identity-props-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); n += 1; warn = spyOn(logger, 'warn') })
afterEach(() => { warn.mockRestore(); i.executor.close(); h.executor.close(); h.bench.db.close() })

/** mulberry32: a tiny seeded PRNG — the design forbids a new dependency. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!

// ── The reference model (oracle-binding.md, "Evaluation order") ──────────
export type Status = 'open' | 'active' | 'blocked' | 'done-human' | 'done-kawai' | 'cancelled'
export type Ref = 'valid' | 'null' | 'missing' | 'foreign-execution' | 'foreign-change' | 'wrong-commit'
type Mechanism = 'direct' | 'integration'
type Pin = 'current' | 'older'
type Expected =
  | { class: 'terminal' }
  | { class: 'refused'; reason: 'no-round' | 'round-missing' | 'round-mismatch' | 'commit-mismatch' }
  | { class: 'stale' }
  | { class: 'accepted' }
const STATUSES: readonly Status[] = ['open', 'active', 'blocked', 'done-human', 'done-kawai', 'cancelled']
const REFS: readonly Ref[] = ['valid', 'null', 'missing', 'foreign-execution', 'foreign-change', 'wrong-commit']
const REASON: Record<Exclude<Ref, 'valid'>, 'no-round' | 'round-missing' | 'round-mismatch' | 'commit-mismatch'> = {
  null: 'no-round', missing: 'round-missing', 'foreign-execution': 'round-mismatch', 'foreign-change': 'round-mismatch', 'wrong-commit': 'commit-mismatch',
}
const terminal = (status: Status) => status === 'done-human' || status === 'done-kawai' || status === 'cancelled'

/** Terminal, then identity, then the acceptance service; mechanism, siblings and provenance are not inputs. */
export function expected(status: Status, ref: Ref, pin: Pin): Expected {
  if (terminal(status)) return { class: 'terminal' }
  if (ref !== 'valid') return { class: 'refused', reason: REASON[ref] }
  return pin === 'older' ? { class: 'stale' } : { class: 'accepted' }
}

// ── The seam fixture: lanes of provisioned changes ───────────────────────
interface Lane { executionId: string; change: string; taskId: string; attemptId: string; commits: [string, string] }

/** `count` provisioned changes of one running execution, each with two commits on its branch. */
async function lanes(count: number): Promise<Lane[]> {
  const names = Array.from({ length: count }, () => `p${n}x${seq++}`)
  const executionId = await startedExecution(h, names.map(change => ({ change })), { maxParallel: count })
  await h.tick()
  return names.map(change => {
    const row = h.executions.change(executionId, change)!
    fs.writeFileSync(path.join(row.worktree!, `${change}.txt`), `${change}\n`)
    const next = commitAll(row.worktree!, change)
    return { executionId, change, taskId: row.taskId!, attemptId: h.executions.attempts(executionId, change)[0]!.id, commits: [row.baselineCommit!, next] }
  })
}

const kawai = (executionId: string) => ({ kind: 'system' as const, team: matrix.world.team, origin: { kind: 'execution' as const, executionId } })
async function submitted(lane: Lane, commit: string): Promise<string> {
  return (await h.results.submit(h.bench.agent('dev'), lane.taskId, { summary: 'work', commit, tests: [{ description: 'unit', outcome: 'pass' }] })).id
}
function round(lane: Lane, resultId: string, commit: string): RoundRow {
  return h.executions.insertRound({ executionId: lane.executionId, change: lane.change, attemptId: lane.attemptId, resultId, commitSha: commit, fixRound: false }).round
}

/** Bring the task to its pre-follow-on state; Kawai's earlier acceptance precedes the older pin. */
async function prepare(lane: Lane, status: Status, pin: Pin, authorizing: string, humanPick: string): Promise<void> {
  if (status === 'done-kawai') await h.results.accept(kawai(lane.executionId), lane.taskId, authorizing)
  if (pin === 'older') await h.tasks.amend(h.bench.human, lane.taskId, { direction: 'Do it differently now', rationale: 'scope changed' })
  if (status === 'active' || status === 'blocked') await h.tasks.setStatus(h.bench.human, lane.taskId, status)
  if (status === 'cancelled') await h.tasks.setStatus(h.bench.human, lane.taskId, 'cancelled')
  if (status === 'done-human') await h.results.accept(h.bench.human, lane.taskId, humanPick, 'the human chose it')
}

const landingDeps = (): LandingDeps => ({
  team: matrix.world.team, repo: matrix.world.repo, executions: h.executions, plans: h.bench.plans, results: h.results,
  plansService: h.plansService, conditionsOf: () => [], records: () => h.bench.records.values(),
  now: () => new Date(h.clock.now).toISOString(), revisionAttempt: async () => false,
  updateAttempt: async () => { throw new Error('no update attempt in the identity seam') },
  taskStatusOf: taskId => h.tasks.store.get(taskId)?.status ?? null,
})

/** One landing step: a done merge or fast-forward effect naming `roundId`, through the mechanism's follow-on. */
async function land(lane: Lane, mechanism: Mechanism, head: string, roundId: string | null): Promise<ChangeRow> {
  const prior = h.executions.change(lane.executionId, lane.change)!
  h.executions.transition(lane.executionId, lane.change, { state: prior.state, generation: prior.generation }, { state: 'landing', step: 'merging' })
  const row = h.executions.change(lane.executionId, lane.change)!
  const kind = mechanism === 'direct' ? 'merge' : 'fast-forward'
  const effect = h.executions.insertEffect({
    executionId: lane.executionId, change: lane.change, roundId, kind, effectKey: `${lane.executionId}:${lane.change}:${kind}:${seq++}`,
    command: mechanism === 'direct' ? { repo: '', pr: 0, head } : { sha: head, cwd: row.worktree, candidateId: 'none', base: row.baselineCommit },
  })
  h.executions.setEffectOutcome(effect.id, {
    state: 'done', outcome: mechanism === 'direct' ? { merged: true, mergeCommit: head, head, base: row.baselineCommit } : { fastForwarded: true, head },
  })
  const registry = i.mechanisms.get(mechanism === 'direct' ? 'direct' : 'integration-branch')!
  await registry.landOutcome(landingDeps(), h.executions.effect(effect.id)!, h.landingAdapters)
  return row
}

interface Snapshot { acceptances: Array<{ id: string; by: string; at: string | null }>; status: string; journal: number }
function snapshot(lane: Lane): Snapshot {
  return {
    acceptances: h.tasks.store.results.listByTask(lane.taskId).filter(result => result.acceptedBy !== null)
      .map(result => ({ id: result.id, by: result.acceptedBy!.kind, at: result.acceptedAt })),
    status: h.tasks.store.get(lane.taskId)!.status,
    journal: h.tasks.store.journal(lane.taskId).length,
  }
}
const eventsFor = (lane: Lane, from: number, event: string) =>
  warn.mock.calls.slice(from).filter(call => call[0] === event && (call[1] as { change?: string } | undefined)?.change === lane.change)
const landingFacts = (lane: Lane) =>
  h.executions.landings(h.executions.execution(lane.executionId)!.planId).filter(fact => fact.change === lane.change)

/** Assert the follow-on's observable outcome against the model's class. */
function assertOutcome(lane: Lane, want: Expected, before: Snapshot, warnFrom: number, systemAccepts: unknown[][], authorizing: string, label: string): void {
  const after = snapshot(lane)
  const refused = eventsFor(lane, warnFrom, 'plan_execution_accept_identity_refused')
  const failed = eventsFor(lane, warnFrom, 'plan_execution_accept_failed')
  expect(h.executions.change(lane.executionId, lane.change)!.state, label).toBe('landed')
  expect(landingFacts(lane), label).toHaveLength(1)
  if (want.class === 'accepted') {
    expect(systemAccepts.map(call => call[2]), label).toEqual([authorizing])
    expect(after.acceptances.filter(entry => !before.acceptances.some(prior => prior.id === entry.id)).map(({ id, by }) => ({ id, by })), label).toEqual([{ id: authorizing, by: 'system' }])
    expect(after.status, label).toBe('done')
  } else {
    expect(after.acceptances, label).toEqual(before.acceptances)
    expect(after.status, label).toBe(before.status)
    if (want.class === 'stale') expect(systemAccepts.map(call => call[2]), label).toEqual([authorizing])
    else expect(systemAccepts, label).toEqual([])
    expect(after.journal, label).toBe(before.journal)
  }
  expect(refused.map(call => (call[1] as { reason: string }).reason), label).toEqual(want.class === 'refused' ? [want.reason] : [])
  expect(failed.length, label).toBe(want.class === 'stale' ? 1 : 0)
  for (const prior of before.acceptances) expect(after.acceptances.find(entry => entry.id === prior.id), label).toEqual(prior)
}

/** Run one follow-on with the acceptance service observed; returns the system accept calls. */
async function observed(run: () => Promise<unknown>): Promise<unknown[][]> {
  const accept = spyOn(h.results, 'accept')
  try {
    await run()
    return accept.mock.calls.filter(call => (call[0] as { kind: string }).kind === 'system').map(call => [...call])
  } finally {
    accept.mockRestore()
  }
}

describe('the reference model', () => {
  // The design's O1–O16 outputs, verbatim, as (status, ref, pin) inputs and the class each output names.
  const ROWS: Array<[string, Status, Ref, Pin, Expected['class'], string]> = [
    ['O1', 'open', 'valid', 'current', 'accepted', '{auth} by Kawai | done | —'],
    ['O2', 'open', 'valid', 'current', 'accepted', '{auth}; earlier stays unaccepted | done | —'],
    ['O3', 'open', 'valid', 'current', 'accepted', '{auth}; earlier stays unaccepted | done | —'],
    ['O4', 'open', 'valid', 'current', 'accepted', "{carried round's result} | done | —"],
    ['O5', 'open', 'valid', 'current', 'accepted', '{that result}, once | done | —'],
    ['O6', 'open', 'valid', 'current', 'accepted', '{auth}; new result unaccepted | done | —'],
    ['O7', 'open', 'valid', 'current', 'accepted', "{auth}; later round's result unaccepted | done | —"],
    ['O8', 'open', 'null', 'current', 'refused', '∅ | open | identity refused: no-round'],
    ['O9', 'open', 'missing', 'current', 'refused', '∅ | open | identity refused: round-missing'],
    ['O10', 'open', 'foreign-change', 'current', 'refused', '∅ | open | identity refused: round-mismatch'],
    ['O11', 'open', 'wrong-commit', 'current', 'refused', '∅ | open | identity refused: commit-mismatch'],
    ['O12', 'done-human', 'valid', 'current', 'terminal', '{X} by human only | done | —'],
    ['O13', 'cancelled', 'valid', 'current', 'terminal', 'unchanged (∅ when none) | cancelled | —'],
    ['O14', 'open', 'valid', 'older', 'stale', '∅ | open | accept failed (needs stated reason)'],
    ['O15', 'done-kawai', 'valid', 'current', 'terminal', '{auth}, exactly one acceptance row and journal entry | done | —'],
    ['O16', 'open', 'valid', 'current', 'accepted', 'restart with the merge effect `running`: after inspection, {auth} once | done | —'],
  ]

  test('the ordered model reproduces every O1–O16 output class of the decision table', () => {
    for (const [id, status, ref, pin, cls, output] of ROWS) {
      const want = expected(status, ref, pin)
      expect(`${id} ${want.class}`).toBe(`${id} ${cls}`)
      if (want.class === 'refused') expect(output).toContain(want.reason)
      if (want.class === 'accepted') expect(output).toContain('done')
    }
  })

  test('the ordered model puts every one of the 144 finite-axis inputs in exactly one class', () => {
    const counts = new Map<string, number>()
    for (const status of STATUSES) for (const ref of REFS) for (const pin of ['current', 'older'] as Pin[]) for (const _mechanism of ['direct', 'integration'] as Mechanism[]) {
      const want = expected(status, ref, pin)
      const key = want.class === 'refused' ? `refused:${want.reason}` : want.class
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    expect(Object.fromEntries(counts)).toEqual({
      terminal: 72, 'refused:no-round': 12, 'refused:round-missing': 12, 'refused:round-mismatch': 24, 'refused:commit-mismatch': 12, stale: 6, accepted: 6,
    })
  })
})

// ── One case at the seam ─────────────────────────────────────────────────
interface Case { status: Status; ref: Ref; pin: Pin; mechanism: Mechanism }
interface Prepared { lane: Lane; head: string; roundId: string | null; authorizing: string }

/**
 * A lane with an earlier result X on the baseline and the authorizing result
 * R on the new head; `ref` decides which round id the landing effect names.
 * `foreign` is a lane of another execution, `sibling` another change here.
 */
async function prepared(lane: Lane, others: Others, c: Case): Promise<Prepared> {
  const [baseline, head] = lane.commits
  const x = await submitted(lane, baseline)
  const r = await submitted(lane, head)
  const own = round(lane, r, head)
  const roundId: Record<Ref, () => string | null> = {
    valid: () => own.id,
    null: () => null,
    missing: () => `round-missing-${seq++}`,
    'foreign-execution': () => round(others.foreign.lane, others.foreign.result, head).id,
    'foreign-change': () => round(others.sibling.lane, others.sibling.result, head).id,
    'wrong-commit': () => round(lane, r, baseline).id,
  }
  const id = roundId[c.ref]()
  await prepare(lane, c.status, c.pin, r, x)
  return { lane, head, roundId: id, authorizing: r }
}

/** A lane of another execution and another change of this one, each with one submitted result. */
interface Others { foreign: { lane: Lane; result: string }; sibling: { lane: Lane; result: string } }
async function other(lane: Lane): Promise<{ lane: Lane; result: string }> { return { lane, result: await submitted(lane, lane.commits[1]) } }

async function runCase(p: Prepared, c: Case, label: string): Promise<void> {
  const before = snapshot(p.lane)
  const from = warn.mock.calls.length
  const calls = await observed(() => land(p.lane, c.mechanism, p.head, p.roundId))
  assertOutcome(p.lane, expected(c.status, c.ref, c.pin), before, from, calls, p.authorizing, label)
}

describe('finite-axis completeness at the afterLanded seam', () => {
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The authorizing round cannot be confirmed
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The task was closed by hand during the merge
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The authorizing result is pinned to an older revision
  test('every one of the 144 status × reference × pin × mechanism inputs produces its ordered class outcome through the mechanism follow-on', async () => {
    const cases: Case[] = []
    for (const status of STATUSES) for (const ref of REFS) for (const pin of ['current', 'older'] as Pin[]) for (const mechanism of ['direct', 'integration'] as Mechanism[]) cases.push({ status, ref, pin, mechanism })
    expect(cases).toHaveLength(144)
    const [foreignLane] = await lanes(1)
    const foreign = await other(foreignLane!)
    const BATCH = 24
    for (let start = 0; start < cases.length; start += BATCH) {
      const batch = cases.slice(start, start + BATCH)
      const pool = await lanes(batch.length + 1)
      const others = { foreign, sibling: await other(pool.at(-1)!) }
      for (const [k, c] of batch.entries()) {
        const label = `${c.status}/${c.ref}/${c.pin}/${c.mechanism}`
        await runCase(await prepared(pool[k]!, others, c), c, label)
      }
    }
  }, 600_000)
})

// ── Seeded round histories (design "Properties") ─────────────────────────
type Outcome = 'superseded' | 'fail' | 'pass'
interface Step { commit: 0 | 1; outcome: Outcome; kind: 'plain' | 'carried' | 'regate' }
interface History { steps: Step[]; head: 0 | 1; authorizer: number; later: Step[]; status: Status; pin: Pin; humanPick: number; mechanism: Mechanism }
const OUTCOMES: readonly Outcome[] = ['superseded', 'fail', 'pass']

/** 1–8 rounds over a pool of 2 commits, any outcomes, optional carried and re-gate rows and later same-commit rounds. */
function history(r: () => number): History {
  const steps: Step[] = []
  for (let k = 0, count = 1 + Math.floor(r() * 8); k < count; k++) {
    const roll = r()
    const kind = k === 0 ? 'plain' : roll < 0.15 ? 'carried' : roll < 0.3 ? 'regate' : 'plain'
    steps.push({ commit: kind === 'regate' ? steps[k - 1]!.commit : (r() < 0.5 ? 0 : 1), outcome: pick(r, OUTCOMES), kind })
  }
  // The landed head is a commit some round names; the authorizer is uniform among that commit's rounds.
  const head = pick(r, steps).commit
  const authorizer = pick(r, steps.flatMap((step, k) => (step.commit === head ? [k] : [])))
  const later = Array.from({ length: Math.floor(r() * 3) }, () => ({ commit: head, outcome: pick(r, OUTCOMES), kind: 'plain' as const }))
  return { steps, head, authorizer, later, status: pick(r, STATUSES), pin: r() < 0.5 ? 'current' : 'older', humanPick: Math.floor(r() * 1000), mechanism: r() < 0.5 ? 'direct' : 'integration' }
}

interface Built { rounds: RoundRow[]; results: string[]; authorizing: RoundRow; label: 'normal' | 'defensive' }

/** Write the history through the store: each round names its own submitted result (carried and re-gate rows keep their source's). */
async function build(lane: Lane, hist: History): Promise<Built> {
  const rounds: RoundRow[] = []
  const results: string[] = []
  const write = async (step: Step): Promise<RoundRow> => {
    const commit = lane.commits[step.commit]
    const prior = rounds.at(-1)
    let row: RoundRow
    if (step.kind === 'carried' && prior) {
      row = h.executions.insertCarriedRound({ executionId: lane.executionId, change: lane.change, attemptId: lane.attemptId, resultId: prior.resultId, commitSha: commit, carriedFrom: prior.id, ciWindowFrom: new Date(h.clock.now).toISOString() })
    } else if (step.kind === 'regate' && prior) {
      row = h.executions.insertRegateRound(prior, lane.attemptId)
    } else {
      const result = await submitted(lane, commit)
      results.push(result)
      row = round(lane, result, commit)
    }
    if (step.outcome === 'superseded') h.executions.supersedeRound(row.id)
    else h.executions.decideRound(row.id, step.outcome)
    rounds.push(h.executions.round(row.id)!)
    return rounds.at(-1)!
  }
  for (const step of hist.steps) await write(step)
  const authorizing = rounds[hist.authorizer]!
  for (const step of hist.later) await write(step)
  const label = authorizing.outcome === 'pass' || authorizing.carriedFrom !== null ? 'normal' : 'defensive'
  return { rounds, results, authorizing, label }
}

const P1_CASES = 64
const P2_CASES = 64
const P3_CASES = 64

/** Provision `count` lanes in batches and run `body` on each with its index. */
async function overLanes(count: number, body: (lane: Lane, k: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < count; start += 16) {
    const pool = await lanes(Math.min(16, count - start))
    for (const [k, lane] of pool.entries()) await body(lane, start + k)
  }
}

describe('seeded properties', () => {
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › Two results share the landed commit
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › A carried round lands
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The task was closed by hand during the merge
  test('P1 identity, not commit: over 64 seeded round histories (seed 0x5eed1d) the follow-on adds exactly the authorizing round\'s result or nothing, never removes or rewrites an acceptance', async () => {
    const r = rng(0x5eed1d)
    const fixed: History[] = [
      // A human accepted another result X ≠ R before the follow-on (O12 shape).
      { steps: [{ commit: 1, outcome: 'pass', kind: 'plain' }, { commit: 1, outcome: 'pass', kind: 'plain' }], head: 1, authorizer: 1, later: [], status: 'done-human', pin: 'current', humanPick: 0, mechanism: 'direct' },
      // Kawai already accepted R and the follow-on is replayed (O15 shape).
      { steps: [{ commit: 1, outcome: 'pass', kind: 'plain' }], head: 1, authorizer: 0, later: [], status: 'done-kawai', pin: 'current', humanPick: 0, mechanism: 'integration' },
    ]
    const cases = [...fixed, ...Array.from({ length: propertyCases(P1_CASES) }, () => history(r))]
    const labels = { normal: 0, defensive: 0 }
    await overLanes(cases.length, async (lane, k) => {
      const hist = cases[k]!
      const built = await build(lane, hist)
      labels[built.label] += 1
      const humanPick = built.results[hist.humanPick % built.results.length]!
      if (k === 0) expect(humanPick).not.toBe(built.authorizing.resultId)
      await prepare(lane, hist.status, hist.pin, built.authorizing.resultId, humanPick)
      const before = snapshot(lane)
      const from = warn.mock.calls.length
      const calls = await observed(() => land(lane, hist.mechanism, lane.commits[hist.head], built.authorizing.id))
      assertOutcome(lane, expected(hist.status, 'valid', hist.pin), before, from, calls, built.authorizing.resultId, `P1 seed 0x5eed1d case ${k} ${built.label} ${JSON.stringify(hist)}`)
    })
    console.info(`P1 labels: ${JSON.stringify(labels)}`)
    expect(labels.normal).toBeGreaterThan(0)
    expect(labels.defensive).toBeGreaterThan(0)
  }, 600_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The authorizing round cannot be confirmed
  test('P2 fail closed: over 64 seeded histories (seed 0xc105ed) a null, unknown, foreign or wrong-commit round reference with same-commit rounds present changes no acceptance and no status', async () => {
    const r = rng(0xc105ed)
    const [foreignLane] = await lanes(1)
    const [siblingLane] = await lanes(1)
    const others = { foreign: await other(foreignLane!), sibling: await other(siblingLane!) }
    const invalid = REFS.filter(ref => ref !== 'valid')
    const seen = new Set<Ref>()
    await overLanes(propertyCases(P2_CASES), async (lane, k) => {
      const hist = history(r)
      const ref = pick(r, invalid)
      seen.add(ref)
      const built = await build(lane, hist)
      const head = lane.commits[hist.head]
      const off = built.rounds.find(entry => entry.commitSha !== head)
      const roundId = {
        null: null,
        missing: `round-missing-${seq++}`,
        'foreign-execution': round(others.foreign.lane, others.foreign.result, head).id,
        'foreign-change': round(others.sibling.lane, others.sibling.result, head).id,
        'wrong-commit': off?.id ?? round(lane, built.authorizing.resultId, lane.commits[1 - hist.head]!).id,
      }[ref as Exclude<Ref, 'valid'>]
      await prepare(lane, hist.status, hist.pin, built.authorizing.resultId, built.results[hist.humanPick % built.results.length]!)
      const before = snapshot(lane)
      const from = warn.mock.calls.length
      const calls = await observed(() => land(lane, hist.mechanism, head, roundId))
      const label = `P2 seed 0xc105ed case ${k} ${ref} ${JSON.stringify(hist)}`
      assertOutcome(lane, expected(hist.status, ref, hist.pin), before, from, calls, built.authorizing.resultId, label)
      expect(snapshot(lane).acceptances, label).toEqual(before.acceptances)
      expect(snapshot(lane).status, label).toBe(before.status)
    })
    expect(seen.size).toBeGreaterThan(1)
  }, 600_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The follow-on is replayed
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The task was closed by hand during the merge
  test('P3 precedence and replay: over 64 seeded cases (seed 0x0ba1d3) one to three follow-ons from a reachable prior history leave at most one acceptance, the human\'s when the human closed first, and replays change nothing', async () => {
    const r = rng(0x0ba1d3)
    const PRIORS = ['none', 'human-accept', 'human-cancel', 'kawai'] as const
    await overLanes(propertyCases(P3_CASES), async (lane, k) => {
      const hist = history(r)
      const prior = pick(r, PRIORS)
      const runs = 1 + Math.floor(r() * 3)
      const base = pick(r, ['open', 'active', 'blocked'] as const)
      const status: Status = prior === 'human-accept' ? 'done-human' : prior === 'human-cancel' ? 'cancelled' : prior === 'kawai' ? 'done-kawai' : base
      const built = await build(lane, hist)
      if (base !== 'open') await h.tasks.setStatus(h.bench.human, lane.taskId, base)
      await prepare(lane, status, hist.pin, built.authorizing.resultId, built.results[hist.humanPick % built.results.length]!)
      const label = `P3 seed 0x0ba1d3 case ${k} ${prior} x${runs} ${JSON.stringify(hist)}`
      const step = { head: lane.commits[hist.head], roundId: built.authorizing.id }
      const before = snapshot(lane)
      const from = warn.mock.calls.length
      let row: ChangeRow | null = null
      const calls = await observed(async () => { row = await land(lane, hist.mechanism, step.head, step.roundId) })
      assertOutcome(lane, expected(status, 'valid', hist.pin), before, from, calls, built.authorizing.resultId, label)
      const first = snapshot(lane)
      for (let run = 1; run < runs; run++) {
        await afterLanded(landingDeps(), row!, lane.executionId, step)
        expect(snapshot(lane), `${label} replay ${run}`).toEqual(first)
        expect(landingFacts(lane), `${label} replay ${run}`).toHaveLength(1)
      }
      const final = snapshot(lane).acceptances
      expect(final.length, label).toBeLessThanOrEqual(1)
      if (prior === 'human-accept') expect(final.map(entry => entry.by), label).toEqual(['human'])
      if (prior === 'human-cancel') expect(final, label).toEqual([])
    })
  }, 600_000)
})

// The seeded command sequences behind properties P1, P2, P4 and the CR/CH
// model-based test (plan-revision-apply design "Properties"). One case is a
// fresh plan approved at revision 1 running api, ui, and docs, each in flight
// with a task Kawai created, then 4–9 steps drawn from one seeded stream:
// - approve: the next revision from an edit of the current approved one (a
//   reworded, added, or dropped unlanded change; landed changes stay — P3
//   covers their refusal);
// - apply: a fresh command id with a random choice per needed change and a
//   crash at none or one of B0–B4, followed by the owner's retry under the
//   same id after a crash;
// - replay: a resend of an earlier command with its payload;
// - concurrent: two fresh command ids on the same revision at once;
// - land: an in-flight change lands; stop: the execution stops;
// - with `executor`: hold and release (a changes hold on one change), and the
//   real executor ticks after every step.
// The reference model is the CH and CR tables: it predicts each Apply's
// acceptance and its per-change classes and writes, and `check` compares the
// stored rows with it after every step.
import { expect, spyOn } from 'bun:test'
import type { PlanChange, PlanContent } from '../../shared/plans'
import type { ApplyInput } from '../plans/revisionControl/applyService'
import type { ApplyBench } from './applyBench'

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const base = { dependsOn: [] as string[], group: 'middle-devs', acceptance: [] as string[], extraChecks: [], guidance: '', reviewGroup: null }
const BOUNDARIES = ['none', 'B0', 'B1', 'B2', 'B3', 'B4'] as const
type Boundary = typeof BOUNDARIES[number]

export interface SequenceModel {
  planId: string
  executionId: string
  running: boolean
  /** The history rows: seq → revision and command id. */
  history: Array<{ seq: number; revision: number; commandId: string | null }>
  /** The content of each approved revision. */
  contents: Map<number, PlanContent>
  approved: { revision: number; hash: string }
  landed: Set<string>
  cancelled: Set<string>
  tasks: Map<string, string>
  /** Adapt publications per task, and the (command, change) pairs that published. */
  adapts: Map<string, number>
  published: Array<{ commandId: string; change: string }>
  commands: Map<string, { input: ApplyInput; seq: number }>
  holds: Map<string, string>
  serial: number
}

export interface SequenceStats { applied: number; refused: number; crashes: Record<Boundary, number>; replays: number; races: number }

/** The model's own classification (the CH table's classes), independent of `revisionDelta`. */
function classes(model: SequenceModel, from: PlanContent, to: PlanContent): Map<string, string> {
  const result = new Map<string, string>()
  const before = new Map(from.changes.map(entry => [entry.change, entry]))
  const after = new Map(to.changes.map(entry => [entry.change, entry]))
  for (const [name, entry] of after) {
    const prior = before.get(name)
    if (prior === undefined) result.set(name, 'added')
    else if (JSON.stringify(prior) === JSON.stringify(entry)) result.set(name, 'unchanged')
    else {
      const strip = (change: PlanChange) => JSON.stringify({ ...change, dependsOn: [], fixes: undefined })
      result.set(name, model.landed.has(name) && strip(prior) === strip(entry) ? 'metadata' : 'changed')
    }
  }
  for (const name of before.keys()) if (!after.has(name)) result.set(name, 'removed')
  return result
}

const current = (model: SequenceModel) => model.history.at(-1)!
const execContent = (model: SequenceModel) => model.contents.get(current(model).revision)!

/** The changes needing a choice: changed, with a task (CH, AP12). */
function needed(model: SequenceModel): string[] {
  const target = model.contents.get(model.approved.revision)!
  return [...classes(model, execContent(model), target)].filter(([name, kind]) => kind === 'changed' && model.tasks.has(name)).map(([name]) => name)
}

/** Whether the model accepts an Apply of the approved revision at `expected`. */
function accepts(model: SequenceModel, expected: number): boolean {
  if (!model.running || expected !== current(model).revision || model.approved.revision <= current(model).revision) return false
  // landed-unchanged: a change edited or dropped while unlanded, and landed since, refuses.
  return [...classes(model, execContent(model), model.contents.get(model.approved.revision)!)]
    .every(([name, kind]) => !model.landed.has(name) || kind === 'unchanged' || kind === 'metadata')
}

/** The CH writes of an accepted Apply, applied to the model. */
function commit(model: SequenceModel, input: ApplyInput, seq: number): void {
  const target = model.contents.get(input.revision)!
  for (const [name, kind] of classes(model, execContent(model), target)) {
    if (kind === 'removed' && !model.landed.has(name)) model.cancelled.add(name)
    if (kind === 'changed' && input.choices[name] === 'adapt') {
      const taskId = model.tasks.get(name)!
      model.adapts.set(taskId, (model.adapts.get(taskId) ?? 0) + 1)
      model.published.push({ commandId: input.commandId, change: name })
    }
  }
  model.history.push({ seq, revision: input.revision, commandId: input.commandId })
  model.commands.set(input.commandId, { input, seq })
  // D4: an Apply leaving every change of its revision landed completes the run.
  if (target.changes.every(entry => model.landed.has(entry.change))) model.running = false
}

/** The stored rows against the model (P1, P2, and the CH effects). */
export function check(wired: ApplyBench, model: SequenceModel, label: string): void {
  const db = wired.bench.db.db
  const history = wired.revisions.history(model.executionId).map(row => ({ seq: row.seq, revision: row.revision, commandId: row.commandId }))
  expect({ label, history }).toEqual({ label, history: model.history })
  const execution = wired.executions.execution(model.executionId)!
  expect({ label, revision: execution.revision, running: execution.state === 'running' }).toEqual({ label, revision: current(model).revision, running: model.running })
  for (const [change, taskId] of model.tasks) {
    const adapts = model.adapts.get(taskId) ?? 0
    expect({ label, change, revision: wired.tasks.store.get(taskId)!.revision, notices: wired.notices(taskId).length })
      .toEqual({ label, change, revision: 1 + adapts, notices: adapts })
  }
  for (const pair of model.published) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM team_task_revisions WHERE request_key = ?').get(`apply:${pair.commandId}:${pair.change}`) as { n: number }).n
    expect({ label, ...pair, n }).toEqual({ label, ...pair, n: 1 })
  }
  for (const name of model.cancelled) expect({ label, name, state: wired.executions.change(model.executionId, name)?.state }).toEqual({ label, name, state: 'cancelled' })
  for (const name of model.landed) expect({ label, name, state: wired.executions.change(model.executionId, name)?.state }).toEqual({ label, name, state: 'landed' })
}

/** A fresh case: the plan, the execution with its seq-1 row, and three in-flight changes. */
export async function startCase(wired: ApplyBench): Promise<SequenceModel> {
  const changes = ['api', 'ui', 'docs'].map(change => ({ ...base, change }))
  const { planId, executionId } = await wired.running({ changes })
  const plan = wired.bench.plans.get(planId)!
  const revision = wired.bench.plans.revision(planId, plan.currentApprovedRevision!)!
  const model: SequenceModel = {
    planId, executionId, running: true, history: [{ seq: 1, revision: revision.revision, commandId: null }],
    contents: new Map([[revision.revision, revision.content]]), approved: { revision: revision.revision, hash: revision.contentHash },
    landed: new Set(), cancelled: new Set(), tasks: new Map(), adapts: new Map(), published: [], commands: new Map(), holds: new Map(), serial: 0,
  }
  for (const change of ['api', 'ui', 'docs']) {
    const flight = await wired.inFlightByKawai(executionId, change, 'dev')
    const row = wired.executions.change(executionId, change)!
    wired.executions.transition(executionId, change, row, { state: 'implementing', baselineCommit: 'base-sha' })
    model.tasks.set(change, flight.taskId)
  }
  return model
}

async function approve(wired: ApplyBench, model: SequenceModel, next: () => number): Promise<void> {
  const content = structuredClone(model.contents.get(model.approved.revision)!)
  const open = content.changes.filter(entry => !model.landed.has(entry.change))
  const roll = next()
  const n = ++model.serial
  let edited: PlanContent
  if (roll < 0.5 && open.length > 0) {
    const target = open[Math.floor(next() * open.length)]!.change
    edited = { ...content, changes: content.changes.map(entry => (entry.change === target ? { ...entry, guidance: `revised ${n}` } : entry)) }
  } else if (roll < 0.75 || open.length === 0) {
    edited = { ...content, changes: [...content.changes, { ...base, change: `x${model.executionId.slice(5, 11)}${n}` } as PlanChange] }
  } else {
    const target = open[Math.floor(next() * open.length)]!.change
    edited = { ...content, changes: content.changes.filter(entry => entry.change !== target) }
    if (edited.changes.length === 0) edited = { ...content, changes: [...content.changes, { ...base, change: `y${model.executionId.slice(5, 11)}${n}` } as PlanChange] }
  }
  const approved = await wired.approveNext(model.planId, () => edited)
  model.contents.set(approved.revision, wired.bench.plans.revision(model.planId, approved.revision)!.content)
  model.approved = approved
}

/** One Apply with a crash at `boundary` and, after a crash, the owner's retry under the same command id. */
async function apply(wired: ApplyBench, model: SequenceModel, next: () => number, stats: SequenceStats): Promise<void> {
  const boundary = BOUNDARIES[Math.floor(next() * BOUNDARIES.length)]!
  const choices = Object.fromEntries(needed(model).map(name => [name, ['continue', 'adapt', 'restart'][Math.floor(next() * 3)]!]))
  const input: ApplyInput = {
    executionId: model.executionId, expectedRevision: current(model).revision, revision: model.approved.revision, contentHash: model.approved.hash,
    choices, rationale: 'the owner rethought it', commandId: `seq-${model.executionId.slice(5, 13)}-${++model.serial}`,
  }
  const label = `apply ${input.commandId} at ${boundary}`
  const predicted = accepts(model, input.expectedRevision)
  const before = wired.counts()
  stats.crashes[boundary] += 1
  if (boundary !== 'none' && boundary !== 'B4') {
    // B0: never ran. B1: the plan command's entry throws. B2: a write inside the transaction throws. B3: the wake throws.
    let crashed: unknown = 'never ran'
    if (boundary === 'B1') {
      const spy = spyOn(wired.bench.service, 'recordRevisionControlEvent').mockImplementationOnce(() => { throw new Error('crash at B1') })
      try { crashed = await wired.apply.apply(wired.bench.human, input).catch((error: Error) => error.message) } finally { spy.mockRestore() }
    } else if (boundary === 'B2') {
      const spy = spyOn(wired.revisions, 'recordAt').mockImplementationOnce(() => { throw new Error('crash at B2') })
      try { crashed = await wired.apply.apply(wired.bench.human, input).catch((error: Error) => error.message) } finally { spy.mockRestore() }
    } else if (boundary === 'B3') {
      wired.useWake(() => { throw new Error('crash at B3') })
      try { crashed = await wired.apply.apply(wired.bench.human, input).catch((error: Error) => error.message) } finally { wired.useWake(null) }
    }
    // Every crash is a throw at its boundary, never an answer: a refusal here is a model mismatch.
    expect({ label, crashed, predicted }).toEqual({ label, crashed: boundary === 'B0' ? 'never ran' : predicted || boundary === 'B1' ? `crash at ${boundary}` : crashed, predicted })
    if (boundary === 'B3' && predicted) {
      // CR3: the whole Apply committed.
      commit(model, input, current(model).seq + 1)
      check(wired, model, `${label} (committed before the crash)`)
    } else {
      // CR1, CR2 (and a refused B3): nothing from this Apply.
      expect({ label, counts: wired.counts() }).toEqual({ label, counts: before })
    }
  }
  const outcome = await wired.apply.apply(wired.bench.human, input)
  if (boundary === 'B3' && predicted) {
    expect({ label, ok: outcome.ok, replayed: outcome.ok && outcome.replayed }).toEqual({ label, ok: true, replayed: true })
    stats.applied += 1
    return
  }
  expect({ label, ok: outcome.ok }).toEqual({ label, ok: predicted })
  if (!outcome.ok) {
    stats.refused += 1
    expect({ label, counts: wired.counts() }).toEqual({ label, counts: before })
    return
  }
  stats.applied += 1
  commit(model, input, outcome.applied.seq)
  if (boundary === 'B4') {
    // CR4: the retry replays and writes nothing.
    const after = wired.counts()
    expect(await wired.apply.apply(wired.bench.human, input)).toEqual({ ...outcome, replayed: true })
    expect({ label, counts: wired.counts() }).toEqual({ label, counts: after })
  }
}

async function replay(wired: ApplyBench, model: SequenceModel, next: () => number, stats: SequenceStats): Promise<void> {
  const recorded = [...model.commands.values()]
  if (recorded.length === 0) return
  const pick = recorded[Math.floor(next() * recorded.length)]!
  const before = wired.counts()
  const outcome = await wired.apply.apply(wired.bench.human, pick.input)
  expect({ id: pick.input.commandId, ok: outcome.ok, replayed: outcome.ok && outcome.replayed, seq: outcome.ok ? outcome.applied.seq : null })
    .toEqual({ id: pick.input.commandId, ok: true, replayed: true, seq: pick.seq })
  expect(wired.counts()).toEqual(before)
  stats.replays += 1
}

async function race(wired: ApplyBench, model: SequenceModel, next: () => number, stats: SequenceStats): Promise<void> {
  const choices = Object.fromEntries(needed(model).map(name => [name, ['continue', 'adapt'][Math.floor(next() * 2)]!]))
  const inputs = [1, 2].map(() => ({
    executionId: model.executionId, expectedRevision: current(model).revision, revision: model.approved.revision, contentHash: model.approved.hash,
    choices, rationale: 'the owner rethought it', commandId: `race-${model.executionId.slice(5, 13)}-${++model.serial}`,
  }))
  const predicted = accepts(model, current(model).revision)
  const outcomes = await Promise.all(inputs.map(input => wired.apply.apply(wired.bench.human, input)))
  const winners = outcomes.flatMap((outcome, index) => (outcome.ok ? [{ outcome, input: inputs[index]! }] : []))
  expect({ race: inputs[0]!.commandId, winners: winners.length }).toEqual({ race: inputs[0]!.commandId, winners: predicted ? 1 : 0 })
  if (winners.length === 1) commit(model, winners[0]!.input, winners[0]!.outcome.ok ? winners[0]!.outcome.applied.seq : 0)
  stats.races += 1
}

function land(wired: ApplyBench, model: SequenceModel, next: () => number): void {
  if (!model.running) return
  const candidates = execContent(model).changes.map(entry => entry.change)
    .filter(name => !model.landed.has(name) && !model.cancelled.has(name) && wired.executions.change(model.executionId, name)?.owns === true)
  if (candidates.length === 0) return
  const name = candidates[Math.floor(next() * candidates.length)]!
  wired.executions.insertLanding({
    planId: model.planId, change: name, executionId: model.executionId, teamId: wired.teamId, mechanism: 'direct', prNumber: null, prUrl: null,
    headSha: 'h', baseSha: 'b', mergeSha: `m-${name}`, treeVerified: true,
  })
  const row = wired.executions.change(model.executionId, name)!
  if (wired.executions.transition(model.executionId, name, row, { state: 'landed', step: null }) !== null) model.landed.add(name)
}

export type Step = 'approve' | 'apply' | 'replay' | 'concurrent' | 'land' | 'stop' | 'hold' | 'release'

/** Draw and run one step; returns its kind. */
export async function step(wired: ApplyBench, model: SequenceModel, next: () => number, stats: SequenceStats, withHolds = false): Promise<Step> {
  const roll = next()
  const kinds: Array<[Step, number]> = [['approve', 0.3], ['apply', 0.32], ['replay', 0.08], ['concurrent', 0.1], ['land', 0.12], ['stop', 0.02]]
  if (withHolds) kinds.push(['hold', 0.04], ['release', 0.04])
  const total = kinds.reduce((sum, [, weight]) => sum + weight, 0)
  let cursor = roll * total
  const kind = kinds.find(([, weight]) => (cursor -= weight) < 0)?.[0] ?? 'apply'
  if (kind === 'approve') await approve(wired, model, next)
  if (kind === 'apply') await apply(wired, model, next, stats)
  if (kind === 'replay') await replay(wired, model, next, stats)
  if (kind === 'concurrent') await race(wired, model, next, stats)
  if (kind === 'land') land(wired, model, next)
  if (kind === 'stop' && model.running) {
    wired.executions.finishExecution(model.executionId, 'stopped', 'the owner stopped it')
    model.running = false
  }
  if (kind === 'hold') {
    const open = execContent(model).changes.map(entry => entry.change).filter(name => !model.holds.has(name) && !model.landed.has(name))
    if (open.length > 0) {
      const name = open[Math.floor(next() * open.length)]!
      model.holds.set(name, wired.placeHold(model.planId, [name], `hold-${model.executionId.slice(5, 13)}-${++model.serial}`).id)
    }
  }
  if (kind === 'release' && model.holds.size > 0) {
    const [name, holdId] = [...model.holds][Math.floor(next() * model.holds.size)]!
    wired.holds.release({ teamId: wired.teamId, holdId, changes: [name], reason: 'go on', commandId: `release-${++model.serial}` })
    model.holds.delete(name)
  }
  return kind
}

export const emptyStats = (): SequenceStats => ({ applied: 0, refused: 0, crashes: { none: 0, B0: 0, B1: 0, B2: 0, B3: 0, B4: 0 }, replays: 0, races: 0 })

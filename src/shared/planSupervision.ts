// SDK-free supervision of an executing plan (plan-supervision design D10,
// D11, D12; contract S2), derived when read and never stored. It names:
// - the per-change input `SupervisionInput` the server's loader fills;
// - `SupervisionWait`, the named waits (the type plan-execution's own
//   `WaitingReason` already names its coarse wait, so this one is distinct);
// - `SupervisionCause`, `SupervisionStall`, progress and activity, and the
//   derived `ChangeSupervision`;
// - the cause and stop-reason labels, rendering an unknown kind verbatim
//   (causes are append-only: `revision-control` adds `hold`).
// `changeSupervision(input, now)` owns the outcome precedence, the waits, and
// both stalls; `failureSignature` the repeating-failure key. The report
// (`blockedDependents`, `planReport`) lives in `planReport.ts`.
import type { CandidateState } from './planIntegration'
import type { AttemptKind, ChangeState, ChangeStep, CiCheck, RoundOutcome, StopDetail } from './planExecution'
import { ciClass, flakyChecks, runsByName } from './planExecutionGates'

export type SupervisionOutcome = 'landed' | 'running' | 'waiting' | 'stalled' | 'stopped' | 'cancelled' | 'not-started'
export const SUPERVISION_OUTCOMES: readonly SupervisionOutcome[] = ['landed', 'running', 'waiting', 'stalled', 'stopped', 'cancelled', 'not-started']

/** D10's named waits; a named wait never stalls as `no-progress`. */
export type SupervisionWait =
  | { kind: 'dependency'; changes: string[]; stopped: string[] }
  | { kind: 'parallel-limit'; limit: number | null }
  | { kind: 'effect'; effect: string; state: string; tries: number; nextAt: string | null }
  | { kind: 'uncertain-delivery'; messageId: string | null }
  | { kind: 'staffing'; blocker: string | null }
  | { kind: 'parked'; session: string | null; profile: string | null; until: string | null; cooling: boolean }
  | { kind: 'request'; session: string; request: 'approval' | 'question' }
  | { kind: 'decision-card'; cardId: string; addressedTo: 'lead' | 'owner'; addressedGroup: string | null }
  | { kind: 'ci'; pending: string[] }
  | { kind: 'member-release'; member: string; reason: string }
  | { kind: 'condition'; conditions: string[] }
  | { kind: 'landing-slot'; holderKind: string | null; holderId: string | null }

/** The agent-held stages (D11) and the steps Kawai holds between ticks. */
export type SupervisionStage = AttemptKind | 'review' | 'kawai'

export type SupervisionStall =
  | { kind: 'no-progress'; episodeKey: string; anchorAt: string; deadlineAt: string; idle: boolean }
  | { kind: 'repeating-failure'; episodeKey: string; signature: string; rounds: [string, string] }

/** Append-only (D10): the immediate cause of a change's outcome. */
export type SupervisionCause =
  | SupervisionWait
  | { kind: 'landed'; treeVerified: boolean }
  | { kind: 'stopped'; reason: string; detail: StopDetail | null }
  | { kind: 'cancelled' }
  | { kind: 'not-started' }
  | { kind: 'stage'; stage: SupervisionStage; step: ChangeStep | null }
  | { kind: 'stall'; stall: SupervisionStall['kind'] }

export type ProgressKind = 'result' | 'ci-pass' | 'verdict' | 'round-pass' | 'landing' | 'candidate-pass'
export type ActivityKind = 'turn' | 'live-turn' | 'mail'

/** The instruction holder's session facts (runtime, read from the session and mailbox modules). */
export interface HolderFacts {
  session: string
  group: string | null
  profile: string | null
  /** Archived or killed holders count as idle. */
  gone: boolean
  turnRunning: boolean
  pendingRequest: 'approval' | 'question' | null
  backgroundTasks: number
  workers: number
  dueDirectMail: boolean
  parkedUntil: string | null
  coolingUntil: string | null
  lastTurnEndAt: string | null
  lastTaskMailAt: string | null
}

/** One round of the change, as supervision reads it. */
export interface SupervisionRound {
  id: string
  number: number
  outcome: RoundOutcome | null
  decidedAt: string | null
  carriedFrom: string | null
  ci: CiCheck[] | null
  ciPassedAt: string | null
  verdict: 'pass' | 'fail' | null
  verdictAt: string | null
  findingsSummary: string | null
}

export interface SupervisionInput {
  change: string
  dependsOn: string[]
  /** The newest execution's row; null when that execution has no row for the change. */
  state: ChangeState | null
  step: ChangeStep | null
  stopReason: string | null
  stopDetail: StopDetail | null
  landing: { landedAt: string; treeVerified: boolean; mergeSha: string; postCi: CiCheck[] | null } | null
  /** Outcomes of the change's dependencies. */
  dependencies: Array<{ change: string; outcome: SupervisionOutcome }>
  /** The execution's parallel limit. */
  parallelLimit: number | null
  attempt: { kind: AttemptKind } | null
  rounds: SupervisionRound[]
  /** The change's effects (and the execution-level ones that hold it). */
  effects: Array<{ kind: string; state: string; tries: number; nextAt: string | null }>
  /** The current stage's instruction: its mail state, delivery, mailbox blocker, and holder. */
  instruction: { messageId: string | null; state: string; deliveredAt: string | null; blocker: string | null; holder: HolderFacts | null } | null
  /** Open cards asked from the change's task. */
  openCards: Array<{ cardId: string; addressedTo: 'lead' | 'owner'; addressedGroup: string | null }>
  /** Unresolved carried conditions holding the change (V2). */
  conditions: string[]
  memberRelease: { member: string; reason: string } | null
  slotHolder: { kind: string; id: string } | null
  candidates: Array<{ state: CandidateState; createdAt: string; decidedAt: string | null }>
  /** Result rows of the change's task (accepted by the submission check). */
  results: Array<{ createdAt: string }>
  /** The last time the monitor saw this change in a named wait (D11, in memory). */
  waitEndedAt: string | null
}

export interface ChangeSupervision {
  change: string
  outcome: SupervisionOutcome
  cause: SupervisionCause
  /** Other named waits that also apply. */
  alsoApplying: SupervisionWait[]
  stage: SupervisionStage | null
  holder: Pick<HolderFacts, 'session' | 'group' | 'profile'> | null
  progress: { kind: ProgressKind; at: string } | null
  activity: { kind: ActivityKind; at: string } | null
  stall: SupervisionStall | null
  landing: SupervisionInput['landing']
  lastRound: { id: string; number: number; outcome: RoundOutcome | null; failing: CiCheck[]; flaky: string[]; verdict: 'pass' | 'fail' | null; findingsSummary: string | null } | null
}

export const NO_PROGRESS_ATTEMPT_MS = 2 * 60 * 60 * 1000
export const NO_PROGRESS_REVIEW_MS = 60 * 60 * 1000
export const NO_PROGRESS_IDLE_MS = 15 * 60 * 1000

/** The failing checks of a round: each name whose newest run fails (a flaky name failed and then passed, so it never counts). */
export function failingChecks(checks: readonly CiCheck[] | null): CiCheck[] {
  if (!checks) return []
  // A flaky name failed and then passed, so its newest run never fails: no separate exclusion is needed.
  return [...runsByName(checks).values()].map(runs => runs.at(-1)!).filter(run => ciClass(run) === 'fail')
}

/** D11: the sorted failing check names, then `review:fail` when the review failed. */
export function failureSignature(round: Pick<SupervisionRound, 'ci' | 'verdict'>): string {
  const parts = failingChecks(round.ci).map(check => check.name).sort()
  if (round.verdict === 'fail') parts.push('review:fail')
  return parts.join(',')
}

const newest = <T extends { at: string }>(entries: Array<T | null>): T | null =>
  entries.reduce<T | null>((best, entry) => (entry !== null && (best === null || entry.at > best.at) ? entry : best), null)
const later = (...times: Array<string | null>): string | null =>
  times.reduce<string | null>((best, time) => (time !== null && (best === null || time > best) ? time : best), null)

function lastProgress(input: SupervisionInput): ChangeSupervision['progress'] {
  const at = (kind: ProgressKind, time: string | null) => (time === null ? null : { kind, at: time })
  return newest([
    ...input.results.map(result => at('result', result.createdAt)),
    ...input.rounds.map(round => at('ci-pass', round.ciPassedAt)),
    ...input.rounds.map(round => at('verdict', round.verdict === null ? null : round.verdictAt)),
    ...input.rounds.map(round => at('round-pass', round.outcome === 'pass' ? round.decidedAt : null)),
    at('landing', input.landing?.landedAt ?? null),
    ...input.candidates.map(candidate => at('candidate-pass', candidate.state === 'passed' || candidate.state === 'landed' ? candidate.decidedAt : null)),
  ])
}

function lastActivity(holder: HolderFacts | null, now: Date): ChangeSupervision['activity'] {
  if (holder === null) return null
  if (holder.turnRunning) return { kind: 'live-turn', at: now.toISOString() }
  return newest([
    holder.lastTurnEndAt === null ? null : { kind: 'turn' as const, at: holder.lastTurnEndAt },
    holder.lastTaskMailAt === null ? null : { kind: 'mail' as const, at: holder.lastTaskMailAt },
  ])
}

/** D11: the two newest decided rounds, superseded skipped and a carried round standing in for its source. */
function repeatingFailure(rounds: readonly SupervisionRound[]): SupervisionStall | null {
  const decided = rounds.filter(round => round.outcome === 'pass' || round.outcome === 'fail')
  const carried = new Set(decided.map(round => round.carriedFrom).filter((id): id is string => id !== null))
  const chain = decided.filter(round => !carried.has(round.id)).sort((a, b) => a.number - b.number)
  const [first, second] = chain.slice(-2)
  if (!first || !second || first.outcome !== 'fail' || second.outcome !== 'fail') return null
  const signature = failureSignature(second)
  if (signature !== failureSignature(first)) return null
  return { kind: 'repeating-failure', episodeKey: second.id, signature, rounds: [first.id, second.id] }
}

/** D10's ten running-stage waits, in order; every applicable one. */
function stageWaits(input: SupervisionInput, now: Date): SupervisionWait[] {
  const waits: SupervisionWait[] = []
  const nowIso = now.toISOString()
  for (const effect of input.effects) {
    if (effect.state === 'pending' || effect.state === 'running' || effect.state === 'unknown') {
      waits.push({ kind: 'effect', effect: effect.kind, state: effect.state, tries: effect.tries, nextAt: effect.nextAt })
      break
    }
  }
  const instruction = input.instruction
  const holder = instruction?.holder ?? null
  if (instruction?.state === 'uncertain') waits.push({ kind: 'uncertain-delivery', messageId: instruction.messageId })
  if (instruction && ['queued', 'spawning', 'awaiting-request'].includes(instruction.state)) waits.push({ kind: 'staffing', blocker: instruction.blocker })
  const parkedUntil = holder?.parkedUntil ?? null
  if (instruction?.state === 'parked' || (parkedUntil !== null && parkedUntil > nowIso)) {
    waits.push({ kind: 'parked', session: holder?.session ?? null, profile: holder?.profile ?? null, until: parkedUntil, cooling: false })
  } else if (holder?.coolingUntil && holder.coolingUntil > nowIso) {
    waits.push({ kind: 'parked', session: holder.session, profile: holder.profile, until: holder.coolingUntil, cooling: true })
  }
  if (holder?.pendingRequest) waits.push({ kind: 'request', session: holder.session, request: holder.pendingRequest })
  const card = input.openCards[0]
  if (card) waits.push({ kind: 'decision-card', ...card })
  if (input.step === 'awaiting-ci') {
    const checks = input.rounds.slice().sort((a, b) => a.number - b.number).at(-1)?.ci ?? []
    waits.push({ kind: 'ci', pending: [...runsByName(checks).values()].map(runs => runs.at(-1)!).filter(run => ciClass(run) === 'pending').map(run => run.name) })
  }
  if (input.step === 'releasing' && input.memberRelease) waits.push({ kind: 'member-release', ...input.memberRelease })
  if (input.step === 'conditions' && input.conditions.length > 0) waits.push({ kind: 'condition', conditions: input.conditions })
  if (input.step === 'awaiting-slot') waits.push({ kind: 'landing-slot', holderKind: input.slotHolder?.kind ?? null, holderId: input.slotHolder?.id ?? null })
  return waits
}

function holderIdle(holder: HolderFacts): boolean {
  if (holder.gone) return true
  return !holder.turnRunning && holder.pendingRequest === null && holder.backgroundTasks === 0 && holder.workers === 0 && !holder.dueDirectMail
}

function noProgress(input: SupervisionInput, stage: SupervisionStage, progressAt: string | null, now: Date): SupervisionStall | null {
  const instruction = input.instruction
  if (stage === 'kawai' || !instruction?.deliveredAt) return null
  const episodeKey = later(instruction.deliveredAt, progressAt)!
  const anchorAt = later(episodeKey, input.waitEndedAt)!
  let deadline = Date.parse(anchorAt) + (stage === 'review' ? NO_PROGRESS_REVIEW_MS : NO_PROGRESS_ATTEMPT_MS)
  const holder = instruction.holder
  const idle = holder !== null && holderIdle(holder)
  if (idle) deadline = Math.min(deadline, Date.parse(later(anchorAt, holder.lastTurnEndAt)!) + NO_PROGRESS_IDLE_MS)
  if (now.getTime() < deadline) return null
  return { kind: 'no-progress', episodeKey, anchorAt, deadlineAt: new Date(deadline).toISOString(), idle }
}

function stageOf(input: SupervisionInput): SupervisionStage {
  if (input.state === 'implementing') return input.attempt?.kind ?? 'implement'
  if (input.state === 'gating' && input.step === 'reviewing') return 'review'
  return 'kawai'
}

/**
 * D10's outcome, first match wins: landed, cancelled, stopped, waiting before
 * provisioning, a `repeating-failure` stall (whatever the change waits on),
 * then the running stages — the first named wait, else a `no-progress` stall
 * for an agent-held stage, else running.
 */
export function changeSupervision(input: SupervisionInput, now: Date): ChangeSupervision {
  const progress = lastProgress(input)
  const holderFacts = input.instruction?.holder ?? null
  const sorted = input.rounds.slice().sort((a, b) => a.number - b.number)
  const round = sorted.at(-1)
  const base: Omit<ChangeSupervision, 'outcome' | 'cause'> = {
    change: input.change,
    alsoApplying: [],
    stage: null,
    holder: holderFacts === null ? null : { session: holderFacts.session, group: holderFacts.group, profile: holderFacts.profile },
    progress,
    activity: lastActivity(holderFacts, now),
    stall: null,
    landing: input.landing,
    lastRound: round === undefined ? null : {
      id: round.id,
      number: round.number,
      outcome: round.outcome,
      failing: failingChecks(round.ci),
      flaky: round.ci ? flakyChecks(round.ci) : [],
      verdict: round.verdict,
      findingsSummary: round.findingsSummary,
    },
  }
  if (input.landing) return { ...base, outcome: 'landed', cause: { kind: 'landed', treeVerified: input.landing.treeVerified } }
  if (input.state === null) return { ...base, outcome: 'not-started', cause: { kind: 'not-started' } }
  if (input.state === 'cancelled') return { ...base, outcome: 'cancelled', cause: { kind: 'cancelled' } }
  if (input.state === 'stopped') return { ...base, outcome: 'stopped', cause: { kind: 'stopped', reason: input.stopReason ?? 'unknown', detail: input.stopDetail } }
  if (input.state === 'waiting') {
    const unlanded = input.dependencies.filter(dependency => dependency.outcome !== 'landed')
    const waits: SupervisionWait[] = []
    if (unlanded.length > 0) {
      waits.push({ kind: 'dependency', changes: unlanded.map(entry => entry.change), stopped: unlanded.filter(entry => entry.outcome === 'stopped').map(entry => entry.change) })
    }
    const effect = stageWaits({ ...input, instruction: null, openCards: [], step: null }, now)[0]
    if (effect) waits.push(effect)
    if (waits.length === 0) waits.push({ kind: 'parallel-limit', limit: input.parallelLimit })
    return { ...base, outcome: 'waiting', cause: waits[0]!, alsoApplying: waits.slice(1) }
  }
  const stage = stageOf(input)
  const waits = stageWaits(input, now)
  const repeating = repeatingFailure(input.rounds)
  if (repeating) return { ...base, stage, outcome: 'stalled', cause: { kind: 'stall', stall: repeating.kind }, alsoApplying: waits, stall: repeating }
  if (waits.length > 0) return { ...base, stage, outcome: 'waiting', cause: waits[0]!, alsoApplying: waits.slice(1) }
  const stall = noProgress(input, stage, progress?.at ?? null, now)
  if (stall) return { ...base, stage, outcome: 'stalled', cause: { kind: 'stall', stall: stall.kind }, stall }
  return { ...base, stage, outcome: 'running', cause: { kind: 'stage', stage, step: input.step } }
}

/** D12: stop reasons as the report names them; an unknown reason reads verbatim. */
export const SUPERVISION_STOP_LABELS: Record<string, string> = {
  'round-limit': 'Failed 3 fix rounds',
  'name-taken': 'Branch or worktree name taken',
  'instruction-failed': 'Instruction not delivered',
  'task-closed': 'Task closed by hand',
  'review-unavailable': 'An author claimed the review',
  'effect-failed': 'An external step failed',
  'effect-unknown': "An external step's outcome is unknown",
  'ci-missing': 'CI checks missing',
  'ci-timeout': 'CI did not finish in time',
  'pr-closed': 'Pull request closed',
  'integration-rewritten': 'Integration branch rewritten',
}

export const stopReasonLabel = (reason: string): string => (Object.hasOwn(SUPERVISION_STOP_LABELS, reason) ? SUPERVISION_STOP_LABELS[reason]! : reason)

const list = (items: readonly string[]) => items.join(', ')

/** One line per cause; an unknown kind renders its kind verbatim (D10). */
export function causeLabel(cause: SupervisionCause | { kind: string }): string {
  const known = cause as SupervisionCause
  switch (known.kind) {
    case 'landed': return known.treeVerified ? 'Landed' : 'Landed (tree not verified)'
    case 'stopped': return `Stopped: ${stopReasonLabel(known.reason)}`
    case 'cancelled': return 'Cancelled'
    case 'not-started': return 'Not started'
    case 'stage': return known.stage === 'kawai' ? 'Running: Kawai is working' : `Running: ${known.stage}`
    case 'stall': return known.stall === 'no-progress' ? 'Stalled: no progress' : 'Stalled: repeating failure'
    case 'dependency': return known.stopped.length > 0 ? `Blocked by stopped ${list(known.stopped)}` : `Waiting on ${list(known.changes)}`
    case 'parallel-limit': return known.limit === null ? 'Waiting for a parallel slot' : `Waiting for a parallel slot (limit ${known.limit})`
    case 'effect': return `Waiting on Kawai's ${known.effect} (${known.state}, try ${known.tries}${known.nextAt ? `, next ${known.nextAt}` : ''})`
    case 'uncertain-delivery': return 'Waiting on an uncertain delivery'
    case 'staffing': return known.blocker ? `Waiting for staffing: ${known.blocker}` : 'Waiting for staffing'
    case 'parked': return `${known.cooling ? 'Profile cooling' : 'Holder parked'}${known.until ? ` until ${known.until}` : ''}`
    case 'request': return `Waiting on ${known.session}'s pending ${known.request}`
    case 'decision-card': return `Waiting on decision card ${known.cardId} (${known.addressedTo === 'lead' ? known.addressedGroup ?? 'lead' : 'the owner'})`
    case 'ci': return known.pending.length > 0 ? `Waiting for CI: ${list(known.pending)}` : 'Waiting for CI checks to appear'
    case 'member-release': return `Waiting for ${known.member} to be released: ${known.reason}`
    case 'condition': return `Waiting for acceptance conditions: ${list(known.conditions)}`
    case 'landing-slot': return known.holderId ? `Waiting for the landing slot, held by ${known.holderKind ?? 'holder'} ${known.holderId}` : 'Waiting for the landing slot'
    default: return String((cause as { kind: string }).kind)
  }
}

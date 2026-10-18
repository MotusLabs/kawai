// Pure round counting and plan progress for executed plans (plan-execution
// design D12, D17, contracts X1 and X8). `fixRoundOutcome` is the one rule
// for the consecutive failed fix-round count; `executionProgress` replaces
// durable-plans' linked-task `planProgress` for any plan with an execution:
// landing facts alone say landed, and every other change shows its state in
// the newest execution with what it waits on or why it stopped.
import type { PlanContent } from './plans'
import type {
  ChangeState,
  ChangeStep,
  ExecutionChangeView,
  LandingFactView,
  PlanExecutionView,
  RoundOutcome,
  StopDetail,
  StopReason,
  WaitingReason,
} from './planExecution'

/** Three consecutive failed fix rounds stop the change (D12). */
export const ROUND_LIMIT = 3

/** A decided round as the count reads it. */
export interface CountedRound {
  /** True for a fix or update attempt's round; a carried round keeps its source's value. */
  fixRound: boolean
  outcome: RoundOutcome
  /** A round that ended in a CI stop (`ci-missing`, `ci-timeout`) never counts. */
  ciStop?: boolean
}

/**
 * D12: a failed fix round raises the count and stops the change at the
 * limit; a pass resets it; the implementation round, superseded rounds, and
 * CI stops leave it unchanged. Retry resets it separately.
 */
export function fixRoundOutcome(count: number, round: CountedRound): { count: number; stop: boolean } {
  if (round.ciStop || round.outcome === 'superseded') return { count, stop: false }
  if (round.outcome === 'pass') return { count: 0, stop: false }
  if (!round.fixRound) return { count, stop: false }
  const next = count + 1
  return { count: next, stop: next >= ROUND_LIMIT }
}

export const CHANGE_STATE_LABELS: Record<ChangeState, string> = {
  waiting: 'Waiting',
  provisioning: 'Provisioning',
  implementing: 'Implementing',
  gating: 'Gating',
  landing: 'Landing',
  landed: 'Landed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
}

export const CHANGE_STEP_LABELS: Record<ChangeStep, string> = {
  pushing: 'pushing the branch',
  'opening-pr': 'opening the pull request',
  'awaiting-ci': 'waiting for CI',
  releasing: 'releasing the worktree for review',
  reviewing: 'in review',
  conditions: 'waiting for acceptance conditions',
  'awaiting-slot': 'waiting for the landing slot',
  'up-to-date': 'bringing the branch up to date',
  updating: 'updating the branch from its base',
  merging: 'merging',
  redispatch: 'sending the instruction again',
}

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  'round-limit': 'three failed fix rounds',
  'name-taken': 'the branch or worktree name is taken',
  'instruction-failed': 'the instruction was not delivered',
  'task-closed': 'the task was closed by hand',
  'review-unavailable': 'an author claimed the review',
  'effect-failed': 'an external step failed',
  'effect-unknown': "an external step's outcome is unknown",
  'ci-missing': 'CI checks are missing',
  'ci-timeout': 'CI did not finish in time',
  'pr-closed': 'the pull request was closed',
}

const list = (items: readonly string[]) => items.join(', ')

/** The sentence a waiting reason renders as, never "idle". */
export function waitingLabel(reason: WaitingReason): string {
  switch (reason.kind) {
    case 'dependency': return `waits on ${list(reason.changes)} to land`
    case 'parallel-limit': return `waits for a free slot (at most ${reason.limit} changes in progress)`
    case 'effect': return reason.nextAt
      ? `waits to retry ${reason.effect} at ${reason.nextAt}`
      : `waits for ${reason.effect} (${reason.state})`
    case 'instruction': return `instruction ${reason.state}${reason.holder ? ` with ${reason.holder}` : ''}`
    case 'ci': return reason.pending.length > 0 ? `waits for CI: ${list(reason.pending)}` : 'waits for CI checks to appear'
    case 'release': return `waits for ${reason.member} to be released: ${reason.reason}`
    case 'review': return reason.claimant ? `waits for the review by ${reason.claimant}` : 'waits for a reviewer to claim the review'
    case 'conditions': return `waits for acceptance conditions: ${list(reason.conditions)}`
    case 'slot': return reason.holder ? `waits for the landing slot, held by ${reason.holder}` : 'waits for the landing slot'
    case 'merge': return 'waits for the merge to settle'
    default: {
      const never: never = reason
      return String(never)
    }
  }
}

/** A stop's sentence: its reason plus what the detail names. */
export function stopLabel(reason: StopReason, detail: StopDetail | null): string {
  const named = [
    detail?.effect,
    detail?.session,
    detail?.checks && list(detail.checks),
    detail?.files && list(detail.files),
    detail?.names && list(detail.names),
  ].filter((part): part is string => Boolean(part))
  return `stopped as ${reason}: ${STOP_REASON_LABELS[reason]}${named.length > 0 ? ` (${named.join('; ')})` : ''}`
}

export type ProgressStatus = 'landed' | 'not-started' | Exclude<ChangeState, 'landed'>

export interface ExecutionProgressEntry {
  change: string
  status: ProgressStatus
  step: ChangeStep | null
  waiting: WaitingReason | null
  stopReason: StopReason | null
  stopDetail: StopDetail | null
  landing: LandingFactView | null
  label: string
}

function entryLabel(entry: Omit<ExecutionProgressEntry, 'label'>): string {
  if (entry.status === 'landed') return 'Landed'
  if (entry.status === 'not-started') return 'Not started'
  if (entry.status === 'stopped' && entry.stopReason) return `Stopped — ${stopLabel(entry.stopReason, entry.stopDetail)}`
  const head = CHANGE_STATE_LABELS[entry.status]
  const step = entry.step ? `: ${CHANGE_STEP_LABELS[entry.step]}` : ''
  return `${head}${step}${entry.waiting ? ` — ${waitingLabel(entry.waiting)}` : ''}`
}

/**
 * D17. Per change of `content`, in order: a landing fact says landed (a done
 * task without one never does); otherwise the newest execution's row gives
 * the state, and a waiting row without a stored reason waits on its
 * dependencies that have no landing fact. A change the execution lacks is
 * not started.
 */
export function executionProgress(
  content: PlanContent,
  landings: readonly LandingFactView[],
  newest: PlanExecutionView | null,
): ExecutionProgressEntry[] {
  const landed = new Map(landings.map(fact => [fact.change, fact]))
  const rows = new Map<string, ExecutionChangeView>((newest?.changes ?? []).map(row => [row.change, row]))
  return content.changes.map(change => {
    const landing = landed.get(change.change) ?? null
    const row = rows.get(change.change)
    const status: ProgressStatus = landing
      ? 'landed'
      : !row ? 'not-started' : row.state === 'landed' ? 'landing' : row.state
    const pendingDeps = change.dependsOn.filter(dependency => !landed.has(dependency))
    const waiting = landing ? null
      : row?.waiting ?? (status === 'waiting' && pendingDeps.length > 0 ? { kind: 'dependency' as const, changes: pendingDeps } : null)
    const entry = {
      change: change.change,
      status,
      step: landing ? null : row?.step ?? null,
      waiting,
      stopReason: landing ? null : row?.stopReason ?? null,
      stopDetail: landing ? null : row?.stopDetail ?? null,
      landing,
    }
    return { ...entry, label: entryLabel(entry) }
  })
}

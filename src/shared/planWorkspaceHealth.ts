// D5's passive-health derivation (plan-workspace 3.3): pure and shared, so
// the server composes nothing here and §5's client clock recomputes
// freshness from the same code (design D5: recompute freshness on a client
// clock at least once a minute).
//
// Display thresholds (UI policy, approximate — never a model guarantee):
// context below 70% is green, 70% to below 90% yellow, 90% and above red.
// A quota reading is yellow at `warning`, or a known window at 80% to below
// 100%; red at `limited`, or a window at 100%; green only when `ok` below
// both with a window reported — a windowless `ok` never counts toward
// green.
//
// Freshness policy: a reading is fresh while its age is at most
// FRESH_MS (15 minutes) and stale — unknown — once older; a quota whose
// reset has passed (resetsAt ≤ now, equality included) reads unknown until
// a replacement arrives; a disconnected workspace's readings are unknown
// regardless of age.
//
// The combined dot: a known red wins, then a known yellow; green requires
// fresh green context AND an applicable quota reading; everything else is
// unknown (rendered gray). A reading excluded from aggregation — a host
// account's allowance behind a gateway provider, or unconfirmed routing —
// stays inspectable whole and contributes unknown to the dot. The dot never
// predicts failure or controls dispatch; partial facts always ride the
// readings for the popover.
import type {
  WorkspaceAgentHealth, WorkspaceContextReading, WorkspaceHealthLevel,
  WorkspaceQuotaReading,
} from './planWorkspace'

/** Display thresholds are approximate (D5); the popover renders the raw share. */
export const CONTEXT_GREEN_BELOW = 0.7
export const CONTEXT_YELLOW_BELOW = 0.9
export const QUOTA_YELLOW_BELOW = 0.8
/** Fresh while age ≤ FRESH_MS; stale (unknown) when older. */
export const FRESH_MS = 15 * 60 * 1000

/** One reading's own level; the combined dot is derived from both. */
export type ReadingLevel = 'green' | 'yellow' | 'red' | 'unknown'

const stale = (measuredAt: string | null, now: Date): boolean => {
  if (measuredAt === null) return true
  const at = Date.parse(measuredAt)
  return !Number.isFinite(at) || now.getTime() - at > FRESH_MS
}

const share = (used: number | null): number | null =>
  used !== null && Number.isFinite(used) ? used : null

/** One context reading's level: the 70/90 bands; unknown when missing or stale. */
export function contextLevelOf(reading: WorkspaceContextReading | null, now: Date): ReadingLevel {
  if (reading === null || stale(reading.measuredAt, now)) return 'unknown'
  const used = share(reading.used)
  if (used === null) return 'unknown'
  if (used < CONTEXT_GREEN_BELOW) return 'green'
  if (used < CONTEXT_YELLOW_BELOW) return 'yellow'
  return 'red'
}

/**
 * One quota reading's level: the status decides first (`warning` yellow,
 * `limited` red), then the reported window's bands; unknown when missing,
 * stale, reset-passed, or a windowless `ok`.
 */
export function quotaLevelOf(reading: WorkspaceQuotaReading | null, now: Date): ReadingLevel {
  if (reading === null || stale(reading.measuredAt, now)) return 'unknown'
  if (reading.resetsAt !== null) {
    const reset = Date.parse(reading.resetsAt)
    if (Number.isFinite(reset) && reset <= now.getTime()) return 'unknown'
  }
  if (reading.status === 'warning') return 'yellow'
  if (reading.status === 'limited') return 'red'
  const used = share(reading.used)
  if (used === null) return 'unknown'
  if (used < QUOTA_YELLOW_BELOW) return 'green'
  if (used < 1) return 'yellow'
  return 'red'
}

/** The combined dot from the two reading levels: red wins, then yellow; green needs an applicable quota. */
export function combinedLevelOf(context: ReadingLevel, quota: ReadingLevel, quotaApplicable: boolean): WorkspaceHealthLevel {
  // An excluded reading contributes unknown to the dot (D5): kept whole for
  // inspection, never aggregated into it.
  const effective = quotaApplicable ? quota : 'unknown'
  if (context === 'red' || effective === 'red') return 'red'
  if (context === 'yellow' || effective === 'yellow') return 'yellow'
  if (context === 'green' && effective === 'green') return 'green'
  return 'unknown'
}

export interface WorkspaceHealthInput {
  context: WorkspaceContextReading | null
  quota: WorkspaceQuotaReading | null
  quotaApplicable: boolean
  /** A disconnected workspace's readings are unknown regardless of age (D5). */
  connected: boolean
}

/** One agent's health (D5): the combined dot plus both readings, kept whole for inspection. */
export function workspaceHealthOf(input: WorkspaceHealthInput, now: Date): WorkspaceAgentHealth {
  if (!input.connected) return { level: 'unknown', context: input.context, quota: input.quota }
  return {
    level: combinedLevelOf(contextLevelOf(input.context, now), quotaLevelOf(input.quota, now), input.quotaApplicable),
    context: input.context,
    quota: input.quota,
  }
}

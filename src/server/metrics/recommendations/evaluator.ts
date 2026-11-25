// The incident advice evaluator (process-quota-history-and-incident-advice
// D4/D5, Tables E and R): pure. It takes the routing facts frozen at the
// incident (the snapshot), the quota history and limit events, and a cutoff,
// and returns the advice, the evidence summaries it used, and the evidence
// hash that decides whether the advice materially changed (R2).
//
// Table E, per candidate worker of the incident's group:
// - E2: a candidate on the limited provider, on the same effective account,
//   or detected sharing its login is excluded — switching to it restores
//   nothing (shared window). A context incident (E8) never excludes this way:
//   the provider is not exhausted, the conversation is.
// - E3: cooling at the cutoff (`cooldownFor` as frozen) is excluded.
// - E4: a hard worker choice or a cross-model review restriction is excluded
//   naming it.
// - E5: a reached cap, or an occupied writer slot when the work needs the
//   writer, is excluded naming it (release or hand off first).
// - E1/E6: every other candidate is listed; its headroom is `known` only with
//   Table F row F1 evidence at the cutoff, else unknown, and no numeric saving
//   is ever given (`savingsMs` null).
// - E7: only evidence at or before the cutoff is read; later evidence makes a
//   later assessment, never a rewrite.
import { createHash } from 'node:crypto'
import type {
  AdviceChoice, AssessmentState, EvidenceSummary, ExclusionKind, FrozenAlternative, ProcessAdvice, RecommendationKind,
} from '../../../shared/processRecommendations'
import { headroomEvidence, type HeadroomLimit } from '../observations/headroom'
import type { QuotaObservation } from '../observations/quotaObservations'

export const EVALUATOR_VERSION = 'incident-advice-1'
/** The statistical metrics' sample threshold (team-process-metrics: n below 10 is insufficient). */
export const SAMPLE_THRESHOLD = 10

/** One candidate worker as routing saw it at the incident. */
export interface IncidentCandidate {
  profileId: string
  providerId: string
  /** Its effective account's scope in the process that froze it (B12); null when unresolved. */
  accountScope: string | null
  cooldownUntil: string | null
  cap: number | null
  live: number
  sharesLoginWith: string[]
  restriction: { kind: 'worker-choice' | 'review-restriction'; detail: string } | null
}

/** The routing facts frozen at the incident (`process_recommendations.snapshot_json`). */
export interface IncidentSnapshot {
  version: 1
  limited: {
    profileId: string
    providerId: string
    accountScope: string | null
    window: string | null
    resetsAt: string | null
    cooldownUntil: string | null
  }
  group: { id: string; max: number; live: number } | null
  candidates: IncidentCandidate[]
  writer: { required: boolean; occupants: string[] }
}

export interface EvaluationInput {
  kind: RecommendationKind
  snapshot: IncidentSnapshot
  /** Epoch ms; nothing after it is read. */
  cutoff: number
  /** The team's quota observations (any time; filtered to the cutoff here). */
  observations: QuotaObservation[]
  limits: Array<HeadroomLimit & { id: string }>
  /** Whether the incident is still in force at the cutoff (cooldown running, context still flagged). */
  open: boolean
  /** Earlier observed comparisons (successful handoffs) of the team. */
  comparisons: number
}

export interface Evaluation {
  advice: ProcessAdvice
  evidence: Array<Omit<EvidenceSummary, 'expired'>>
  evidenceHash: string
  /** Orders evaluations by the evidence they saw: a stale replay never becomes the latest. */
  sourcePosition: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b)

function exclusionOf(
  kind: RecommendationKind, snapshot: IncidentSnapshot, candidate: IncidentCandidate, cutoff: number
): { kind: ExclusionKind; detail: string } | null {
  const { limited } = snapshot
  if (kind === 'quota') {
    if (candidate.providerId === limited.providerId) {
      return { kind: 'shared-window', detail: `same provider ${limited.providerId}: its models share the limited allowance` }
    }
    if (candidate.accountScope !== null && candidate.accountScope === limited.accountScope) {
      return { kind: 'shared-window', detail: `same account as ${limited.providerId}` }
    }
    if (candidate.sharesLoginWith.includes(limited.providerId)) {
      return { kind: 'shared-window', detail: `draws on the same login as ${limited.providerId}` }
    }
  }
  if (candidate.cooldownUntil !== null && Date.parse(candidate.cooldownUntil) > cutoff) {
    return { kind: 'cooling', detail: `cooling until ${candidate.cooldownUntil}` }
  }
  if (candidate.restriction) return { kind: candidate.restriction.kind, detail: candidate.restriction.detail }
  if (candidate.cap !== null && candidate.live >= candidate.cap) {
    return { kind: 'profile-cap', detail: `${candidate.live} of ${candidate.cap} live on ${candidate.profileId}` }
  }
  if (snapshot.group && snapshot.group.live >= snapshot.group.max) {
    return { kind: 'group-cap', detail: `${snapshot.group.live} of ${snapshot.group.max} live in ${snapshot.group.id}` }
  }
  if (snapshot.writer.required && snapshot.writer.occupants.length > 0) {
    return { kind: 'writer-slot', detail: `the writer slot is held by ${snapshot.writer.occupants.join(', ')}: release or hand off first` }
  }
  return null
}

export function evaluateIncident(input: EvaluationInput): Evaluation {
  const { kind, snapshot, cutoff } = input
  const observations = input.observations.filter(row => Date.parse(row.observedAt) <= cutoff)
  const limits = input.limits.filter(limit => Date.parse(limit.at) <= cutoff)
  const evidence: Array<Omit<EvidenceSummary, 'expired' | 'ordinal'>> = []
  const cited = new Set<string>()
  const cite = (row: QuotaObservation) => {
    if (cited.has(row.id)) return
    cited.add(row.id)
    evidence.push({
      kind: 'observation', observationId: row.id, providerId: row.providerId, accountAlias: row.accountAlias,
      outcome: row.outcome, at: row.observedAt,
      windows: row.windows.map(window => ({ key: window.key, percentUsed: window.percentUsed, resetsAt: window.resetsAt })),
    })
  }
  for (const limit of limits.filter(limit => limit.final && limit.providerId === snapshot.limited.providerId)) {
    evidence.push({ kind: 'limit', observationId: null, providerId: snapshot.limited.providerId, accountAlias: null, outcome: 'limit', at: limit.at, windows: [] })
  }
  // The incident's own profile is an alternative only for a context incident (a fresh session on it).
  const candidates = snapshot.candidates.filter(candidate => kind === 'context' || candidate.profileId !== snapshot.limited.profileId)
  const alternatives: FrozenAlternative[] = candidates.map((candidate) => {
    const exclusion = exclusionOf(kind, snapshot, candidate, cutoff)
    const headroom = headroomEvidence({ providerId: candidate.providerId, accountScope: candidate.accountScope, cutoff, observations, limits })
    const source = headroom.observationId ? observations.find(row => row.id === headroom.observationId) : undefined
    if (source && !exclusion) cite(source)
    return {
      profileId: candidate.profileId, providerId: candidate.providerId, listed: exclusion === null, exclusion,
      headroom: !exclusion && headroom.valid ? 'known' : 'unknown', headroomReason: headroom.reason,
      observationId: headroom.observationId,
      windows: headroom.windows.map(window => ({ key: window.key, percentUsed: window.percentUsed, resetsAt: window.resetsAt, ageMs: window.ageMs })),
    }
  })
  const listed = alternatives.filter(alternative => alternative.listed)
  const known = listed.filter(alternative => alternative.headroom === 'known')
  const waitUntil = later(snapshot.limited.resetsAt, snapshot.limited.cooldownUntil)
  const choice: AdviceChoice = !input.open ? 'resolved'
    : kind === 'context' ? 'fresh-context'
    : known.length > 0 ? 'switch'
    : listed.length === 0 && waitUntil !== null ? 'wait'
    : 'no-alternative'
  const facts: string[] = [], assumptions: string[] = [], unknowns: string[] = []
  if (kind === 'quota') facts.push(`${snapshot.limited.profileId} on ${snapshot.limited.providerId} hit a final limit${snapshot.limited.window ? ` (${snapshot.limited.window})` : ''}.`)
  else facts.push(`${snapshot.limited.profileId} exhausted its context; its provider's allowance is not exhausted by this.`)
  for (const alternative of known) facts.push(`${alternative.profileId} on ${alternative.providerId} showed room within the last 10 minutes.`)
  for (const alternative of listed.filter(entry => entry.headroom === 'unknown')) {
    unknowns.push(`${alternative.profileId} on ${alternative.providerId}: capacity unknown (${alternative.headroomReason}).`)
  }
  for (const alternative of alternatives.filter(entry => entry.exclusion)) facts.push(`${alternative.profileId} excluded: ${alternative.exclusion!.detail}.`)
  unknowns.push('Handoff, context rebuilding, execution and rework costs are unknown, so no saving is estimated.')
  if (waitUntil === null && kind === 'quota') unknowns.push('The limited window gave no reset time.')
  assumptions.push('Routing facts are as they stood at the incident; later configuration is not substituted.')
  const small = input.comparisons < SAMPLE_THRESHOLD
  if (small) assumptions.push(`Only ${input.comparisons} earlier comparison${input.comparisons === 1 ? '' : 's'} observed: the comparative metric stays insufficient.`)
  const summary = choice === 'resolved' ? 'The incident is over.'
    : choice === 'fresh-context' ? 'Recover context: compact or hand off to a fresh session; the account still has its allowance.'
    : choice === 'switch' ? `Provisional: ${known.map(entry => entry.profileId).join(', ')} showed fresh capacity; switching may beat waiting${waitUntil ? ` until ${waitUntil}` : ''}.`
    : choice === 'wait' ? `No alternative is eligible; wait until ${waitUntil}.`
    : 'No eligible alternative has known capacity; switching is not shown as available.'
  const advice: ProcessAdvice = {
    choice, provisional: true, summary, facts, assumptions, unknowns, alternatives,
    comparison: {
      wait: { until: waitUntil, basis: snapshot.limited.resetsAt ? 'reset' : snapshot.limited.cooldownUntil ? 'cooldown' : 'unknown' },
      switchCosts: { handoff: 'unknown', contextRebuild: 'unknown', execution: 'unknown', rework: 'unknown' },
      savingsMs: null,
    },
    sample: { comparisons: input.comparisons, threshold: SAMPLE_THRESHOLD, small },
  }
  const ordered = evidence.sort((a, b) => a.at.localeCompare(b.at) || (a.observationId ?? '').localeCompare(b.observationId ?? ''))
  const summaries = ordered.map((entry, ordinal) => ({ ...entry, ordinal }))
  // The hash covers what the advice rests on — ordered sources and each
  // alternative's standing — not ages, so time passing alone changes nothing
  // until a window turns stale (which changes its standing).
  const evidenceHash = createHash('sha256').update(canonical({
    evaluator: EVALUATOR_VERSION, choice, sources: summaries.map(entry => [entry.kind, entry.observationId, entry.at]),
    alternatives: alternatives.map(entry => [entry.profileId, entry.listed, entry.exclusion?.kind ?? null, entry.headroom, entry.headroomReason, entry.observationId]),
    comparisons: input.comparisons,
  })).digest('hex')
  const newest = [...observations.map(row => row.recordedAt), ...limits.map(limit => limit.at)].sort().at(-1) ?? ''
  const sourcePosition = `${newest}|${String(observations.length + limits.length).padStart(8, '0')}`
  return { advice, evidence: summaries, evidenceHash, sourcePosition }
}

/** The state an assessment records relative to the previous one. */
export function assessmentState(previous: ProcessAdvice | null, next: ProcessAdvice): AssessmentState {
  if (!previous) return next.choice === 'resolved' ? 'resolved' : 'new'
  if (next.choice === 'resolved') return 'resolved'
  if (previous.choice === 'switch' && next.choice !== 'switch') return 'withdrawn'
  const knownBefore = previous.alternatives.filter(entry => entry.headroom === 'known').length
  const knownNow = next.alternatives.filter(entry => entry.headroom === 'known').length
  if (next.choice === previous.choice && knownNow > knownBefore) return 'strengthened'
  if (next.choice === 'switch' && previous.choice !== 'switch') return 'strengthened'
  return 'revised'
}

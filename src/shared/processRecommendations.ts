// Incident advice records (process-quota-history-and-incident-advice D4–D6),
// shared by the server stores, the read-only agent tools and the Metrics
// view. A recommendation is one incident episode of a team (a final quota
// limit, or a context-exhausted flag); its assessments are immutable numbered
// versions, each with the alternatives frozen at its cutoff and the evidence
// summaries it used. Advice is always provisional here: no outcome baseline
// demonstrates a saving, and every unknown cost stays unknown (no number).
// Nothing in these records approves, applies or routes anything (X3).

export const RECOMMENDATION_KINDS = ['quota', 'context'] as const
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number]

export const ASSESSMENT_STATES = ['new', 'strengthened', 'revised', 'withdrawn', 'resolved'] as const
export type AssessmentState = (typeof ASSESSMENT_STATES)[number]

/** Why an alternative is excluded at the cutoff (Table E rows E2–E5). */
export type ExclusionKind = 'shared-window' | 'cooling' | 'worker-choice' | 'review-restriction' | 'group-cap' | 'profile-cap' | 'writer-slot'

/** What an assessment advises: switch to a listed alternative, wait, recover context, or nothing left to do. */
export type AdviceChoice = 'switch' | 'wait' | 'no-alternative' | 'fresh-context' | 'resolved'

export interface FrozenWindow {
  key: string
  percentUsed: number
  resetsAt: string | null
  /** Age at the cutoff, by the window's own observation time. */
  ageMs: number
}

export interface FrozenAlternative {
  profileId: string
  providerId: string
  listed: boolean
  exclusion: { kind: ExclusionKind; detail: string } | null
  /** `known` only for Table F row F1 evidence at the cutoff (E1); otherwise unknown (E6). */
  headroom: 'known' | 'unknown'
  /** The headroom reason (`fresh`, `stale`, `none`, `host-login`, …). */
  headroomReason: string
  observationId: string | null
  windows: FrozenWindow[]
}

export interface AdviceComparison {
  /** When waiting ends: the limited window's reset or the cooldown end; null when unknown. */
  wait: { until: string | null; basis: 'reset' | 'cooldown' | 'unknown' }
  /** Switch costs; unknown until outcome evidence exists. */
  switchCosts: { handoff: 'unknown'; contextRebuild: 'unknown'; execution: 'unknown'; rework: 'unknown' }
  /** A numeric saving is never claimed while a material cost is unknown. */
  savingsMs: null
}

export interface AdviceSample {
  /** Earlier observed comparisons (successful handoffs) the advice may draw on. */
  comparisons: number
  /** The statistical metrics' sample threshold. */
  threshold: number
  /** True below the threshold: the comparative metric stays insufficient. */
  small: boolean
}

export interface ProcessAdvice {
  choice: AdviceChoice
  /** Always true: no demonstrated baseline backs incident advice yet. */
  provisional: true
  summary: string
  facts: string[]
  assumptions: string[]
  unknowns: string[]
  alternatives: FrozenAlternative[]
  comparison: AdviceComparison
  sample: AdviceSample
}

export interface EvidenceSummary {
  ordinal: number
  kind: 'observation' | 'limit'
  /** The quota observation it summarizes; null for limit evidence. */
  observationId: string | null
  /** The detailed observation was pruned; this summary stays (R9). */
  expired: boolean
  providerId: string
  accountAlias: string | null
  outcome: string | null
  at: string
  windows: Array<{ key: string; percentUsed: number; resetsAt: string | null }>
}

export interface ProcessAssessment {
  id: string
  recommendationId: string
  version: number
  evaluatorVersion: string
  evidenceHash: string
  state: AssessmentState
  cutoff: string
  createdAt: string
  advice: ProcessAdvice
  evidence: EvidenceSummary[]
}

export interface ProcessRecommendation {
  id: string
  teamId: string
  kind: RecommendationKind
  episodeKey: string
  sessionId: string | null
  taskId: string | null
  groupId: string | null
  profileId: string | null
  providerId: string | null
  /** The existing attention item this advice attaches to (context-exhaustion or plan-stall), if any. */
  attentionId: string | null
  /** The incident time. */
  cutoff: string
  /** `reconstructed` when the incident's routing facts were rebuilt at startup. */
  snapshotBasis: 'incident' | 'reconstructed'
  createdAt: string
  current: ProcessAssessment | null
  versions: number
}

export interface ProcessRecommendationDetail extends ProcessRecommendation {
  /** Every assessment, oldest first. */
  assessments: ProcessAssessment[]
}

export const ADVICE_CHOICE_LABELS: Record<AdviceChoice, string> = {
  switch: 'Switch to an alternative',
  wait: 'Wait for the reset',
  'no-alternative': 'No usable alternative',
  'fresh-context': 'Recover context',
  resolved: 'Resolved',
}

export const EXCLUSION_LABELS: Record<ExclusionKind, string> = {
  'shared-window': 'shares the limited account',
  cooling: 'cooling',
  'worker-choice': 'outside the worker choice',
  'review-restriction': 'review restriction',
  'group-cap': 'group cap reached',
  'profile-cap': 'worker cap reached',
  'writer-slot': 'writer slot occupied',
}

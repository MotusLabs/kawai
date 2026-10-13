// SDK-free product strategy records (product-strategy design D2) shared by
// server and client views. A revision's content is the structured template —
// prose sections plus ordered lists of use cases, principles/trade-offs,
// boundaries, success measures, claims, open questions, and decisions — and
// is hashed over a canonical serialization (stable key order, the `Unknown`
// sentinel preserved), so approval and CAS compare hashes instead of prose.
// Measures that are not known or agreed are the sentinel `Unknown`: nothing
// here or in the store ever invents a baseline, target, or metric (S08).

/** Sentinel for a measure value that is not known or agreed (S08). */
export const UNKNOWN = 'Unknown'
export type Unknown = typeof UNKNOWN

/** A measure's baseline/target: a known value, or the `Unknown` sentinel. */
export type StrategyMeasureValue = string

export const isUnknown = (value: StrategyMeasureValue | null | undefined): boolean => value === UNKNOWN

/** Who authored or decided: the human (through the UI) or an agent session. */
export type StrategyActor = { kind: 'human'; sessionId: null } | { kind: 'agent'; sessionId: string }

export type StrategyRevisionStatus = 'in_review' | 'approved' | 'superseded' | 'withdrawn'
export const STRATEGY_REVISION_STATUSES: readonly StrategyRevisionStatus[] = ['in_review', 'approved', 'superseded', 'withdrawn']

/** Evidence kinds a claim may carry (product-strategy spec, S08). */
export type StrategyClaimKind =
  | 'owner_preference'
  | 'explicit_user_statement'
  | 'agent_interpretation'
  | 'proposed_choice'
  | 'hypothesis'
  | 'validated_observation'
export const STRATEGY_CLAIM_KINDS: readonly StrategyClaimKind[] = [
  'owner_preference', 'explicit_user_statement', 'agent_interpretation', 'proposed_choice', 'hypothesis', 'validated_observation',
]

/** Intent before features: every field records why, not what to build. */
export interface StrategyUseCase {
  ref: string
  userOrSituation: string
  trigger: string
  wantedOutcome: string
  currentObstacle: string
  desiredExperience: string
  successSignal: string
  constraints: string
}

/** An ordered principle with the trade-off it consciously makes. */
export interface StrategyPrinciple {
  ref: string
  principle: string
  tradeoff: string
}

/** Outcome + measure with known baseline and agreed target, or `Unknown`. */
export interface StrategySuccessMeasure {
  ref: string
  outcome: string
  measure: string
  baseline: StrategyMeasureValue
  target: StrategyMeasureValue
}

/** A labeled assumption or piece of evidence (spec: claims carry a kind). */
export interface StrategyClaim {
  ref: string
  text: string
  kind: StrategyClaimKind
  /** Source reference; required when the kind is a validated observation. */
  source?: string
  /** Observation context or date, where known. */
  observedAt?: string
  limitations?: string
  /** Required validation where known. */
  requiredValidation?: string
}

/** A recorded decision with its date and rationale. */
export interface StrategyDecisionEntry {
  ref: string
  decision: string
  date?: string
  rationale?: string
}

/**
 * The default strategy template's content. Prose sections are strings where
 * `''` records an explicitly empty section; the lists carry the structure.
 * `normalizeStrategyContent` fills every field, so a stored content object
 * always has the full template (spec: absence is recorded, never guessed).
 */
export interface StrategyContent {
  purpose: string
  primaryUsers: string
  needsOutcomes: string
  productApproach: string
  useCases: StrategyUseCase[]
  principles: StrategyPrinciple[]
  boundaries: string[]
  successMeasures: StrategySuccessMeasure[]
  claims: StrategyClaim[]
  openQuestions: string[]
  decisions: StrategyDecisionEntry[]
}

export const STRATEGY_TEMPLATE_SECTIONS: ReadonlyArray<{ id: keyof StrategyContent; label: string; kind: 'prose' | 'list' }> = [
  { id: 'purpose', label: 'Purpose', kind: 'prose' },
  { id: 'primaryUsers', label: 'Primary users', kind: 'prose' },
  { id: 'needsOutcomes', label: 'Needs and outcomes', kind: 'prose' },
  { id: 'useCases', label: 'Main use cases', kind: 'list' },
  { id: 'productApproach', label: 'Product approach', kind: 'prose' },
  { id: 'principles', label: 'Principles and trade-offs', kind: 'list' },
  { id: 'boundaries', label: 'Boundaries and non-goals', kind: 'list' },
  { id: 'successMeasures', label: 'Success measures', kind: 'list' },
  { id: 'claims', label: 'Assumptions and evidence', kind: 'list' },
  { id: 'openQuestions', label: 'Open questions', kind: 'list' },
  { id: 'decisions', label: 'Decisions and revision history', kind: 'list' },
]

/** The product's record (one per product; design D1/D5). */
export interface ProductStrategy {
  id: string
  /** Human-chosen slug; unique. */
  productId: string
  title: string
  /** The human owner (single actor, design D7). */
  owner: StrategyActor
  lifecycle: 'active'
  /** The active approved revision; null until one is approved. */
  currentApprovedRevision: number | null
  /** Repository bindings: the owning team's git common dir plus its worktrees. */
  repoBindings: Array<{ root: string; kind: 'team' | 'worktree' }>
  createdAt: string
  updatedAt: string
}

/** A numbered immutable revision; content changes only by new revision. */
export interface StrategyRevision {
  revision: number
  status: StrategyRevisionStatus
  content: StrategyContent
  contentHash: string
  author: StrategyActor
  /** What a material direction change proposes to affect; null = none recorded. */
  impactProposal: string | null
  createdAt: string
}

/** A durable working draft (design D4): server-side, CAS-guarded on save. */
export interface StrategyDraft {
  draftId: string
  /** The approved revision this draft started from; null = none yet. */
  baseRevision: number | null
  author: StrategyActor
  content: StrategyContent
  contentHash: string
  impactProposal: string | null
  updatedAt: string
}

/** A human approval or withdrawal (design D3/D4); agents never write these. */
export interface StrategyDecision {
  id: string
  revision: number | null
  /** The exact content hash an approval binds; null for withdrawals. */
  contentHash: string | null
  decision: 'approve' | 'withdraw'
  rationale: string | null
  actor: StrategyActor
  approvalScope: string | null
  /** Allowed open questions with rationale, as recorded by the human. */
  openQuestions: string | null
  commandId: string
  createdAt: string
}

/** The one publication side effect (design D6): created with approval, once. */
export interface StrategyImpactReview {
  id: string
  revision: number
  contentHash: string
  commandId: string
  state: 'pending'
  createdAt: string
}

/** Evidence rows indexed per revision and claim (design D1). */
export interface StrategyEvidence {
  id: string
  revision: number
  claimRef: string
  kind: StrategyClaimKind
  sourceRef: string | null
  observedAt: string | null
  limitations: string | null
  accessScope: string | null
}

/** A full strategy read: the record with its history and working state. */
export interface StrategyDetail {
  strategy: ProductStrategy
  /** Oldest first. */
  revisions: StrategyRevision[]
  /** Oldest first by update time. */
  drafts: StrategyDraft[]
  evidence: StrategyEvidence[]
  /** Oldest first. */
  decisions: StrategyDecision[]
  /** Oldest first. */
  impactReviews: StrategyImpactReview[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const optStr = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const strArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

function refOf(entry: Record<string, unknown>, prefix: string, index: number): string {
  const ref = optStr(entry.ref)
  return ref ?? `${prefix}${index + 1}`
}

function normalizeList<T>(value: unknown, map: (entry: Record<string, unknown>, index: number) => T): T[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(map)
}

/**
 * Fill a content object into the full template: every prose section present
 * (`''` records an explicitly empty section), every list an array with
 * stable refs. Unknown fields are dropped, missing ones defaulted — the
 * stored shape is always canonical, so hashing and the UI can rely on it.
 */
export function normalizeStrategyContent(input: unknown): StrategyContent {
  const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  return {
    purpose: str(source.purpose),
    primaryUsers: str(source.primaryUsers),
    needsOutcomes: str(source.needsOutcomes),
    productApproach: str(source.productApproach),
    useCases: normalizeList(source.useCases, (entry, index) => ({
      ref: refOf(entry, 'uc', index),
      userOrSituation: str(entry.userOrSituation),
      trigger: str(entry.trigger),
      wantedOutcome: str(entry.wantedOutcome),
      currentObstacle: str(entry.currentObstacle),
      desiredExperience: str(entry.desiredExperience),
      successSignal: str(entry.successSignal),
      constraints: str(entry.constraints),
    })),
    principles: normalizeList(source.principles, (entry, index) => ({
      ref: refOf(entry, 'pr', index),
      principle: str(entry.principle),
      tradeoff: str(entry.tradeoff),
    })),
    boundaries: strArray(source.boundaries),
    successMeasures: normalizeList(source.successMeasures, (entry, index) => ({
      ref: refOf(entry, 'm', index),
      outcome: str(entry.outcome),
      measure: str(entry.measure),
      // Unknown passes through as the sentinel; a known value is stored as
      // given — nothing here invents or defaults a number (S08).
      baseline: measureValue(entry.baseline),
      target: measureValue(entry.target),
    })),
    claims: normalizeList(source.claims, (entry, index) => ({
      ref: refOf(entry, 'c', index),
      text: str(entry.text),
      kind: STRATEGY_CLAIM_KINDS.includes(entry.kind as StrategyClaimKind) ? entry.kind as StrategyClaimKind : 'hypothesis',
      source: optStr(entry.source),
      observedAt: optStr(entry.observedAt),
      limitations: optStr(entry.limitations),
      requiredValidation: optStr(entry.requiredValidation),
    })),
    openQuestions: strArray(source.openQuestions),
    decisions: normalizeList(source.decisions, (entry, index) => ({
      ref: refOf(entry, 'd', index),
      decision: str(entry.decision),
      date: optStr(entry.date),
      rationale: optStr(entry.rationale),
    })),
  }
}

function measureValue(value: unknown): StrategyMeasureValue {
  // The only values kept verbatim are non-empty strings (a known baseline,
  // an agreed target); anything else — a missing field, a number, an object —
  // reads as the `Unknown` sentinel, never as an invented value (S08).
  return typeof value === 'string' && value ? value : UNKNOWN
}

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order
 * (order is semantic), the `Unknown` sentinel preserved as itself. Design
 * D2's stable serialization — cosmetic key-order drift must not change the
 * hash, while any content difference must.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * SHA-256 of the canonical serialization (design D2). The hash is computed
 * server-side only — the client displays hashes the server sent — so
 * node:crypto is loaded through `process.getBuiltinModule`, which keeps the
 * browser bundle free of a stubbed module import instead of bundling one.
 */
export function hashStrategyContent(content: StrategyContent): string {
  const { createHash } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}

/**
 * Content-level refusals (spec): a validated observation without a source is
 * refused with an error naming the missing source. Returns every violation;
 * empty means the content may be stored.
 */
export function strategyContentErrors(content: StrategyContent): string[] {
  const errors: string[] = []
  for (const claim of content.claims) {
    if (claim.kind === 'validated_observation' && !claim.source) {
      errors.push(`Claim ${claim.ref} is a validated observation but names no source; add its source reference or label it a hypothesis.`)
    }
  }
  return errors
}

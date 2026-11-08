// Structured review findings (review-findings-ledger D1, D2): levels, classes,
// states, the citation resolver (table CR), and the mechanical gate (table
// GT). Pure and SDK-independent: the server's submission path and the
// client's rendering share it. Scope matching is injected (`matchesScope`)
// because glob matching runs on the server only (implementation-contract D6).
// The ledger fold and submission planning live in `findingsLedger.ts`.
import type { ImplementationContract } from './implementationContract'
import { clauseIdentity } from './implementationContract'
import type { ResultScopeFact } from './teamTasks'

export const FINDING_LEVELS = ['P0', 'P1', 'P2'] as const
export type FindingLevel = typeof FINDING_LEVELS[number]

export const FINDING_CLASSES = ['accepted', 'unsupported', 'advisory', 'out-of-contract'] as const
export type FindingClass = typeof FINDING_CLASSES[number]

export type FindingState = FindingClass | 'disputed' | 'rejected' | 'resolved' | 'still-open' | 'reopened' | 'superseded'

export const DISPOSITIONS = ['resolved', 'still-open', 'regressed'] as const
export type Disposition = typeof DISPOSITIONS[number]

/** Spec "Submissions are bounded" and D4 step 1. */
export const FINDING_LIMITS = {
  newFindings: 30,
  dispositions: 50,
  blocking: 50,
  evidenceChars: 4_000,
  reproductionChars: 4_000,
  impactChars: 1_000,
  citationChars: 200,
  disputes: 10,
  counterEvidenceChars: 4_000,
} as const

/** States that block a round or a derived verdict, at P0/P1 (invariant I1). */
export const BLOCKING_STATES: readonly FindingState[] = ['accepted', 'still-open', 'reopened']

export const isBlocking = (level: FindingLevel, state: FindingState): boolean =>
  level !== 'P2' && BLOCKING_STATES.includes(state)

/** The pinned revision a finding is judged against. */
export interface CitationContext {
  /** The pinned revision's identity, `r<N>#<hash12>`. */
  identity: string
  contract: ImplementationContract | null
}

export type ResolvedCitation =
  | { kind: 'clause'; clause: string; clauseId: string }
  | { kind: 'revision'; clause: string }
  | { kind: 'out'; reason: string }

const IDENTITY = /^r[1-9]\d*#[0-9a-f]{12}$/
const CLAUSE_ID = /^[AIVX][1-9]\d*$/

function contractHas(contract: ImplementationContract, id: string): boolean {
  return [contract.acceptance, contract.invariants, contract.verification, contract.excluded]
    .some(part => part.some(clause => clause.id === id))
}

/**
 * Table CR: resolve a citation before any evidence or scope check, so the
 * no-contract fallback (CR2) is never shadowed by a clause lookup. Forms: a
 * revision identity alone, an identity and a clause id joined by ` › `, or a
 * bare clause id resolved against the pinned revision (CR9).
 */
export function resolveCitation(citation: string | null | undefined, ctx: CitationContext): ResolvedCitation {
  const text = citation?.trim() ?? ''
  if (text === '') return { kind: 'out', reason: 'cites no clause' }
  let identity: string | null = null
  let id: string | null = null
  const separator = text.indexOf('›')
  if (separator >= 0) {
    identity = text.slice(0, separator).trim()
    id = text.slice(separator + 1).trim()
  } else if (IDENTITY.test(text)) identity = text
  else id = text
  if (identity !== null && !IDENTITY.test(identity)) return { kind: 'out', reason: `cites an unrecognized identity "${identity}"` }
  if (id !== null && !CLAUSE_ID.test(id)) return { kind: 'out', reason: `cites an unrecognized clause "${id}"` }
  if (identity !== null && identity !== ctx.identity) return { kind: 'out', reason: `cites the stale identity ${identity}; the result is judged under ${ctx.identity}` }
  if (id === null) {
    return ctx.contract === null
      ? { kind: 'revision', clause: ctx.identity }
      : { kind: 'out', reason: `cites the whole revision ${ctx.identity}, which has a contract; cite one of its clauses` }
  }
  if (ctx.contract === null) return { kind: 'out', reason: `cites ${id}, but revision ${ctx.identity} has no contract; cite the revision identity` }
  if (!contractHas(ctx.contract, id)) return { kind: 'out', reason: `cites ${id}, which the contract ${ctx.identity} does not have` }
  if (id.startsWith('X')) return { kind: 'out', reason: `cites the excluded clause ${id}` }
  return { kind: 'clause', clause: clauseIdentity(ctx.identity, id), clauseId: id }
}

const EVIDENCE_PATH = /(?:^|\s|\(|`)((?:\.\/)?[\w./-]+\.\w+):\d+/g

/** Every repository path cited as `file:line` in the evidence, in order, `./` stripped. */
export function evidencePaths(evidence: string | null | undefined): string[] {
  const paths: string[] = []
  for (const match of (evidence ?? '').matchAll(EVIDENCE_PATH)) {
    const path = match[1]!.replace(/^\.\//, '')
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

/** D1: the locus is the path of the evidence's first `file:line`, or '' when there is none. */
export function parseLocus(evidence: string | null | undefined): string {
  return evidencePaths(evidence)[0] ?? ''
}

export interface ScopeView {
  /** Whether a path is in scope: a glob matches it or it lies in the linked change's directory. */
  matchesScope: (path: string) => boolean
  /** The result's scope fact as read at submission; null when not yet recorded. */
  fact: ResultScopeFact | null
}

export interface GateInput {
  level: FindingLevel
  clause?: string | null
  evidence?: string | null
  impact?: string | null
}

export interface GateOutcome {
  class: FindingClass
  reason: string
  /** The resolved clause (full identity) or the whole-revision identity; null when out of contract. */
  clause: string | null
  clauseId: string | null
  locus: string
}

const present = (value: string | null | undefined): boolean => (value?.trim() ?? '') !== ''
const KNOWN: readonly string[] = ['pass', 'warn', 'fail']

/** Table GT: classify one new finding once, at submission. The rows partition the inputs. */
export function classifyFinding(input: GateInput, ctx: CitationContext, scope: ScopeView | null): GateOutcome {
  const locus = parseLocus(input.evidence)
  const citation = resolveCitation(input.clause, ctx)
  const clause = citation.kind === 'out' ? null : citation.clause
  const clauseId = citation.kind === 'clause' ? citation.clauseId : null
  const outcome = (cls: FindingClass, reason: string): GateOutcome => ({ class: cls, reason, clause, clauseId, locus })
  if (input.level === 'P2') return outcome('advisory', 'P2 is advisory and never blocks')
  if (citation.kind === 'out') return outcome('out-of-contract', citation.reason)
  if (!present(input.evidence)) return outcome('unsupported', 'missing evidence')
  if (!present(input.impact)) return outcome('unsupported', 'missing impact')
  if (citation.kind === 'revision') return outcome('accepted', 'cites the revision, which has no contract or scope')
  const paths = evidencePaths(input.evidence)
  if (paths.length === 0 || scope === null) return outcome('accepted', 'complete')
  if (paths.some(path => scope.matchesScope(path))) return outcome('accepted', 'complete, in scope')
  const fact = scope.fact
  if (fact !== null && paths.some(path => fact.outside.includes(path))) return outcome('accepted', 'complete; the result changed a cited path outside scope')
  if (fact !== null && KNOWN.includes(fact.status) && fact.more === 0) {
    return outcome('out-of-contract', `evidence names only paths outside scope that the result did not change: ${paths.join(', ')}`)
  }
  return outcome('accepted', 'complete; scope could not be judged, so the paths do not count against it')
}

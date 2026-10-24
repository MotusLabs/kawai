// Coverage maps (independent-verification design D5). A result carries the
// submitter's map: one clause per spec scenario or task verify clause, each
// citing the tests that cover it (or none, declaring it uncovered). This
// module is the map's shared, pure model: the citation grammar and limits the
// server validates at the tool boundary, and the normalization the comparison
// matches by (D6). The blind-first seal, the derived comparison, and clause
// status join here as later tasks of the change land them.
//
// A citation uses the recovery matrix's grammar, `` `path` › `title` ``: the
// file path from the repository root and the exact title of a `test` or `it`
// in it, separated by ` › ` (U+203A with spaces). Backticks delimit both
// parts, so neither may contain one; the grammar is otherwise literal.

/** One parsed citation (D5): the path relative to the repository root and the literal test title. */
export interface CoverageCitation {
  path: string
  title: string
}

/** One clause of a coverage map (D5): the clause's text, the tests cited for it, and an optional note. */
export interface CoverageClause {
  clause: string
  tests: string[]
  note?: string
}

/** A whole coverage map, as submitted, stored, and read. */
export type CoverageMap = CoverageClause[]

/** D5's input limits; malformed input is refused at submission, naming the clause index. */
export const COVERAGE_LIMITS = {
  maxClauses: 200,
  maxClauseLength: 500,
  maxCitations: 10,
  maxNoteLength: 500,
} as const

const CITATION_PATTERN = /^`([^`]+)` › `([^`]+)`$/

/**
 * Parse one citation (D5's grammar); null when it is malformed. Whitespace
 * inside the backticks must sit between characters: leading or trailing
 * space reads as a typo the submitter should fix, since resolution matches
 * the literal path and title and would silently miss otherwise.
 */
export function parseCitation(citation: string): CoverageCitation | null {
  const match = CITATION_PATTERN.exec(citation.trim())
  if (!match) return null
  const [path, title] = [match[1]!, match[2]!]
  if (path.trim() !== path || title.trim() !== title) return null
  return { path, title }
}

/**
 * Validate a submitted map (D5), returning its clauses. The first violation
 * throws, naming the 1-based clause index, so the submitter can fix the
 * clause the message names; input that is not a clause list at all refuses
 * without an index. Callers validate before writing anything, so a refused
 * submission leaves no row.
 */
export function validateCoverageMap(input: unknown): CoverageMap {
  if (!Array.isArray(input)) throw new Error('coverage must be a list of clauses')
  if (input.length > COVERAGE_LIMITS.maxClauses) {
    throw new Error(`coverage holds ${input.length} clauses; at most ${COVERAGE_LIMITS.maxClauses} are allowed`)
  }
  return input.map((row, index) => {
    const where = `coverage clause ${index + 1}`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${where} must be an object with clause and tests`)
    }
    const candidate = row as { clause?: unknown; tests?: unknown; note?: unknown }
    // D5 states only a length limit for a clause; an empty or blank clause is
    // refused anyway because it could never match a requirement and only
    // invites a silently empty comparison.
    if (typeof candidate.clause !== 'string' || candidate.clause.trim().length === 0) {
      throw new Error(`${where} needs a non-empty clause`)
    }
    if (candidate.clause.length > COVERAGE_LIMITS.maxClauseLength) {
      throw new Error(`${where} is ${candidate.clause.length} characters; at most ${COVERAGE_LIMITS.maxClauseLength} are allowed`)
    }
    if (!Array.isArray(candidate.tests)) throw new Error(`${where} needs a list of citations`)
    if (candidate.tests.length > COVERAGE_LIMITS.maxCitations) {
      throw new Error(`${where} cites ${candidate.tests.length} tests; at most ${COVERAGE_LIMITS.maxCitations} are allowed`)
    }
    for (const citation of candidate.tests) {
      if (typeof citation !== 'string' || parseCitation(citation) === null) {
        throw new Error(`${where}: ${JSON.stringify(citation ?? null)} is not a citation; use the grammar \`path\` › \`title\``)
      }
    }
    if (candidate.note !== undefined && (typeof candidate.note !== 'string' || candidate.note.length > COVERAGE_LIMITS.maxNoteLength)) {
      throw new Error(`${where}'s note must be a string of at most ${COVERAGE_LIMITS.maxNoteLength} characters`)
    }
    return candidate as CoverageClause
  })
}

/**
 * The text clauses match by (D6): trimmed, whitespace collapsed, backticks
 * dropped, case-folded.
 */
export function normalizeClause(clause: string): string {
  return clause.trim().replace(/\s+/g, ' ').replace(/`/g, '').toLowerCase()
}

/** One citation side of the comparison's key (D6): normalized path and title. */
export function normalizeCitation(citation: CoverageCitation): string {
  const path = citation.path.trim().replace(/\s+/g, ' ').replace(/`/g, '').toLowerCase()
  const title = citation.title.trim().replace(/\s+/g, ' ').replace(/`/g, '').toLowerCase()
  return `${path} › ${title}`
}

/**
 * How Kawai's check resolved one citation at the result's commit (D5):
 * exactly one of these six, assigned by the resolution paths — a miss at
 * `git show` or `testTitles` reads `not-found`; a usable test list
 * classifies the run (`ran-passed`, `not-run`, `not-in-run`); a found
 * citation with no usable list reads `run-unknown`; a result whose commit
 * is absent or unresolved reads `unresolved` for every citation.
 */
export type CitationOutcome = 'ran-passed' | 'not-found' | 'not-run' | 'not-in-run' | 'run-unknown' | 'unresolved'
export const CITATION_OUTCOMES: readonly CitationOutcome[] =
  ['ran-passed', 'not-found', 'not-run', 'not-in-run', 'run-unknown', 'unresolved']

/** A clause's status: the first match of D5's six-row table. */
export type ClauseStatus = 'declared-uncovered' | 'unresolved' | 'covered' | 'covered-run-unknown' | 'partly-covered' | 'not-covered'

const GOOD_OUTCOMES: ReadonlySet<CitationOutcome> = new Set(['ran-passed', 'run-unknown'])
const BAD_OUTCOMES: ReadonlySet<CitationOutcome> = new Set(['not-found', 'not-run', 'not-in-run'])

/**
 * A clause's status (D5): rows in order — declared uncovered, unresolved
 * (the cause is the result's commit: absent or not resolvable — the table
 * reads the cause, never the outcomes), covered, covered with its run
 * unknown, partly covered, not covered. `outcomes` pairs with the clause's
 * citations positionally; null means no check recorded outcomes (the check
 * predates the map, or its facts dropped them), and only then the clause has
 * no status beyond its own declared-uncovered row.
 */
export function clauseStatus(tests: number, outcomes: CitationOutcome[] | null, hasResolvedCommit: boolean): ClauseStatus | null {
  if (tests === 0) return 'declared-uncovered'
  if (outcomes === null || outcomes.length !== tests) return null
  if (!hasResolvedCommit) return 'unresolved'
  if (outcomes.every(outcome => outcome === 'ran-passed')) return 'covered'
  if (outcomes.every(outcome => outcome === 'run-unknown')) return 'covered-run-unknown'
  const good = outcomes.filter(outcome => GOOD_OUTCOMES.has(outcome)).length
  const bad = outcomes.filter(outcome => BAD_OUTCOMES.has(outcome)).length
  if (good > 0 && bad > 0) return 'partly-covered'
  return 'not-covered'
}

/** The form a withheld map takes in the reader's view (D6): the map exists, its clause count is stated, its content is not. */
export interface WithheldCoverage {
  withheld: true
  clauses: number
}

/**
 * The assignment fields the seal reads (D6) — structurally the task's
 * outstanding assignment row. Superseded and failed rows never reach here:
 * the caller passes `outstandingOf(assignments)` only.
 */
export interface SealAssignment {
  handoffKind?: string | null
  resultId?: string | null
  targetKind?: 'group' | 'session' | null
  targetId?: string
  claimedBy?: string | null
}

/**
 * The blind-first seal (D6, J3): session S is sealed from task T's submitter
 * maps exactly when S holds T's outstanding review handoff for some result R
 * (the handoff is a review of R, and S is its session target or its
 * claimant) and S has no coverage-map row for that R. One task-level
 * predicate: recording a map for R unseals S for the whole task, newer
 * results included; an unclaimed group handoff seals nobody.
 */
export function isSealed(assignment: SealAssignment | null, readerSessionId: string, readerHasMapForResult: boolean): boolean {
  if (!assignment || assignment.handoffKind !== 'review' || !assignment.resultId) return false
  const holder = assignment.targetKind === 'session' ? assignment.targetId : assignment.claimedBy
  if (holder !== readerSessionId) return false
  return !readerHasMapForResult
}

/** The withheld view of a map (D6): a mapped result reads `{ withheld, clauses }`; a result without a map reads null — there is nothing to withhold. */
export function withheldCoverage(map: CoverageMap | null): WithheldCoverage | null {
  return map === null ? null : { withheld: true, clauses: map.length }
}

/**
 * What the comparison reports (D6): the clauses only one map names; per
 * shared clause, the citations only one side gives; the shared clauses one
 * side declares uncovered while the other cites tests. Clauses match by
 * normalized text and citations by normalized path and title; duplicate
 * clause texts union their citations under the first-seen text. Deterministic:
 * normalized-key order throughout.
 */
export interface MapComparison {
  /** Clauses only the submitter's map names (its original text). */
  onlySubmitter: string[]
  /** Clauses only the reviewer's map names (its original text). */
  onlyReviewer: string[]
  /** Shared clauses whose citation sets differ. */
  differingCitations: Array<{ clause: string; onlySubmitter: string[]; onlyReviewer: string[] }>
  /** Shared clauses one side declares uncovered while the other cites tests. */
  uncoveredDisputes: string[]
}

interface ClauseEntry {
  clause: string
  citations: Set<string>
}

function clausesByKey(map: CoverageMap): Map<string, ClauseEntry> {
  const byKey = new Map<string, ClauseEntry>()
  for (const row of map) {
    const key = normalizeClause(row.clause)
    const entry = byKey.get(key) ?? { clause: row.clause, citations: new Set<string>() }
    for (const citation of row.tests) {
      const parsed = parseCitation(citation)
      if (parsed !== null) entry.citations.add(normalizeCitation(parsed))
    }
    if (!byKey.has(key)) byKey.set(key, entry)
  }
  return byKey
}

/** The submitter's map against one reviewer's (D6); null while either side has no map. Derived at read time, never stored (J5). */
export function compareCoverageMaps(submitter: CoverageMap | null, reviewer: CoverageMap | null): MapComparison | null {
  if (submitter === null || reviewer === null) return null
  const mine = clausesByKey(submitter)
  const theirs = clausesByKey(reviewer)
  const shared = [...mine.keys()].filter(key => theirs.has(key)).sort()
  const onlySubmitter = [...mine.keys()].filter(key => !theirs.has(key)).sort().map(key => mine.get(key)!.clause)
  const onlyReviewer = [...theirs.keys()].filter(key => !mine.has(key)).sort().map(key => theirs.get(key)!.clause)
  const differingCitations: MapComparison['differingCitations'] = []
  const uncoveredDisputes: string[] = []
  for (const key of shared) {
    const a = mine.get(key)!
    const b = theirs.get(key)!
    const onlyA = [...a.citations].filter(citation => !b.citations.has(citation)).sort()
    const onlyB = [...b.citations].filter(citation => !a.citations.has(citation)).sort()
    if (onlyA.length > 0 || onlyB.length > 0) differingCitations.push({ clause: a.clause, onlySubmitter: onlyA, onlyReviewer: onlyB })
    if ((a.citations.size === 0) !== (b.citations.size === 0)) uncoveredDisputes.push(a.clause)
  }
  return { onlySubmitter, onlyReviewer, differingCitations, uncoveredDisputes }
}

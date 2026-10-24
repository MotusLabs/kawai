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

/** Parse one citation (D5's grammar); null when it is malformed. */
export function parseCitation(citation: string): CoverageCitation | null {
  const match = CITATION_PATTERN.exec(citation.trim())
  return match ? { path: match[1]!, title: match[2]! } : null
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

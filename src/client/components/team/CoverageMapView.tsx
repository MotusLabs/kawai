// The coverage map's reader view (independent-verification D5/D6/D12, task
// 3.3): the submitter's map labeled claimed — only the citation outcomes are
// "checked by Kawai", joined positionally with the newest check's facts —
// each clause's derived status, a withheld map stating its clause count
// only, and reviewer maps beside theirs with the comparison's differences.
// Nothing here gates anything.
import type { Session } from '@shared/types'
import { clauseStatus, type CitationOutcome, type ClauseStatus, type CoverageClause,
  type MapComparison, type ReviewerCoverageMap } from '@shared/coverageMaps'
import type { CoverageMap, WithheldCoverage } from '@shared/coverageMaps'
import type { ResultCheckFacts } from '@shared/teamTasks'
import { actorLabel } from './teamTaskLabels'

const OUTCOME_LABEL: Record<CitationOutcome, string> = {
  'ran-passed': 'ran and passed',
  'not-found': 'not found at the commit',
  'not-run': 'skipped by the recorded pass',
  'not-in-run': 'not in the recorded pass',
  'run-unknown': 'found; run unknown',
  unresolved: 'unresolved (no commit to check)',
}

const STATUS_LABEL: Record<ClauseStatus, string> = {
  'declared-uncovered': 'uncovered (declared)',
  unresolved: 'unresolved',
  covered: 'covered',
  'covered-run-unknown': 'covered; run unknown',
  'partly-covered': 'partly covered',
  'not-covered': 'not covered',
}

function ClauseView({ clause, index, outcomes, hasResolvedCommit }: {
  clause: CoverageClause
  index: number
  outcomes: CitationOutcome[] | null
  hasResolvedCommit: boolean
}) {
  const status = clauseStatus(clause.tests.length, outcomes, hasResolvedCommit)
  return <div data-testid="result-coverage-clause" data-clause-status={status ?? 'unknown'}>
    <p>
      {clause.clause}
      {clause.note ? <span className="text-secondary"> — {clause.note}</span> : null}
      {status && <span> · <span data-testid={`result-coverage-status-${status}`}>{STATUS_LABEL[status]}</span></span>}
    </p>
    {clause.tests.length === 0
      ? <p className="text-secondary">No tests cited</p>
      : clause.tests.map((citation, i) => (
        <p key={`${index}-${i}`} data-testid="result-coverage-citation">
          {citation}
          {outcomes?.[i]
            ? <span> — <span data-testid={`result-coverage-outcome-${outcomes[i]}`}>{OUTCOME_LABEL[outcomes[i]!]}</span> <span className="text-secondary">(checked by Kawai)</span></span>
            : null}
        </p>
      ))}
  </div>
}

/** What the comparison reports (D6): the maps' differences, or their agreement. */
function ComparisonView({ comparison }: { comparison: MapComparison }) {
  const empty = comparison.onlySubmitter.length === 0 && comparison.onlyReviewer.length === 0 &&
    comparison.differingCitations.length === 0 && comparison.uncoveredDisputes.length === 0
  return <div data-testid="result-coverage-comparison" className="border-l-2 border-border pl-2">
    {comparison.onlySubmitter.length > 0 && <p>Only the submitter's map names: {comparison.onlySubmitter.join('; ')}</p>}
    {comparison.onlyReviewer.length > 0 && <p>Only the reviewer's map names: {comparison.onlyReviewer.join('; ')}</p>}
    {comparison.differingCitations.map(row => (
      <p key={row.clause} data-testid="result-coverage-differing">
        {row.clause}:
        {row.onlySubmitter.length > 0 && <span> only the submitter cites {row.onlySubmitter.join(', ')}</span>}
        {row.onlyReviewer.length > 0 && <span> only the reviewer cites {row.onlyReviewer.join(', ')}</span>}
      </p>
    ))}
    {comparison.uncoveredDisputes.length > 0 &&
      <p>Called uncovered by one side, cited by the other: {comparison.uncoveredDisputes.join('; ')}</p>}
    {empty && <p className="text-secondary">The two maps agree</p>}
  </div>
}

export default function CoverageMapView({ coverage, reviewerMaps, comparison, facts, sessions }: {
  coverage: CoverageMap | WithheldCoverage | null | undefined
  reviewerMaps?: ReviewerCoverageMap[]
  /** The reading session's own comparison against the submitter's map (agents); null on the human path. */
  comparison?: MapComparison | null
  /** The newest check's facts, whose coverage outcomes join the map positionally. */
  facts: ResultCheckFacts | null
  sessions: Session[]
}) {
  const outcomes = facts?.version === 1 ? facts.coverage ?? null : null
  const hasResolvedCommit = facts?.commit.status === 'pass'
  return <div className="mt-1 text-chat-meta" data-testid="result-coverage">
    {Array.isArray(coverage) && <div>
      <p className="text-secondary">Coverage map — the submitter's claim; only the citation outcomes below are checked by Kawai</p>
      {coverage.map((clause, index) => (
        <ClauseView key={index} clause={clause} index={index} outcomes={outcomes?.[index] ?? null}
          hasResolvedCommit={hasResolvedCommit} />
      ))}
    </div>}
    {coverage !== null && coverage !== undefined && !Array.isArray(coverage) &&
      <p data-testid="result-coverage-withheld">
        Coverage map withheld ({coverage.clauses} clause{coverage.clauses === 1 ? '' : 's'}) — the submitter's maps stay
        withheld until you record your own map for this result with task_submit_coverage
      </p>}
    {comparison && <ComparisonView comparison={comparison} />}
    {reviewerMaps && reviewerMaps.length > 0 && <div className="mt-1" data-testid="result-reviewer-maps">
      <p className="text-secondary">Reviewer maps</p>
      {reviewerMaps.map(map => <div key={map.authorSession} data-testid="result-reviewer-map" className="border-l-2 border-border pl-2">
        <p>{actorLabel({ kind: 'agent', sessionId: map.authorSession }, sessions)} · {new Date(map.createdAt).toLocaleString()}</p>
        {map.coverage.map((clause, index) => (
          <p key={index} data-testid="result-reviewer-clause">
            {clause.clause}: {clause.tests.length === 0 ? 'no tests cited' : clause.tests.join(', ')}
          </p>
        ))}
        {map.comparison && <ComparisonView comparison={map.comparison} />}
      </div>)}
    </div>}
  </div>
}


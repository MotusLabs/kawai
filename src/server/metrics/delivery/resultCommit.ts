// D1 full-literal identity. Stored checks are untrusted: parseFacts only
// checks version before casting. Validate each field this resolver consumes.
import { isFullLiteral } from './objectFormat'
import type { CommitEvidence, Landing, ObjectFormat, ResultCommit } from './types'

export interface ResultCommitInput {
  teamId: string
  taskId: string
  resultId: string
  commitRef: unknown
  objectFormat: ObjectFormat
  landings: ReadonlyMap<string, Landing>
  checks: readonly unknown[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function finishedAt(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function eligibleCheck(row: unknown, input: ResultCommitInput): (CommitEvidence & { sha: string }) | null {
  if (!record(row) || row.teamId !== input.teamId || row.taskId !== input.taskId
    || row.resultId !== input.resultId || row.status !== 'done') return null
  if (!text(row.id) || !Number.isSafeInteger(row.seq) || (row.seq as number) <= 0 || !finishedAt(row.finishedAt)) return null
  if (!record(row.facts) || row.facts.version !== 1 || !record(row.facts.commit)) return null
  const commit = row.facts.commit
  if (commit.status !== 'pass' || commit.given !== input.commitRef || !isFullLiteral(commit.sha, input.objectFormat)) return null
  return { id: row.id, seq: row.seq as number, finishedAt: row.finishedAt, sha: commit.sha }
}

export function resolveResultCommit(input: ResultCommitInput): ResultCommit {
  const sha = input.commitRef
  if (!isFullLiteral(sha, input.objectFormat)) return { kind: 'unresolvable', reason: 'not-full-literal' }
  const landing = input.landings.get(sha)
  if (landing !== undefined) return { kind: 'landed', sha, landing }

  let evidence: CommitEvidence | undefined
  for (const row of input.checks) {
    const check = eligibleCheck(row, input)
    if (check === null) continue
    // A passing same-result claim of a different full id disqualifies even
    // when it is the only claim. Failed/not-found checks assert no identity.
    if (check.sha !== sha) return { kind: 'unresolvable', reason: 'contradictory-check' }
    if (evidence === undefined || check.seq < evidence.seq || (check.seq === evidence.seq && check.id < evidence.id)) {
      evidence = { id: check.id, seq: check.seq, finishedAt: check.finishedAt }
    }
  }
  return evidence === undefined
    ? { kind: 'unresolvable', reason: 'no-corroboration' }
    : { kind: 'not-landed', sha, evidence }
}

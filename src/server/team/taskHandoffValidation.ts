// Request payload validation (owner-publication-handoff D10, Table H-REQ's
// H7): every problem is checked in one fixed field order — size limits
// first, before any field is parsed, then direction, acceptance, contract
// parse, rationale, evidence references, and base commit — and the first
// failing check is the refusal. Nothing is written by a refused request.
import { spawnSync } from 'node:child_process'
import { cleanGitEnv } from '../git/gitCommand'
import { contractInput } from './taskContractRows'

export const HANDOFF_FIELD_LIMIT = 64 * 1024
export const HANDOFF_EVIDENCE_MAX = 20
export const HANDOFF_EVIDENCE_BYTES = 512

export interface HandoffRequestFields {
  direction?: string | null
  acceptance?: string | null
  contract?: string | null
  rationale: string
  notify: boolean
  baseCommit?: string | null
  evidenceRefs?: string[]
}

/** The normalized payload: trimmed fields, blank = not given. */
export interface NormalizedHandoffRequest {
  direction: string | null
  acceptance: string | null
  contract: string | null
  rationale: string
  notify: boolean
  baseCommit: string | null
  evidenceRefs: string[]
}

const blankToNull = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')

export function normalizeHandoffRequest(input: HandoffRequestFields): NormalizedHandoffRequest {
  return {
    direction: blankToNull(input.direction), acceptance: blankToNull(input.acceptance), contract: blankToNull(input.contract),
    rationale: input.rationale.trim(), notify: input.notify, baseCommit: blankToNull(input.baseCommit),
    evidenceRefs: (input.evidenceRefs ?? []).map(ref => ref.trim()),
  }
}

/** The first differing field between a stored payload and a resend, in H11's order, or null. */
export function firstDifference(stored: NormalizedHandoffRequest & { baseRevision: number }, sent: NormalizedHandoffRequest & { baseRevision: number }): string | null {
  if (stored.direction !== sent.direction) return 'direction'
  if (stored.acceptance !== sent.acceptance) return 'acceptance'
  if (stored.contract !== sent.contract) return 'contract'
  if (stored.rationale !== sent.rationale) return 'rationale'
  if (stored.notify !== sent.notify) return 'notify'
  if (stored.baseRevision !== sent.baseRevision) return 'base revision'
  if (stored.baseCommit !== sent.baseCommit) return 'base commit'
  if (JSON.stringify(stored.evidenceRefs) !== JSON.stringify(sent.evidenceRefs)) return 'evidence'
  return null
}

function sizeProblem(request: NormalizedHandoffRequest): string | null {
  for (const field of ['direction', 'acceptance', 'contract', 'rationale'] as const) {
    const value = request[field]
    if (value !== null && bytes(value) > HANDOFF_FIELD_LIMIT) return `The ${field} exceeds its size limit of ${HANDOFF_FIELD_LIMIT} bytes`
  }
  if (request.evidenceRefs.length > HANDOFF_EVIDENCE_MAX) return `At most ${HANDOFF_EVIDENCE_MAX} evidence references are allowed`
  const long = request.evidenceRefs.find(ref => bytes(ref) > HANDOFF_EVIDENCE_BYTES)
  if (long !== undefined) return `An evidence reference exceeds its size limit of ${HANDOFF_EVIDENCE_BYTES} bytes`
  return null
}

/** A repository-relative path (no leading `/`, no `..` segment) or an id; never control characters. */
function evidenceProblem(ref: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!ref || /[\u0000-\u001f]/.test(ref)) return `Evidence reference is empty or holds control characters: ${JSON.stringify(ref)}`
  if (ref.startsWith('/') || ref.split(/[\\/]/).includes('..')) return `Evidence reference must be a repository-relative path or an id: ${ref}`
  return null
}

/** A full commit id that resolves in one of `roots` (spawned with cleanGitEnv and a timeout). */
function commitProblem(commit: string, roots: string[]): string | null {
  if (!/^[0-9a-f]{40}$/.test(commit)) return `The base commit must be a full 40-hex commit id: ${commit}`
  for (const root of roots) {
    const result = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, env: cleanGitEnv(), timeout: 10_000, stdio: 'ignore' })
    if (result.status === 0) return null
  }
  return `The base commit does not resolve in the task's worktree or the team repository: ${commit}`
}

/** Throw the first problem in H7's field order; nothing is written. */
export function validateHandoffRequest(request: NormalizedHandoffRequest, commitRoots: string[]): void {
  const problem = sizeProblem(request)
    ?? (request.direction === null && request.acceptance === null && request.contract === null
      ? 'A publication request needs a direction, acceptance criteria, or a contract' : null)
  if (problem) throw new Error(`${problem}; nothing was recorded`)
  if (request.contract !== null) contractInput(request.contract, false)
  if (!request.rationale) throw new Error('A publication request needs a rationale; nothing was recorded')
  for (const ref of request.evidenceRefs) {
    const bad = evidenceProblem(ref)
    if (bad) throw new Error(`${bad}; nothing was recorded`)
  }
  if (request.baseCommit !== null) {
    const bad = commitProblem(request.baseCommit, commitRoots)
    if (bad) throw new Error(`${bad}; nothing was recorded`)
  }
}

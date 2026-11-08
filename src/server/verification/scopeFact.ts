// The scope fact (implementation-contract design D6, table S1–S10): the
// paths a result's commit changes since its merge base with the base ref,
// judged against the scope globs of the contract of the revision the result
// is pinned to — never the task's current one. A rename is judged by both
// paths and listed by its new one when either falls outside; paths under the
// linked change's own directory count as in scope; at most 20 are listed
// and the rest counted. Read-only git at the main checkout, sharing the
// check's budget: a non-answering call throws through `CheckGit` and makes
// the whole check unavailable. The runner truncates output silently at its
// read limit, so a diff that reaches it reads unknown — paths past the cut
// were never judged. The fact never gates anything (I3).
import type { ImplementationContract } from '../../shared/implementationContract'
import type { ResultScopeFact } from '../../shared/teamTasks'
import type { CheckGit } from './resultChecks'
import { MAX_LISTED_PATHS } from './serializeFacts'

/** The pinned revision's contract and the task's linked change; null contract = the revision has none. */
export interface ScopeInput {
  identity: string
  contract: ImplementationContract | null
  linkedChange: string | null
}

/** The task reads `pinnedScope` needs: the result row, its task, and its revisions. */
export interface PinnedScopeReads {
  results: { get(id: string): { taskId: string; taskRevision: number } | null }
  get(taskId: string): { openspecChange: string | null } | null
  revisions(taskId: string): Array<{ revision: number; identity?: string; contract?: ImplementationContract | null }>
}

/** The contract of the revision a result is pinned to — never the task's current one (S8). */
export function pinnedScope(store: PinnedScopeReads, resultId: string): ScopeInput | null {
  const row = store.results.get(resultId)
  const task = row === null ? null : store.get(row.taskId)
  const pinned = row === null ? undefined : store.revisions(row.taskId).find(revision => revision.revision === row.taskRevision)
  if (task === null || pinned === undefined || !pinned.identity) return null
  return { identity: pinned.identity, contract: pinned.contract ?? null, linkedChange: task.openspecChange }
}

/** The scope diff's read limit: past it the output is cut and the fact reads unknown. */
export const SCOPE_DIFF_MAX_BYTES = 16 * 1024 * 1024

const MIB = 1024 * 1024
const limitLabel = (bytes: number) => (bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes}-byte`)

const unknown = (identity: string, note: string): ResultScopeFact =>
  ({ status: 'unknown', withinScope: null, outside: [], more: 0, contractIdentity: identity, note })

/** The scope fact when there is no commit to judge. */
export function scopeWithoutCommit(input: ScopeInput, note: string): ResultScopeFact {
  return input.contract === null ? noContract(input) : unknown(input.identity, note)
}

function noContract(input: ScopeInput): ResultScopeFact {
  return { status: 'no-contract', withinScope: null, outside: [], more: 0, contractIdentity: input.identity, note: null }
}

/** Whether one path is in scope: a glob matches it, or it lies in the linked change's directory. */
export function inScope(globs: readonly InstanceType<typeof Bun.Glob>[], linkedChange: string | null, file: string): boolean {
  if (linkedChange !== null && file.startsWith(`openspec/changes/${linkedChange}/`)) return true
  return globs.some(glob => glob.match(file))
}

/**
 * Parse `git diff --name-status -z -M` output into the paths each entry
 * names: one for an add, modify, delete, or type change; old then new for a
 * rename or copy (`R<score>`, `C<score>`).
 */
export function parseNameStatus(output: string): string[][] {
  const fields = output.split('\0')
  const entries: string[][] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index]
    if (!status) { index += 1; continue }
    const paired = status.startsWith('R') || status.startsWith('C')
    const paths = fields.slice(index + 1, index + (paired ? 3 : 2))
    entries.push(paths)
    index += paired ? 3 : 2
  }
  return entries
}

export async function readScope(
  git: CheckGit, repoRoot: string, sha: string, baseRef: string, input: ScopeInput, maxBytes = SCOPE_DIFF_MAX_BYTES,
): Promise<ResultScopeFact> {
  if (input.contract === null) return noContract(input)
  const base = await git(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: repoRoot })
  if (!base.ok) return unknown(input.identity, `${baseRef} is unset; git remote set-head origin --auto fixes it`)
  const mergeBase = await git(['merge-base', base.stdout.trim(), sha], { cwd: repoRoot })
  if (!mergeBase.ok) return unknown(input.identity, `no merge base between ${baseRef} and the commit`)
  const diff = await git(['diff', '--name-status', '-z', '-M', mergeBase.stdout.trim(), sha], { cwd: repoRoot, maxOutputBytes: maxBytes })
  if (!diff.ok) return unknown(input.identity, 'the changed paths could not be read')
  // The runner cuts output at the limit without saying so: output that
  // reaches it may hide paths, which must never read as within scope.
  if (diff.stdout.length >= maxBytes) return unknown(input.identity, `the changed paths exceed the ${limitLabel(maxBytes)} read limit; scope not judged`)
  const globs = input.contract.scope.map(pattern => new Bun.Glob(pattern))
  const outside: string[] = []
  for (const paths of parseNameStatus(diff.stdout)) {
    // A rename is listed by its new path when either side is out of scope (S3).
    if (paths.some(file => !inScope(globs, input.linkedChange, file))) outside.push(paths.at(-1)!)
  }
  return {
    status: outside.length === 0 ? 'pass' : 'warn',
    withinScope: outside.length === 0,
    outside: outside.slice(0, MAX_LISTED_PATHS),
    more: Math.max(0, outside.length - MAX_LISTED_PATHS),
    contractIdentity: input.identity,
    note: null,
  }
}

// The check computation (independent-verification design D2, task 2.2): what
// one check reads about a result's commit, and the facts it records. Every
// git call is read-only at the repository's objects, run at the team main
// checkout (merge-tree, diff, merge-base, rev-list, show); the result's own
// worktree is read for the given commit text's resolution, HEAD, its branch,
// and its status. A call that does not answer — a timeout or a spawn
// failure — throws `CheckUnavailable`: the whole check is unavailable (D1),
// never a per-fact unknown. A fact whose precondition is missing (no
// commit, no worktree, an unset base ref) reads `unknown` with its reason
// instead. The only write anywhere is merge-tree's unreferenced objects,
// which gc prunes; status runs under --no-optional-locks so the index is
// never touched.
import fs from 'node:fs'
import path from 'node:path'
import { runGitAsync, type GitCommandResult } from '../git/gitCommand'
import { RECORDS_DIR_NAME, recordsForTree } from '../checks/checkRecords'
import { testTitles } from '../checks/testTitles'
import { parseCitation, type CitationOutcome, type CoverageMap } from '../../shared/coverageMaps'
import type { ResultCheckFacts, ResultHeadRelation } from '../../shared/teamTasks'
import { MAX_LISTED_PATHS } from './serializeFacts'

/** The whole-check budget (D1): a check that exceeds it is unavailable. */
export const RESULT_CHECK_BUDGET_MS = 120_000
/** One git call's timeout, bounded by the budget that is left. */
const MAX_CALL_MS = 10_000
const MAX_COMPARED_HEADS = 30
const DEFAULT_BASE_REF = 'refs/remotes/origin/HEAD'

/** The check cannot run: a git call timed out, the process could not spawn,
 * or the whole-check budget ran out (D1: recorded as unavailable, with this
 * reason). Distinguishable from a fact's `unknown`, which is a precondition
 * the check could observe. */
export class CheckUnavailable extends Error {}

/**
 * One read-only git call of a check. Implementations enforce the whole-check
 * budget and turn a non-answering call into `CheckUnavailable`; a call that
 * answers — any exit code — resolves normally, since exit codes carry facts
 * (a merge conflict is exit 1).
 */
export type CheckGit = (args: string[], opts?: { cwd?: string }) => Promise<GitCommandResult>

/**
 * The production runner: runGitAsync under a budget measured from the first
 * call. Each call's timeout is the smaller of one call bound and the budget
 * that is left; a call killed by either throws `CheckUnavailable`.
 */
export function makeCheckGit(budgetMs = RESULT_CHECK_BUDGET_MS, spawn = runGitAsync): CheckGit {
  const deadline = Date.now() + budgetMs
  return async (args, opts = {}) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new CheckUnavailable(`the check budget ran out before git ${args[0]}`)
    const result = await spawn(args, { ...opts, timeoutMs: Math.min(MAX_CALL_MS, remaining) })
    if (result.exitCode === null) {
      throw new CheckUnavailable(`git ${args[0]} did not answer`)
    }
    return result
  }
}

/** Another open task of the team whose worktree is a listed worktree root. */
export interface OtherTaskHead {
  taskId: string
  worktree: string
}

/** How one usable test list answers for a cited test (D5): passed when the
 * run lists it as passed, skipped when skipped or todo, absent when the run
 * lists nothing for it. */
export type TestListLookup = (path: string, title: string) => 'passed' | 'skipped' | 'absent'

/** The tree's test-list reader (D7): the commit's tree id in, the newest
 * usable recorded list's lookup out — or null when the tree has none. */
export type TreeTestList = (treeId: string) => TestListLookup | null

/** What one check reads (D2), prepared by the caller (task 2.3). */
export interface ResultCheckInput {
  /** The result's commit text; null when the result names only a diff. */
  given: string | null
  /** The result's worktree root; null when none was pinned. */
  worktree: string | null
  /** The team's main checkout: the object-level commands' cwd. */
  repoRoot: string
  /** Other open tasks' listed worktrees, newest task first. */
  others: OtherTaskHead[]
  /** The server's own platform and architecture, for the record comparison. */
  host: { platform: string; arch: string }
  /** The result's coverage map (D5): its citations resolve at the commit. Absent or null when the result carries none. */
  coverage?: CoverageMap | null
  /**
   * The tree's test-list reader (D5, D7, task 4.3): given the commit's tree
   * id, returns the newest usable recorded list's lookup, or null when no
   * record of the tree has a usable list (missing, unreadable, mismatched:
   * K1) — a found citation then reads run-unknown, never fabricated data.
   * The production reader is readTreeTestList (treeTestList.ts), wired by
   * the check service.
   */
  testList?: TreeTestList
  baseRef?: string
}

const trimmed = (result: GitCommandResult): string => result.stdout.trim()

const lines = (result: GitCommandResult): string[] =>
  result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)

const isFullSha = (text: string): boolean => /^[0-9a-f]{40}$/i.test(text)

const cap = (names: string[]): { names: string[]; more: number } => ({
  names: names.slice(0, MAX_LISTED_PATHS),
  more: Math.max(0, names.length - MAX_LISTED_PATHS),
})

async function isAncestor(git: CheckGit, repoRoot: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const result = await git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  return null
}

async function revCount(git: CheckGit, repoRoot: string, range: string): Promise<number | null> {
  const result = await git(['rev-list', '--count', range], { cwd: repoRoot })
  if (!result.ok) return null
  const count = Number.parseInt(trimmed(result), 10)
  return Number.isNaN(count) ? null : count
}

/** Where the given commit text resolves (D2 1): a worktree-local ref such
 * as HEAD names the resolving worktree's head, so the text resolves in the
 * result's own worktree when that worktree exists and belongs to this
 * repository — its git common dir is the repository's. Every other case —
 * no worktree, a missing directory, another repository — resolves at the
 * repository root as before. Read-only; a call that answers with a failure
 * falls back to the root, one that does not answer is unavailable (D1). */
async function commitResolveCwd(git: CheckGit, repoRoot: string, worktree: string | null): Promise<string> {
  if (worktree === null || !fs.existsSync(path.join(worktree, '.git'))) return repoRoot
  const here = await git(['rev-parse', '--git-common-dir'], { cwd: repoRoot })
  if (!here.ok) return repoRoot
  const there = await git(['rev-parse', '--git-common-dir'], { cwd: worktree })
  if (!there.ok) return repoRoot
  const common = (cwd: string, answer: GitCommandResult): string => path.resolve(cwd, answer.stdout.trim())
  return common(repoRoot, here) === common(worktree, there) ? worktree : repoRoot
}

/** The commit fact (D2 1): resolves the given text, or ends the check. */
async function checkCommit(git: CheckGit, repoRoot: string, given: string | null, worktree: string | null): Promise<{
  fact: ResultCheckFacts['commit']
  sha: string | null
  tree: string | null
}> {
  if (given === null) {
    return {
      fact: { given: null, sha: null, resolvedAtCheckTime: false, status: 'unknown', note: 'no commit to check' },
      sha: null, tree: null,
    }
  }
  const result = await git(['rev-parse', '--verify', `${given}^{commit}`], { cwd: await commitResolveCwd(git, repoRoot, worktree) })
  if (!result.ok) {
    return { fact: { given, sha: null, resolvedAtCheckTime: false, status: 'fail', note: 'commit not found' }, sha: null, tree: null }
  }
  const sha = trimmed(result)
  const treeResult = await git(['rev-parse', `${sha}^{tree}`], { cwd: repoRoot })
  const tree = treeResult.ok ? trimmed(treeResult) : null
  return {
    fact: { given, sha, resolvedAtCheckTime: !isFullSha(given), status: 'pass', note: null },
    sha,
    tree,
  }
}

const unknownHead = (note: string): ResultCheckFacts['head'] => ({
  sha: null, branch: null, relation: null, ahead: null, behind: null, status: 'unknown', note,
})
const unknownClean = (note: string): ResultCheckFacts['clean'] => ({
  clean: null, paths: [], more: 0, status: 'unknown', note,
})

/** HEAD and cleanliness (D2 2–3). HEAD, its branch, and the relation are
 * read in the result's own worktree; the ancestry and count commands are
 * object-level and run at the repository root. */
async function readWorktree(git: CheckGit, repoRoot: string, worktree: string, sha: string): Promise<{
  head: ResultCheckFacts['head']
  clean: ResultCheckFacts['clean']
}> {
  // A worktree that is gone (or mid-prune) is a fact the check can observe,
  // not a failed call: HEAD and cleanliness read unknown with the reason,
  // while the commit is still checked from the repository (D2).
  if (!fs.existsSync(path.join(worktree, '.git'))) {
    const reason = 'the worktree is missing'
    return { head: unknownHead(reason), clean: unknownClean(reason) }
  }
  const headResult = await git(['rev-parse', 'HEAD'], { cwd: worktree })
  if (!headResult.ok) {
    const reason = headResult.stderr.trim() || 'worktree unreadable'
    return { head: unknownHead(reason), clean: unknownClean(reason) }
  }
  const headSha = trimmed(headResult)
  const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree })
  const branch = branchResult.ok && trimmed(branchResult) !== 'HEAD' ? trimmed(branchResult) : null
  let relation: ResultHeadRelation = 'same'
  let ahead = 0
  let behind = 0
  if (headSha !== sha) {
    const commitInHead = await isAncestor(git, repoRoot, sha, headSha)
    const headInCommit = await isAncestor(git, repoRoot, headSha, sha)
    if (commitInHead === true) {
      relation = 'ahead'
      ahead = (await revCount(git, repoRoot, `${sha}..${headSha}`)) ?? 0
    } else if (headInCommit === true) {
      relation = 'behind'
      behind = (await revCount(git, repoRoot, `${headSha}..${sha}`)) ?? 0
    } else if (commitInHead === false && headInCommit === false) {
      relation = 'diverged'
      ahead = (await revCount(git, repoRoot, `${sha}..${headSha}`)) ?? 0
      behind = (await revCount(git, repoRoot, `${headSha}..${sha}`)) ?? 0
    } else {
      return { head: unknownHead('worktree history unreadable'), clean: unknownClean('worktree history unreadable') }
    }
  }
  const note = relation === 'same'
    ? null
    : `HEAD (${relation}, ${relation === 'behind' ? behind : ahead} commit${(relation === 'behind' ? behind : ahead) === 1 ? '' : 's'})`
  return {
    head: { sha: headSha, branch, relation, ahead, behind, status: relation === 'same' ? 'pass' : 'warn', note },
    clean: await readClean(git, worktree),
  }
}

/** `status --porcelain=v1 -z` (D2 3): modified, staged, and untracked
 * non-ignored paths. Rename and copy entries consume a second field (the
 * old path), which the walk must skip. */
async function readClean(git: CheckGit, worktree: string): Promise<ResultCheckFacts['clean']> {
  const result = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z'], { cwd: worktree })
  if (!result.ok) return unknownClean(result.stderr.trim() || 'status did not run')
  const fields = result.stdout.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    const xy = entry.slice(0, 2)
    if (xy.includes('R') || xy.includes('C')) i++
  }
  const listed = cap(paths)
  return {
    clean: paths.length === 0, paths: listed.names, more: listed.more,
    status: paths.length === 0 ? 'pass' : 'warn', note: null,
  }
}

/** The recorded full-check pass (D2 4, D3): found by the commit's tree,
 * compared with the commit's own `.bun-version` and the server's platform
 * and architecture. A pass that matches reads as the fact; the newest
 * record otherwise shows, marked as a warning. */
async function readRecorded(
  git: CheckGit,
  repoRoot: string,
  sha: string,
  tree: string | null,
  host: { platform: string; arch: string },
): Promise<ResultCheckFacts['recorded']> {
  const base: ResultCheckFacts['recorded'] = { status: 'unknown', recordBun: null, recordAt: null, commitBun: null, note: null }
  if (tree === null) return { ...base, note: 'the commit tree is unreadable' }
  const commonResult = await git(['rev-parse', '--git-common-dir'], { cwd: repoRoot })
  if (!commonResult.ok) return { ...base, note: 'the repository check records are unreadable' }
  const common = commonResult.stdout.trim()
  const dir = path.isAbsolute(common) ? common : path.join(repoRoot, common)
  let records: ReturnType<typeof recordsForTree>
  try {
    records = recordsForTree(path.join(dir, RECORDS_DIR_NAME), tree)
  } catch {
    return { ...base, note: 'the check records could not be read' }
  }
  const showResult = await git(['show', `${sha}:.bun-version`], { cwd: repoRoot })
  const commitBun = showResult.ok ? trimmed(showResult) : null
  if (records.length === 0) {
    return { ...base, commitBun, status: 'warn', note: 'no full check passed for this tree' }
  }
  const newest = records[0]
  const matching = records.find(record =>
    (commitBun === null || record.bun === commitBun) && record.platform === host.platform && record.arch === host.arch)
  if (matching !== undefined) {
    return { status: 'pass', recordBun: matching.bun, recordAt: matching.at, commitBun, note: null }
  }
  const note = commitBun !== null
    ? `the newest pass ran under Bun ${newest.bun}; the commit pins ${commitBun}`
    : `the newest pass ran under Bun ${newest.bun} on ${newest.platform}/${newest.arch}, which differs from this server`
  return { status: 'warn', recordBun: newest.bun, recordAt: newest.at, commitBun, note }
}

/** `merge-tree --write-tree --name-only --no-messages` (D2): exit 0 is a
 * clean merge; exit 1 lists the conflicting paths after the tree oid. Any
 * other exit is a fact the check cannot read (null). */
async function mergeTree(git: CheckGit, repoRoot: string, a: string, b: string): Promise<{ clean: boolean; conflicts: string[] } | null> {
  const result = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd: repoRoot })
  if (result.exitCode === 0) return { clean: true, conflicts: [] }
  if (result.exitCode === 1) return { clean: false, conflicts: lines(result).slice(1) }
  return null
}

async function diffNames(git: CheckGit, repoRoot: string, range: string): Promise<string[]> {
  const result = await git(['diff', '--name-only', range], { cwd: repoRoot })
  return result.ok ? lines(result) : []
}

/** The base fact (D2 5): origin's default branch as last fetched. */
async function readBase(git: CheckGit, repoRoot: string, sha: string, baseRef: string): Promise<ResultCheckFacts['base']> {
  const refResult = await git(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: repoRoot })
  if (!refResult.ok) {
    return {
      ref: baseRef, sha: null, behind: null, mergeClean: null, conflicts: [], moreConflicts: 0,
      status: 'unknown', note: `${baseRef} is unset; git remote set-head origin --auto fixes it`,
    }
  }
  const baseSha = trimmed(refResult)
  const behind = await revCount(git, repoRoot, `${sha}..${baseSha}`)
  const merge = await mergeTree(git, repoRoot, baseSha, sha)
  if (merge === null) {
    return {
      ref: baseRef, sha: baseSha, behind, mergeClean: null, conflicts: [], moreConflicts: 0,
      status: 'unknown', note: 'the merge could not be tested',
    }
  }
  const listed = cap(merge.conflicts)
  return {
    ref: baseRef, sha: baseSha, behind, mergeClean: merge.clean, conflicts: listed.names, moreConflicts: listed.more,
    status: merge.clean ? 'pass' : 'fail', note: null,
  }
}

/** The open-branch comparison (D2 6): each other open task's head, skipped
 * when it equals the commit or the base or the result contains it, at most
 * 30 compared newest task first, the rest counted. Overlap is the
 * intersection of the two three-dot diffs against the base. */
async function readBranches(
  git: CheckGit,
  repoRoot: string,
  others: OtherTaskHead[],
  sha: string,
  base: { readable: boolean; sha: string | null },
): Promise<ResultCheckFacts['branches']> {
  const compared: ResultCheckFacts['branches']['compared'] = []
  let skipped = 0
  const seen = new Set<string>()
  const inResult = base.readable && base.sha !== null
    ? new Set(await diffNames(git, repoRoot, `${base.sha}...${sha}`))
    : new Set<string>()
  for (const other of others) {
    // A vanished worktree has no head to compare; it is not a failed call.
    if (!fs.existsSync(path.join(other.worktree, '.git'))) continue
    const headResult = await git(['rev-parse', 'HEAD'], { cwd: other.worktree })
    if (!headResult.ok) continue
    const head = trimmed(headResult)
    if (seen.has(head)) continue
    seen.add(head)
    if (head === sha) continue
    if (await isAncestor(git, repoRoot, head, sha)) continue
    if (base.readable && base.sha !== null && await isAncestor(git, repoRoot, head, base.sha)) continue
    if (compared.length >= MAX_COMPARED_HEADS) {
      skipped++
      continue
    }
    const merge = await mergeTree(git, repoRoot, head, sha)
    const conflicts = merge?.clean === false ? cap(merge.conflicts) : { names: [] as string[], more: 0 }
    const otherNames = base.readable && base.sha !== null ? await diffNames(git, repoRoot, `${base.sha}...${head}`) : []
    const overlap = cap(otherNames.filter(name => inResult.has(name)))
    compared.push({
      taskId: other.taskId, head,
      conflicts: conflicts.names, moreConflicts: conflicts.more,
      overlap: overlap.names, moreOverlap: overlap.more,
      status: merge === null ? 'unknown' : !merge.clean ? 'fail' : overlap.names.length > 0 ? 'warn' : 'pass',
    })
  }
  const failed = compared.some(entry => entry.status === 'fail')
  const warned = compared.some(entry => entry.status === 'warn')
  return {
    compared, comparedCount: compared.length, skipped,
    status: failed ? 'fail' : warned ? 'warn' : 'pass',
  }
}

/**
 * Resolve a map's citations at the commit (D5): per clause, one outcome per
 * citation, positionally — nothing normalizes, dedupes, or reorders, so the
 * array always joins the stored map by index. Each distinct path is read
 * once; a path `git show` cannot read, or a title the file's tests do not
 * carry, reads not-found. A found citation's run comes from the test list;
 * without one, found reads run-unknown.
 */
async function resolveCoverage(
  git: CheckGit,
  repoRoot: string,
  sha: string,
  coverage: CoverageMap,
  testList: TestListLookup | null | undefined,
): Promise<CitationOutcome[][]> {
  const titlesByPath = new Map<string, Set<string> | null>()
  const titlesFor = async (citationPath: string): Promise<Set<string> | null> => {
    let titles = titlesByPath.get(citationPath)
    if (titles === undefined) {
      const show = await git(['show', `${sha}:${citationPath}`], { cwd: repoRoot })
      titles = show.ok ? testTitles(show.stdout, { testsOnly: true }) : null
      titlesByPath.set(citationPath, titles)
    }
    return titles
  }
  return Promise.all(coverage.map(clause => Promise.all(clause.tests.map(async citation => {
    const parsed = parseCitation(citation)
    if (parsed === null) return 'not-found' as const
    const titles = await titlesFor(parsed.path)
    if (titles === null || !titles.has(parsed.title)) return 'not-found' as const
    const run = testList?.(parsed.path, parsed.title)
    if (run === 'passed') return 'ran-passed' as const
    if (run === 'skipped') return 'not-run' as const
    if (run === 'absent') return 'not-in-run' as const
    return 'run-unknown' as const
  }))))
}

/** Run one check (D2): the versioned facts about a result's commit. A check
 * that ends at the commit fact (no commit given, or one that does not
 * resolve) records that fact alone — nothing else is checked — with the
 * worktree facts null (never read). */
export async function computeResultFacts(input: ResultCheckInput, git: CheckGit): Promise<ResultCheckFacts> {
  const commit = await checkCommit(git, input.repoRoot, input.given, input.worktree)
  if (commit.sha === null) {
    const note = commit.fact.note ?? 'no commit to check'
    return {
      version: 1,
      commit: commit.fact,
      head: null,
      clean: null,
      recorded: { status: 'unknown', recordBun: null, recordAt: null, commitBun: null, note },
      base: {
        ref: input.baseRef ?? DEFAULT_BASE_REF, sha: null, behind: null, mergeClean: null,
        conflicts: [], moreConflicts: 0, status: 'unknown', note,
      },
      branches: { compared: [], comparedCount: 0, skipped: 0, status: 'unknown' },
      // There is no commit to resolve at (D5): every cited test reads
      // unresolved, whatever the map says. Declared-uncovered clauses carry
      // an empty outcome list, so the join still reads them by row 1.
      ...(input.coverage ? { coverage: input.coverage.map(clause => clause.tests.map(() => 'unresolved' as const)) } : {}),
    }
  }
  const baseRef = input.baseRef ?? DEFAULT_BASE_REF
  const headAndClean = input.worktree === null
    ? { head: unknownHead('the result names no worktree'), clean: unknownClean('the result names no worktree') }
    : await readWorktree(git, input.repoRoot, input.worktree, commit.sha)
  const base = await readBase(git, input.repoRoot, commit.sha, baseRef)
  const branches = await readBranches(git, input.repoRoot, input.others, commit.sha, {
    readable: base.sha !== null, sha: base.sha,
  })
  return {
    version: 1,
    commit: commit.fact,
    head: headAndClean.head,
    clean: headAndClean.clean,
    recorded: await readRecorded(git, input.repoRoot, commit.sha, commit.tree, input.host),
    base,
    branches,
    // One tree-reader call per check: the lookup is built once from the
    // tree's newest usable list and answers every citation (D7, task 4.3).
    ...(input.coverage
      ? {
          coverage: await resolveCoverage(
            git, input.repoRoot, commit.sha, input.coverage,
            commit.tree === null ? undefined : input.testList?.(commit.tree)
          ),
        }
      : {}),
  }
}

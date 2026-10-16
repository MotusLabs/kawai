// github.ts - The GitHub operations execution performs through `gh`
// (plan-execution D10, D13, D14): pull requests (list, create, view, merge
// with the reviewed head pinned), a commit's check runs and statuses
// normalized to `CiCheck`, the failed-run rerun, and the pinned
// update-branch. Every call goes through `runGh` (argument array, timeout,
// bounded redacted output) and carries the repo explicitly (`-R` / the api
// path), so nothing depends on the process's cwd resolving a repository.
// Failures keep gh's message plus the HTTP status when gh reports one — the
// error shape the classifier (D14) reads.
import type { CiCheck, MergeMethod } from '../../../shared/planExecution'
import { MERGE_METHODS } from '../../../shared/planExecution'
import { runGh, type GhCommandOptions } from './ghCommand'

/** One gh call's failure: argv, process exit (null = timeout/spawn), HTTP status when gh named one, and its message. */
export interface GithubError {
  argv: string[]
  exitCode: number | null
  httpStatus: number | null
  message: string
}

export type GithubOutcome<T> = { ok: true; data: T } | { ok: false; error: GithubError }

export interface PrSummary {
  number: number
  url: string
  state: string
  headRefOid: string
}

export interface PrDetail extends PrSummary {
  mergeCommit: string | null
}

const HTTP_IN_STDERR = /HTTP (\d{3})/

type Call = { ok: true; stdout: string } | { ok: false; error: GithubError }

async function call(args: string[], options: GhCommandOptions = {}): Promise<Call> {
  const result = await runGh(args, options)
  if (result.ok) return { ok: true, stdout: result.stdout }
  const stderr = result.stderr.trim()
  const found = HTTP_IN_STDERR.exec(stderr)
  return {
    ok: false,
    error: { argv: ['gh', ...args], exitCode: result.exitCode, httpStatus: found ? Number(found[1]) : null, message: stderr || `gh exited ${result.exitCode ?? 'without an exit'}` },
  }
}

function json<T>(stdout: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(stdout) as T }
  } catch (error) {
    return { ok: false, error: `gh printed unparseable JSON: ${(error as Error).message}` }
  }
}

/** `gh pr list` for one change's branch; `state` defaults to all (D14's open-pr inspection). */
export async function ghPrList(repo: string, input: { head: string; base: string; state?: string }, options: GhCommandOptions = {}): Promise<GithubOutcome<PrSummary[]>> {
  const args = ['pr', 'list', '-R', repo, '--head', input.head, '--base', input.base, '--state', input.state ?? 'all', '--json', 'number,url,state,headRefOid']
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<PrSummary[]>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: parsed.data }
}

/** Open the change's one pull request, naming the plan, revision, change, and task (plan-landing). */
export async function ghPrCreate(repo: string, input: { head: string; base: string; title: string; body: string }, options: GhCommandOptions = {}): Promise<GithubOutcome<{ number: number; url: string }>> {
  const args = ['pr', 'create', '-R', repo, '--head', input.head, '--base', input.base, '--title', input.title, '--body', input.body, '--json', 'number,url']
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ number: number; url: string }>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: parsed.data }
}

/** `gh pr view`: state, head, and the merge commit once merged (D13/D14). */
export async function ghPrView(repo: string, prNumber: number, options: GhCommandOptions = {}): Promise<GithubOutcome<PrDetail>> {
  const args = ['pr', 'view', String(prNumber), '-R', repo, '--json', 'number,url,state,headRefOid,mergeCommit']
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ number: number; url: string; state: string; headRefOid: string; mergeCommit?: { oid: string } | null }>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: { ...parsed.data, mergeCommit: parsed.data.mergeCommit?.oid ?? null } }
}

/** Rerun the failed jobs of one Actions workflow run (D10). */
export async function ghRerunFailed(repo: string, runId: number, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['run', 'rerun', String(runId), '--failed', '-R', repo], options)
  return result.ok ? { ok: true, data: null } : result
}

/**
 * Update a pull request's branch from its base, pinned to the head whose
 * round passed (D13): `expected_head_sha` makes GitHub refuse the update
 * when the branch moved. A 202 with the update message is the success shape.
 */
export async function ghUpdateBranch(repo: string, prNumber: number, expectedHeadSha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['api', '-X', 'PUT', `repos/${repo}/pulls/${prNumber}/update-branch`, '-f', `expected_head_sha=${expectedHeadSha}`], options)
  return result.ok ? { ok: true, data: null } : result
}

/** Merge the pull request with the team's method, pinned to the reviewed head so GitHub refuses a moved branch (D13). */
export async function ghPrMerge(repo: string, prNumber: number, method: MergeMethod, headSha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  if (!MERGE_METHODS.includes(method)) throw new Error(`Unknown merge method: ${method}`)
  const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
  const result = await call(['pr', 'merge', String(prNumber), '-R', repo, flag, '--match-head-commit', headSha], options)
  return result.ok ? { ok: true, data: null } : result
}

// --- CI reads (D10) ---

interface RawCheckRun {
  name?: unknown
  conclusion?: unknown
  status?: unknown
  html_url?: unknown
  details_url?: unknown
  app?: { slug?: unknown } | null
}

const asString = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null

/** A check run from Actions is rerunnable: the app is github-actions and the details URL names its run (D10). */
function runIdOf(check: RawCheckRun): number | null {
  const url = asString(check.details_url) ?? asString(check.html_url)
  const found = url === null ? null : /\/runs\/(\d+)/.exec(url)
  return found ? Number(found[1]) : null
}

/** Pure: one page of `check-runs` bodies as `CiCheck`s (conclusion null keeps the run's status, so a running check reads pending). */
export function checkRunsToCi(pages: unknown): CiCheck[] {
  const bodies: unknown[] = Array.isArray(pages) ? pages : [pages]
  const checks: CiCheck[] = []
  for (const body of bodies) {
    const runs = (body as { check_runs?: unknown }).check_runs
    if (!Array.isArray(runs)) continue
    for (const run of runs as RawCheckRun[]) {
      const runId = runIdOf(run)
      const fromActions = run.app?.slug === 'github-actions' && runId !== null
      checks.push({
        name: asString(run.name) ?? '',
        source: fromActions ? 'actions' : 'check-run',
        conclusion: asString(run.conclusion) ?? asString(run.status) ?? 'pending',
        link: asString(run.html_url) ?? asString(run.details_url),
        ...(fromActions ? { runId: runId ?? undefined } : {}),
        startedAt: null,
        completedAt: null,
      })
    }
  }
  return checks
}

/** A commit's check runs, all pages (D10). */
export async function ghCheckRuns(repo: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<CiCheck[]>> {
  const args = ['api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<unknown>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: checkRunsToCi(parsed.data) }
}

/** Pure: a combined status body as `CiCheck`s — a status's failure and error read as failure, its pending as pending (D10). */
export function statusesToCi(body: unknown): CiCheck[] {
  const statuses = (body as { statuses?: unknown }).statuses
  if (!Array.isArray(statuses)) return []
  return (statuses as Array<{ state?: unknown; context?: unknown; target_url?: unknown }>).map(status => ({
    name: asString(status.context) ?? '',
    source: 'status' as const,
    conclusion: status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure',
    link: asString(status.target_url),
    startedAt: null,
    completedAt: null,
  }))
}

/** A commit's combined status (D10). */
export async function ghStatuses(repo: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<CiCheck[]>> {
  const args = ['api', `repos/${repo}/commits/${sha}/status`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<unknown>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: statusesToCi(parsed.data) }
}

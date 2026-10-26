// verify-result.ts - The local script for "A local script reports a
// result's checks" (independent-verification): for a worktree and a commit
// (HEAD by default), it prints the commit, worktree, recorded-pass, base,
// and coverage checks Kawai records, computed by the same module
// (computeResultFacts) with the same readers. Instead of open tasks it
// compares against the head of every other listed worktree. It uses no
// network and writes nothing (K6).
//
// Exit codes: 0 only when every present fact reads pass and every citation
// reads ran-passed — green means covered, never covered-run-unknown; a
// clause citing no tests (declared uncovered) passes vacuously. 1 when any
// check is not green (fail, warn, or unknown). 2 for usage and environment
// errors: an unknown flag, a missing value, a target outside a repository,
// an unreadable or malformed coverage file.

import fs from 'node:fs'
import path from 'node:path'
import { runGit } from '../src/server/git/gitCommand'
import {
  CheckUnavailable,
  computeResultFacts,
  makeCheckGit,
  type OtherTaskHead,
} from '../src/server/verification/resultChecks'
import { readTreeTestList } from '../src/server/verification/treeTestList'
import { validateCoverageMap, type CoverageMap } from '../src/shared/coverageMaps'
import type { ResultCheckFacts } from '../src/shared/teamTasks'

export interface ScriptArgs {
  worktree: string | null
  commit: string | null
  coveragePath: string | null
  json: boolean
}

/** Parse the flags; anything unknown, valueless, or repeated throws the
 * usage error main() turns into exit 2. */
export function parseScriptArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = { worktree: null, commit: null, coveragePath: null, json: false }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return next
    }
    if (flag === '--worktree') args.worktree = value()
    else if (flag === '--commit') args.commit = value()
    else if (flag === '--coverage') args.coveragePath = value()
    else if (flag === '--json') args.json = true
    else throw new Error(`unknown flag: ${flag}`)
  }
  return args
}

export function usageText(): string {
  return [
    'usage: bun scripts/verify-result.ts [--worktree P] [--commit R] [--coverage F] [--json]',
    '',
    '  --worktree P   the result\'s worktree root (default: the current directory)',
    '  --commit R     the result\'s commit (default: HEAD)',
    '  --coverage F   a JSON coverage-map file, checked citation by citation as Kawai does',
    '  --json         print the raw check facts as JSON instead of lines',
    '',
    'Exits 0 only when every check reads pass and every cited test reads',
    'ran-passed — green means covered, never covered-run-unknown; a clause',
    'citing no tests passes as declared uncovered. Usage and environment',
    'errors exit 2; any check that is not green exits 1.',
  ].join('\n')
}

/** The target worktree root and its repository root, or null when git
 * cannot resolve them (the caller reports usage). */
export function resolveTarget(dir: string): { worktree: string; repoRoot: string } | null {
  const toplevel = runGit(['rev-parse', '--show-toplevel'], { cwd: dir })
  if (!toplevel.ok) return null
  const common = runGit(['rev-parse', '--git-common-dir'], { cwd: dir })
  if (!common.ok) return null
  const answer = common.stdout.trim()
  const commonDir = path.isAbsolute(answer) ? answer : path.join(dir, answer)
  return { worktree: toplevel.stdout.trim(), repoRoot: path.dirname(commonDir) }
}

/** The other worktrees from `git worktree list --porcelain`, as the check's
 * other heads: every listed worktree except the result's own, newest-first
 * order left as git prints it, each named by its directory basename (the
 * module caps the compared heads itself, so the script passes them all). */
export function parseWorktreeHeads(porcelain: string, chosen: string): OtherTaskHead[] {
  const chosenReal = realOrGiven(chosen)
  const heads: OtherTaskHead[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const root = line.slice('worktree '.length).trim()
    if (root === '' || realOrGiven(root) === chosenReal) continue
    heads.push({ taskId: path.basename(root), worktree: root })
  }
  return heads
}

function realOrGiven(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Exit 0 only on all-green: every present fact pass, every citation
 * ran-passed (an empty outcome list is a clause declared uncovered, which
 * passes vacuously). Fail, warn, and unknown all keep the script at 1 —
 * a warn is not a certificate, and neither is a fact the check could not
 * observe. */
export function exitCodeFor(facts: ResultCheckFacts): number {
  const statuses = [
    facts.commit.status,
    facts.recorded.status,
    facts.base.status,
    facts.branches.status,
    ...(facts.head !== null ? [facts.head.status] : []),
    ...(facts.clean !== null ? [facts.clean.status] : []),
    ...facts.branches.compared.map((entry) => entry.status),
  ]
  if (!statuses.every((status) => status === 'pass')) return 1
  if (facts.coverage !== undefined) {
    for (const clause of facts.coverage) {
      if (!clause.every((outcome) => outcome === 'ran-passed')) return 1
    }
  }
  return 0
}

function capped(names: string[], more: number): string {
  const shown = more > 0 ? [...names, `+${more} more`] : names
  return shown.length > 0 ? shown.join(', ') : ''
}

/** The human-readable lines, one per fact — the same facts the JSON form
 * carries. A failing base or branch names its conflicting files (spec:
 * "the script lists the conflicting files"). */
export function factLines(facts: ResultCheckFacts, coverage: CoverageMap | null): string[] {
  const lines: string[] = []
  const suffix = (status: string, note: string | null): string =>
    ` — ${status}${note !== null && note !== '' ? `: ${note}` : ''}`
  const commit = facts.commit
  lines.push(
    `commit ${commit.sha ?? '(none)'}` +
      `${commit.given !== null && commit.sha !== null ? ` (from ${commit.given})` : ''}` +
      suffix(commit.status, commit.note)
  )
  if (facts.head !== null) {
    const head = facts.head
    lines.push(
      `head ${head.sha ?? '?'}` +
        `${head.branch !== null ? ` on ${head.branch}` : ''}` +
        `${head.relation !== null ? `, ${head.relation}` : ''}` +
        `${head.ahead !== null && head.ahead > 0 ? ` (+${head.ahead})` : ''}` +
        `${head.behind !== null && head.behind > 0 ? ` (-${head.behind})` : ''}` +
        suffix(head.status, head.note)
    )
  }
  if (facts.clean !== null) {
    const clean = facts.clean
    const paths = capped(clean.paths, clean.more)
    lines.push(
      `worktree ${clean.clean === null ? 'unreadable' : clean.clean ? 'clean' : 'dirty'}` +
        `${paths !== '' ? `: ${paths}` : ''}` +
        suffix(clean.status, clean.note)
    )
  }
  const recorded = facts.recorded
  lines.push(
    `recorded ${recorded.recordAt ?? '(none)'}` +
      `${recorded.recordBun !== null ? `, bun ${recorded.recordBun}` : ''}` +
      `${recorded.commitBun !== null ? ` vs commit bun ${recorded.commitBun}` : ''}` +
      suffix(recorded.status, recorded.note)
  )
  const base = facts.base
  const conflicts = capped(base.conflicts, base.moreConflicts)
  lines.push(
    `base ${base.ref}` +
      `${base.sha !== null ? ` at ${base.sha.slice(0, 12)}` : ''}` +
      `, behind ${base.behind ?? '?'}` +
      `, merge ${base.mergeClean === null ? 'unreadable' : base.mergeClean ? 'clean' : 'CONFLICTS'}` +
      `${conflicts !== '' ? `: ${conflicts}` : ''}` +
      suffix(base.status, base.note)
  )
  const branches = facts.branches
  lines.push(
    `branches compared ${branches.comparedCount}, skipped ${branches.skipped}` +
      suffix(branches.status, null)
  )
  for (const entry of branches.compared) {
    const entryConflicts = capped(entry.conflicts, entry.moreConflicts)
    const overlap = capped(entry.overlap, entry.moreOverlap)
    lines.push(
      `  vs ${entry.taskId} at ${entry.head.slice(0, 12)}` +
        `${entryConflicts !== '' ? `, CONFLICTS: ${entryConflicts}` : ''}` +
        `${overlap !== '' ? `, overlap: ${overlap}` : ''}` +
        ` — ${entry.status}`
    )
  }
  if (coverage !== null && facts.coverage !== undefined) {
    facts.coverage.forEach((outcomes, index) => {
      const clause = coverage[index]
      if (clause === undefined) return
      lines.push(
        `coverage clause ${index + 1} "${clause.clause}" — ` +
          `${outcomes.length === 0 ? 'declared uncovered' : outcomes.join(', ')}`
      )
      clause.tests.forEach((citation, citationIndex) => {
        const outcome = outcomes[citationIndex]
        if (outcome !== undefined) lines.push(`    ${citation}: ${outcome}`)
      })
    })
  }
  return lines
}

async function main(): Promise<never> {
  let args: ScriptArgs
  try {
    args = parseScriptArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`verify-result: ${(error as Error).message}`)
    console.error(usageText())
    process.exit(2)
  }
  let coverage: CoverageMap | null = null
  if (args.coveragePath !== null) {
    let text: string
    try {
      text = fs.readFileSync(args.coveragePath, 'utf8')
    } catch {
      console.error(`verify-result: cannot read the coverage file: ${args.coveragePath}`)
      process.exit(2)
    }
    try {
      coverage = validateCoverageMap(JSON.parse(text))
    } catch (error) {
      console.error(`verify-result: invalid coverage map: ${(error as Error).message}`)
      process.exit(2)
    }
  }
  const target = resolveTarget(args.worktree ?? process.cwd())
  if (target === null) {
    console.error(`verify-result: not a git repository (worktree: ${args.worktree ?? process.cwd()})`)
    process.exit(2)
  }
  const list = runGit(['worktree', 'list', '--porcelain'], { cwd: target.repoRoot })
  if (!list.ok) {
    console.error(`verify-result: cannot list worktrees: ${list.stderr.trim()}`)
    process.exit(2)
  }
  try {
    const facts = await computeResultFacts(
      {
        given: args.commit ?? 'HEAD',
        worktree: target.worktree,
        repoRoot: target.repoRoot,
        others: parseWorktreeHeads(list.stdout, target.worktree),
        host: { platform: process.platform, arch: process.arch },
        ...(coverage !== null
          ? { coverage, testList: (treeId: string) => readTreeTestList(target.repoRoot, treeId) }
          : {}),
      },
      makeCheckGit()
    )
    if (args.json) {
      console.log(JSON.stringify(facts, null, 2))
    } else {
      for (const line of factLines(facts, coverage)) console.log(line)
    }
    process.exit(exitCodeFor(facts))
  } catch (error) {
    if (error instanceof CheckUnavailable) {
      console.error(`verify-result: the check could not run: ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

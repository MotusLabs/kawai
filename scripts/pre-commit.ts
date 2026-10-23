// pre-commit.ts - The commit hook (per-result-suite task 3.1, design D1/D2).
// .githooks/pre-commit execs this. The commit is classified first, so a
// full-check path never runs lint and typecheck twice. The rows are tried in
// this order, first match wins — the escape is judged over staged, unstaged,
// and untracked paths before the empty-staged amend gate (I3):
//
//   selection error            -> `bun run check`
//   escape (D2)                -> `bun run check` (a recorded key is a hit)
//   empty staged diff (amend)  -> lint, typecheck when the index tree has a
//                                 full-pass record, else `bun run check`
//   docs-only                  -> lint, typecheck, the declaration pass
//   source                     -> lint, typecheck, both affected passes
//
// The partial paths never write a record (checkRun.ts is the only writer):
// a partial check is no certificate, the full check at result and push is.
// The tests run on the working tree, as Bun's --changed does, so working-tree
// edits outside the commit can select tests too; the hook names them. Every
// child runs with GIT_* stripped and stdin ignored.

import path from 'node:path'
import { runGit } from '../src/server/git/gitCommand'
import {
  collectChangedPaths,
  isDocsOnlyPath,
  runAffectedTests,
  selectAffectedTests,
  type AffectedSelection,
  type ChangedPaths,
} from './affected-tests'
import { recordsDir } from '../src/server/checks/checkRecords'
import { stepEnv } from './lib/checkRun'
import { listUnitTestFiles } from './lib/reads'
import { readTreeRecord } from './lib/treeRecord'

export type PreCommitPlan =
  | { kind: 'full'; reason: string }
  | { kind: 'escape'; selection: AffectedSelection }
  | { kind: 'lint-typecheck'; reason: string }
  | { kind: 'partial'; selection: AffectedSelection; outsideSourcePaths: string[] }

export type Gathered =
  | { ok: true; changed: ChangedPaths; selection: AffectedSelection; amendRecorded: boolean }
  | { ok: false; error: string }

/** Source paths edited in the working tree but not staged: they still drive
 * Bun's --changed, so the hook reports them (CP1 F4). */
export function outsideSourcePaths(changed: ChangedPaths): string[] {
  const staged = new Set(changed.staged)
  return [...new Set([...changed.unstaged, ...changed.untracked])]
    .filter((candidate) => !staged.has(candidate) && !isDocsOnlyPath(candidate))
    .sort()
}

/** The decision table above, pure. */
export function planPreCommit(gathered: Gathered): PreCommitPlan {
  if (!gathered.ok) {
    return { kind: 'full', reason: `selection failed (${gathered.error}); running the full check` }
  }
  const { changed, selection } = gathered
  if (selection.kind === 'escape') return { kind: 'escape', selection }
  if (changed.staged.length === 0) {
    return gathered.amendRecorded
      ? { kind: 'lint-typecheck', reason: 'no content change; the index tree has a recorded full pass' }
      : { kind: 'full', reason: 'no content change and no recorded full pass for the index tree; running the full check' }
  }
  return {
    kind: 'partial',
    selection,
    outsideSourcePaths: selection.kind === 'source' ? outsideSourcePaths(changed) : [],
  }
}

export interface SpawnRequest {
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface PreCommitDeps {
  root: string
  env: NodeJS.ProcessEnv
  spawn: (request: SpawnRequest) => Promise<number>
  log: (line: string) => void
  error: (line: string) => void
}

export const FULL_CHECK = ['bun', 'run', 'check']
export const LINT = ['bun', 'run', 'lint']
export const TYPECHECK = ['bun', 'run', 'typecheck']

/** Run a plan. Returns the hook's exit code: the first failing step's. */
export async function runPreCommit(plan: PreCommitPlan, deps: PreCommitDeps): Promise<number> {
  const env = stepEnv(deps.env)
  const run = (command: string[]) => deps.spawn({ command, cwd: deps.root, env })
  const runFullCheck = () => run(FULL_CHECK)

  if (plan.kind === 'full') {
    deps.log(`pre-commit: ${plan.reason}`)
    return await runFullCheck()
  }
  if (plan.kind === 'escape') {
    const outcome = await runAffectedTests({ root: deps.root, selection: plan.selection, runFullCheck })
    for (const line of outcome.lines) deps.log(line)
    return outcome.code
  }

  for (const [name, command] of [
    ['lint', LINT],
    ['typecheck', TYPECHECK],
  ] as const) {
    deps.log(`pre-commit: ${name}…`)
    const code = await run(command)
    if (code !== 0) {
      deps.error(`pre-commit: ${name} failed (exit ${code})`)
      return code
    }
  }
  if (plan.kind === 'lint-typecheck') {
    deps.log(`pre-commit: ${plan.reason}; no tests`)
    return 0
  }

  deps.log(`pre-commit: ${plan.selection.kind} commit; affected fast-tier tests only (the full check runs at result and push)`)
  if (plan.outsideSourcePaths.length > 0) {
    deps.log(
      `pre-commit: working-tree source edits outside this commit may have selected tests: ${plan.outsideSourcePaths.join(', ')}`
    )
  }
  const outcome = await runAffectedTests({
    root: deps.root,
    selection: plan.selection,
    runPass: (cmd) => run(cmd),
    runFullCheck,
  })
  for (const line of outcome.lines) deps.log(line)
  for (const failure of outcome.failures) deps.error(failure)
  return outcome.code
}

/** The amend gate: does the commit's index tree have a full-pass record?
 * Any failure — write-tree, the records directory, the key, an unreadable
 * record — reads as no record, so the commit runs the full check (CP1 R3). */
export function indexTreeRecorded(root: string, indexFile: string | undefined): boolean {
  try {
    const env = indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : undefined
    const tree = runGit(['write-tree'], { cwd: root, env })
    if (!tree.ok) return false
    return readTreeRecord(recordsDir(root), tree.stdout.trim()) !== null
  } catch {
    return false
  }
}

export function gather(root: string, indexFile: string | undefined): Gathered {
  try {
    const changed = collectChangedPaths(root, indexFile)
    const selection = selectAffectedTests({ root, unitFiles: listUnitTestFiles(root), changed })
    const amendRecorded =
      changed.staged.length === 0 && selection.kind !== 'escape' && indexTreeRecorded(root, indexFile)
    return { ok: true, changed, selection, amendRecorded }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function defaultSpawn(request: SpawnRequest): Promise<number> {
  try {
    const proc = Bun.spawn({
      cmd: request.command,
      cwd: request.cwd,
      env: request.env,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return proc.exited
  } catch (error) {
    console.error(`pre-commit: cannot start ${request.command.join(' ')}: ${String(error)}`)
    return Promise.resolve(1)
  }
}

async function main(): Promise<number> {
  const top = runGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (!top.ok) {
    console.error(`pre-commit: not a git repository (${top.stderr.trim()})`)
    return 2
  }
  const root = path.resolve(top.stdout.trim())
  const plan = planPreCommit(gather(root, process.env.GIT_INDEX_FILE || undefined))
  const code = await runPreCommit(plan, {
    root,
    env: process.env,
    spawn: defaultSpawn,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
  console.log(code === 0 ? 'pre-commit: all checks passed' : `pre-commit: failed (exit ${code})`)
  return code
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(2)
    })
}

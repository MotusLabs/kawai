// affected-tests.ts — per-commit affected-test selection (per-result-suite
// D1/D2, tasks 2.1–2.2). For a source commit the unit tests run in two
// disjoint passes through the suite runner: the fast-tier files whose
// `@reads` header matches a changed path run without `--changed`, then the
// remaining fast-tier files are passed as exact paths with `--changed` so
// Bun's import following picks the affected subset. A pass whose candidate
// list is empty is skipped: bare `bun test` would discover everything. Any
// change to the selection's own inputs — the runner, the check pipeline,
// the hooks, the lock/pin/toolchain files, or a test helper no test imports
// — escapes to the full check before classification.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit, type GitCommandResult } from '../src/server/git/gitCommand'
import { PRELOAD_ARG, isSlowTierFile, toTestFilePath } from './planBatches'
import { declaresPath, listUnitTestFiles, parseReadsHeader } from './lib/reads'

// --- changed paths ---

export interface ChangedPaths {
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

function gitLines(result: GitCommandResult, what: string): string[] {
  if (!result.ok) {
    throw new Error(`affected-tests: git ${what} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.split('\0').filter((entry) => entry !== '')
}

// The commit's staged paths, the working tree's unstaged edits, and the
// untracked files. `--no-renames` lists both sides of a rename (the
// docs-only rule); NUL delimiters survive any file name. The hook's
// GIT_INDEX_FILE — possibly a temporary index for `git commit -a` — reaches
// every index-reading call through the explicit option, while discovery
// variables stay stripped so cwd remains authoritative.
export function collectChangedPaths(root: string, indexFile?: string): ChangedPaths {
  const env = indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : undefined
  return {
    staged: gitLines(
      runGit(['diff', '--cached', '--no-renames', '--name-only', '-z'], { cwd: root, env }),
      'diff --cached'
    ),
    unstaged: gitLines(
      runGit(['diff', '--no-renames', '--name-only', '-z'], { cwd: root, env }),
      'diff'
    ),
    untracked: gitLines(
      runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, env }),
      'ls-files --others'
    ),
  }
}

// --- classification ---

// The docs-only rule of scripts/docs-only-changes.sh, mirrored: markdown and
// plain text, anything under openspec/ or docs/, and root license/changelog
// files. The staged paths alone classify the commit; a failed listing never
// reads as docs-only because collectChangedPaths throws instead.
export function isDocsOnlyPath(candidate: string): boolean {
  if (/\.(?:md|mdx|txt|rst)$/.test(candidate)) return true
  if (candidate.startsWith('openspec/') || candidate.startsWith('docs/')) return true
  return /^(?:LICENSE|LICENSE\..*|COPYING|NOTICE|AUTHORS|CHANGELOG|CHANGELOG\..*)$/.test(candidate)
}

export function isDocsOnlyCommit(staged: readonly string[]): boolean {
  return staged.length > 0 && staged.every(isDocsOnlyPath)
}

// --- escapes (D2) ---

// Files the selection itself depends on, or that Bun's import following
// cannot attribute: the runner, the check pipeline, this script, the test
// preload, the package manifest, the lockfile, the Bun pin, the bunfig, the
// hooks, and the root TypeScript configs. Evaluated before docs-only
// classification and before tier exclusion.
const ESCAPE_FILES = new Set([
  'scripts/test-runner.ts',
  'scripts/check.ts',
  'scripts/affected-tests.ts',
  PRELOAD_ARG,
  'package.json',
  'bun.lock',
  '.bun-version',
  'bunfig.toml',
])

export function isEscapeCandidate(candidate: string): boolean {
  if (ESCAPE_FILES.has(candidate)) return true
  if (candidate.startsWith('.githooks/')) return true
  if (!candidate.includes('/') && /^tsconfig(?:\.[^/]+)?\.json$/.test(candidate)) return true
  return candidate.includes('__tests__/helpers/')
}

// A helper some unit test names is covered by `--changed` (Bun follows
// imports transitively, so its importers run); a helper no test names is
// invisible to that following and escapes to the full check. The check is
// textual on purpose — the same heuristic class as the @reads guard — and
// errs toward the full check: only a `helpers/<stem>` mention in a test's
// source suppresses the escape.
function helperIsImported(repoPath: string, testSources: readonly string[]): boolean {
  const stem = path.basename(repoPath).replace(/\.tsx?$/, '')
  const marker = `helpers/${stem}`
  return testSources.some((source) => source.includes(marker))
}

export function findEscapePaths(
  candidates: readonly string[],
  testSources: readonly string[]
): string[] {
  const escapes: string[] = []
  for (const candidate of candidates) {
    if (!isEscapeCandidate(candidate)) continue
    if (candidate.includes('__tests__/helpers/') && helperIsImported(candidate, testSources)) {
      continue
    }
    escapes.push(candidate)
  }
  return escapes
}

// --- selection ---

export type SelectionKind = 'escape' | 'docs-only' | 'source'

export interface AffectedSelection {
  kind: SelectionKind
  escapePaths: string[]
  declarationFiles: string[]
  changedPassFiles: string[]
  slowTierExcluded: number
  workingTreeContributors: string[]
}

// D1: declaration matches and escapes read the union of staged, unstaged,
// and untracked paths, and the hook reports when a working-tree-only path
// contributed. The passes take disjoint fast-tier file sets: the
// declaration pass runs files a `@reads` header selected, the `--changed`
// pass receives the remaining fast-tier files as exact paths. The slow tier
// never runs here — its matching files are only counted, and task 2.2
// reports the number without claiming how many were import-affected.
export function selectAffectedTests(input: {
  root: string
  unitFiles: readonly string[]
  changed: ChangedPaths
  readSource?: (file: string) => string
}): AffectedSelection {
  // Unit files are root-relative; resolve them against root, whatever a
  // caller's cwd is.
  const readSource =
    input.readSource ?? ((file: string) => fs.readFileSync(path.resolve(input.root, file), 'utf8'))
  const allPaths = [
    ...new Set([...input.changed.staged, ...input.changed.unstaged, ...input.changed.untracked]),
  ]
  const workingTreeOnly = new Set([...input.changed.unstaged, ...input.changed.untracked])
  const testSources = input.unitFiles.map((file) => readSource(file))

  const escapePaths = findEscapePaths(allPaths, testSources)
  if (escapePaths.length > 0) {
    return {
      kind: 'escape',
      escapePaths,
      declarationFiles: [],
      changedPassFiles: [],
      slowTierExcluded: 0,
      workingTreeContributors: escapePaths.filter((escaped) => workingTreeOnly.has(escaped)),
    }
  }

  const declared = input.unitFiles.map((file) => parseReadsHeader(readSource(file)))
  const matches = (entries: readonly string[], changedPath: string): boolean =>
    entries.length > 0 && declaresPath(entries, changedPath)

  const declarationFiles: string[] = []
  let slowTierExcluded = 0
  input.unitFiles.forEach((file, index) => {
    if (!allPaths.some((changedPath) => matches(declared[index], changedPath))) return
    if (isSlowTierFile(file)) slowTierExcluded += 1
    else declarationFiles.push(file)
  })
  const declaredFiles = new Set(declarationFiles)
  const docsOnly = isDocsOnlyCommit(input.changed.staged)
  const changedPassFiles = docsOnly
    ? []
    : input.unitFiles.filter((file) => !isSlowTierFile(file) && !declaredFiles.has(file))

  return {
    kind: docsOnly ? 'docs-only' : 'source',
    escapePaths: [],
    declarationFiles,
    changedPassFiles,
    slowTierExcluded,
    workingTreeContributors: [...workingTreeOnly].filter((changedPath) =>
      declared.some((entries) => matches(entries, changedPath))
    ),
  }
}

// --- execution ---

export interface AffectedPass {
  pass: 'declaration' | 'changed'
  cmd: string[]
  reportPath: string
  exitCode: number
}

export interface AffectedRunResult {
  code: number
  lines: string[]
  failures: string[]
  passes: AffectedPass[]
  fullCheckExit: number | null
}

export interface AffectedRunInput {
  root: string
  selection: AffectedSelection
  runPass?: (cmd: string[], reportPath: string) => Promise<number>
  runFullCheck?: () => Promise<number>
}

// Runs the selection. The escape delegates to the full check. Source and
// docs-only commits run their non-empty passes in order through the suite
// runner (`--skip-slow`, JUnit reports for task 2.2's counts), each pass
// getting a fresh report path under its own per-invocation directory so a
// stale report can never supply a count. The first failing pass stops the
// run and fails it; task 2.2 reads the reports and prints the selection.
export async function runAffectedTests(input: AffectedRunInput): Promise<AffectedRunResult> {
  const lines: string[] = []
  const failures: string[] = []
  const passes: AffectedPass[] = []

  if (input.selection.kind === 'escape') {
    const runFullCheck =
      input.runFullCheck ??
      (async () => {
        const proc = Bun.spawn({
          cmd: ['bun', 'run', 'check'],
          cwd: input.root,
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        })
        return await proc.exited
      })
    const fullCheckExit = await runFullCheck()
    return { code: fullCheckExit, lines, failures, passes, fullCheckExit }
  }

  const runPass =
    input.runPass ??
    (async (cmd: string[]) => {
      const proc = Bun.spawn({
        cmd,
        cwd: input.root,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      return await proc.exited
    })
  const runner = path.resolve(import.meta.dir, 'test-runner.ts')
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-tests-'))
  try {
    const steps = [
      { pass: 'declaration' as const, files: input.selection.declarationFiles, changed: false },
      { pass: 'changed' as const, files: input.selection.changedPassFiles, changed: true },
    ]
    for (const step of steps) {
      // A bare `bun test` would discover everything, so an empty candidate
      // list skips its pass (D1).
      if (step.files.length === 0) continue
      const reportPath = path.join(reportDir, `${step.pass}.junit.xml`)
      const cmd = [
        'bun',
        runner,
        '--skip-slow',
        '--reporter=junit',
        `--reporter-outfile=${reportPath}`,
        ...(step.changed ? ['--changed'] : []),
        ...step.files.map(toTestFilePath),
      ]
      const exitCode = await runPass(cmd, reportPath)
      passes.push({ pass: step.pass, cmd, reportPath, exitCode })
      if (exitCode !== 0) {
        failures.push(`affected-tests: ${step.pass} pass failed (exit ${exitCode})`)
        break
      }
    }
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true })
  }
  return { code: failures.length > 0 ? 1 : 0, lines, failures, passes, fullCheckExit: null }
}

// --- entry ---

async function main(): Promise<number> {
  const root = runGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (!root.ok) {
    console.error(`affected-tests: not a git repository (${root.stderr.trim()})`)
    return 2
  }
  const repositoryRoot = root.stdout.trim()
  let selection: AffectedSelection
  try {
    const changed = collectChangedPaths(repositoryRoot, process.env.GIT_INDEX_FILE || undefined)
    selection = selectAffectedTests({
      root: repositoryRoot,
      unitFiles: listUnitTestFiles(repositoryRoot),
      changed,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  const outcome = await runAffectedTests({ root: repositoryRoot, selection })
  for (const line of outcome.lines) console.log(line)
  for (const failure of outcome.failures) console.error(failure)
  return outcome.code
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(2)
    })
}

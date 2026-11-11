// realTmuxSelection.ts - Real-tmux selection by declared paths
// (check-time-optimization D6). Each real-tmux file declares the paths it
// exercises in an `@exercises:` header within its first 20 lines, beside
// `@reads`. A full run runs a real-tmux file when it is forced
// (`--all-real-tmux`), when there is no merge-base, when the changed set
// touches a shared trigger, or when it touches the file itself or one of its
// globs; otherwise the file is skipped as unaffected. The changed set is the
// working tree against the merge-base of HEAD with the local `origin/master`
// ref, plus untracked non-ignored files; nothing is fetched. The selector is
// pure; changedSet and readDeclarations are the effects test-runner.ts wires.

import fs from 'node:fs'
import path from 'node:path'
import { parseRealTmuxSelection, type RecordRealTmuxSelection } from '../../src/server/checks/checkRecords'
import { runGit } from '../../src/server/git/gitCommand'
import { REAL_TMUX_SHARED_TRIGGERS } from '../planBatches'

export const EXERCISES_HEADER_MAX_LINE = 20
export const SELECTION_BASE_REF = 'refs/remotes/origin/master'
/** Beside the JUnit reports in a full check's report directory; the merge
 * reads only `*.junit.xml`, so this file never enters the test list. */
export const SELECTION_FILE_NAME = 'real-tmux-selection.json'

export type SelectionReason = 'forced' | 'no-merge-base' | 'shared-trigger' | 'declared-path' | 'unaffected'

export interface RealTmuxDeclaration {
  /** Repo-relative path of the real-tmux file. */
  file: string
  /** Its `@exercises` globs, repo-relative; empty when it has no header. */
  globs: string[]
}

export interface RealTmuxChoice {
  file: string
  run: boolean
  reason: SelectionReason
}

/** The `@exercises:` globs in a file's first 20 lines; several lines accumulate. */
export function parseExercisesHeader(source: string): string[] {
  const globs: string[] = []
  for (const line of source.split('\n', EXERCISES_HEADER_MAX_LINE)) {
    const match = /^\s*\/\/\s*@exercises:\s*(\S.*)$/.exec(line)
    if (match === null) continue
    for (const entry of match[1].split(',')) {
      const glob = entry.trim()
      if (glob !== '') globs.push(glob)
    }
  }
  return globs
}

function matchesAny(globs: readonly string[], changed: readonly string[]): boolean {
  const matchers = globs.map((glob) => new Bun.Glob(glob))
  return changed.some((file) => matchers.some((matcher) => matcher.match(file)))
}

/** The selection decision table SE1–SE5, one choice per declaration, in order. */
export function selectRealTmuxFiles(
  changed: readonly string[],
  declarations: readonly RealTmuxDeclaration[],
  mergeBase: string | null,
  forced: boolean,
  triggers: readonly string[] = REAL_TMUX_SHARED_TRIGGERS
): RealTmuxChoice[] {
  const triggered = matchesAny(triggers, changed)
  return declarations.map(({ file, globs }): RealTmuxChoice => {
    if (forced) return { file, run: true, reason: 'forced' }
    if (mergeBase === null) return { file, run: true, reason: 'no-merge-base' }
    if (triggered) return { file, run: true, reason: 'shared-trigger' }
    if (changed.includes(file) || matchesAny(globs, changed)) return { file, run: true, reason: 'declared-path' }
    return { file, run: false, reason: 'unaffected' }
  })
}

/** The guard's findings (G1, G2): a file without an `@exercises` header, and
 * a glob that matches no tracked file. Empty when every declaration holds. */
export function exercisesProblems(declarations: readonly RealTmuxDeclaration[], tracked: readonly string[]): string[] {
  const problems: string[] = []
  for (const { file, globs } of declarations) {
    if (globs.length === 0) problems.push(`${file}: no @exercises header in its first ${EXERCISES_HEADER_MAX_LINE} lines`)
    for (const glob of globs) {
      if (!matchesAny([glob], tracked)) problems.push(`${file}: @exercises glob ${glob} matches no tracked file`)
    }
  }
  return problems
}

/** The merge-base and the changed set; a null merge-base means every file runs. */
export function changedSet(cwd: string): { mergeBase: string | null; changed: string[] } {
  const base = runGit(['merge-base', 'HEAD', SELECTION_BASE_REF], { cwd })
  const mergeBase = base.ok ? base.stdout.trim() || null : null
  if (mergeBase === null) return { mergeBase: null, changed: [] }
  const diff = runGit(['diff', '--name-only', '--no-renames', '-z', mergeBase, '--'], { cwd })
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd })
  // A changed set that cannot be listed selects everything, like no merge-base.
  if (!diff.ok || !untracked.ok) return { mergeBase: null, changed: [] }
  const changed = [...diff.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean)
  return { mergeBase, changed: [...new Set(changed)].sort() }
}

/** Each file's declaration; an unreadable file declares everything, so it runs. */
export function readDeclarations(cwd: string, files: readonly string[]): RealTmuxDeclaration[] {
  return files.map((file) => {
    try {
      return { file, globs: parseExercisesHeader(fs.readFileSync(path.join(cwd, file), 'utf8')) }
    } catch {
      return { file, globs: ['**'] }
    }
  })
}

/** The runner's full-run selection: decide, print one line per file, and
 * return the files to run with the record to keep. */
export function planRealTmuxSelection(
  cwd: string,
  files: readonly string[],
  forced: boolean,
  log: (line: string) => void = console.log
): { run: string[]; record: SelectionRecord } {
  const { mergeBase, changed } = forced ? { mergeBase: null, changed: [] } : changedSet(cwd)
  const choices = selectRealTmuxFiles(changed, readDeclarations(cwd, files), mergeBase, forced)
  for (const choice of choices) log(formatChoice(choice))
  return { run: choices.filter((choice) => choice.run).map((choice) => choice.file), record: selectionRecord(choices, mergeBase) }
}

export type SelectionRecord = RecordRealTmuxSelection

export function selectionRecord(choices: readonly RealTmuxChoice[], mergeBase: string | null): SelectionRecord {
  return { mergeBase, skipped: choices.filter((choice) => !choice.run).map((choice) => choice.file) }
}

export function writeSelectionRecord(dir: string, record: SelectionRecord): void {
  fs.writeFileSync(path.join(dir, SELECTION_FILE_NAME), `${JSON.stringify(record)}\n`)
}

/** The runner's selection, or null when it wrote none or wrote it malformed. */
export function readSelectionRecord(dir: string): SelectionRecord | null {
  try {
    return parseRealTmuxSelection(JSON.parse(fs.readFileSync(path.join(dir, SELECTION_FILE_NAME), 'utf8')))
  } catch {
    return null
  }
}

export function formatChoice(choice: RealTmuxChoice): string {
  return choice.run
    ? `[test-runner] real-tmux: run (${choice.reason}): ${choice.file}`
    : `[test-runner] real-tmux: skipped, unaffected: ${choice.file}`
}

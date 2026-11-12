// realTmuxSelection.test.ts - The selection decision table SE1–SE5 and the
// guard rows G1–G2 from check-time-optimization design.md (D6), verbatim, over
// the pure selector; the changed set over a real temporary repository; and
// the repo-wide guard over the 7 real-tmux files' `@exercises` headers. SE4
// and SE5 through the production runner are in
// realTmuxSelection.integration.test.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../../src/server/git/gitCommand'
import { REAL_TMUX_FILES, REAL_TMUX_SHARED_TRIGGERS } from '../planBatches'
import {
  changedSet,
  exercisesProblems,
  parseExercisesHeader,
  readDeclarations,
  readSelectionRecord,
  selectRealTmuxFiles,
  selectionRecord,
  writeSelectionRecord,
  type RealTmuxDeclaration,
} from '../lib/realTmuxSelection'

const TERMINAL: RealTmuxDeclaration = { file: 'src/server/__tests__/output-coalescing.integration.test.ts', globs: ['src/server/terminal/**'] }
const MERGE_BASE = '0123456789abcdef0123456789abcdef01234567'

// One row per design row: merge-base, forced or named, ∩ triggers, ∩ own → result.
const SELECTION_TABLE: Array<{
  id: string
  mergeBase: string | null
  forced: boolean
  changed: string[]
  run: boolean
  reason: string
}> = [
  { id: 'SE1', mergeBase: MERGE_BASE, forced: true, changed: [], run: true, reason: 'forced' },
  { id: 'SE1', mergeBase: null, forced: true, changed: ['bun.lock', 'src/server/terminal/a.ts'], run: true, reason: 'forced' },
  { id: 'SE2', mergeBase: null, forced: false, changed: [], run: true, reason: 'no-merge-base' },
  { id: 'SE2', mergeBase: null, forced: false, changed: ['src/server/plans/a.ts'], run: true, reason: 'no-merge-base' },
  { id: 'SE3', mergeBase: MERGE_BASE, forced: false, changed: ['bun.lock'], run: true, reason: 'shared-trigger' },
  { id: 'SE3', mergeBase: MERGE_BASE, forced: false, changed: ['.bun-version', 'src/server/terminal/a.ts'], run: true, reason: 'shared-trigger' },
  { id: 'SE4', mergeBase: MERGE_BASE, forced: false, changed: ['src/server/terminal/outputCoalescer.ts'], run: true, reason: 'declared-path' },
  { id: 'SE4', mergeBase: MERGE_BASE, forced: false, changed: [TERMINAL.file], run: true, reason: 'declared-path' },
  { id: 'SE5', mergeBase: MERGE_BASE, forced: false, changed: [], run: false, reason: 'unaffected' },
  { id: 'SE5', mergeBase: MERGE_BASE, forced: false, changed: ['src/server/plans/a.ts', 'notes/x.md'], run: false, reason: 'unaffected' },
]

describe('real-tmux selection table SE1–SE5', () => {
  for (const row of SELECTION_TABLE) {
    test(`${row.id}: merge-base ${row.mergeBase === null ? 'none' : 'yes'}, forced ${row.forced}, changed [${row.changed.join(', ')}] → ${row.run ? 'run' : 'skip'} (${row.reason})`, () => {
      expect(selectRealTmuxFiles(row.changed, [TERMINAL], row.mergeBase, row.forced)).toEqual([
        { file: TERMINAL.file, run: row.run, reason: row.reason },
      ])
    })
  }

  // @covers: dev-checks › Real-tmux files run only when affected › An unrelated change
  test('a change only under src/server/plans/ skips every real-tmux file', () => {
    const declarations = readDeclarations(process.cwd(), REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`))
    const choices = selectRealTmuxFiles(['src/server/plans/planStore.ts'], declarations, MERGE_BASE, false)
    expect(choices.filter((choice) => choice.run)).toEqual([])
    expect(selectionRecord(choices, MERGE_BASE)).toEqual({ mergeBase: MERGE_BASE, skipped: declarations.map((d) => d.file) })
  })

  // @covers: dev-checks › Real-tmux files run only when affected › A terminal change
  test('a change to a path output-coalescing declares runs it and skips the files that do not declare it', () => {
    const changed = ['src/server/terminal/outputCoalescer.ts']
    const declarations: RealTmuxDeclaration[] = [
      TERMINAL,
      { file: 'src/server/__tests__/chatRename.integration.test.ts', globs: ['src/server/sessions/rename.ts'] },
    ]
    expect(selectRealTmuxFiles(changed, declarations, MERGE_BASE, false).map((choice) => choice.run)).toEqual([true, false])
  })

  // @covers: dev-checks › Real-tmux files run only when affected › A shared trigger
  test('a change to the Bun pin or the lockfile runs every real-tmux file', () => {
    for (const trigger of ['.bun-version', 'bun.lock']) {
      expect(REAL_TMUX_SHARED_TRIGGERS).toContain(trigger)
      const choices = selectRealTmuxFiles([trigger], [TERMINAL, { file: 'x.test.ts', globs: ['nothing/**'] }], MERGE_BASE, false)
      expect(choices.every((choice) => choice.run && choice.reason === 'shared-trigger')).toBe(true)
    }
  })

  // @covers: dev-checks › Real-tmux files run only when affected › No merge-base
  test('without a merge-base every real-tmux file runs', () => {
    expect(selectRealTmuxFiles([], [TERMINAL, { file: 'x.test.ts', globs: [] }], null, false).map((c) => c.reason)).toEqual([
      'no-merge-base',
      'no-merge-base',
    ])
  })

  // @covers: dev-checks › Real-tmux files run only when affected › Forced
  test('forced, every real-tmux file runs whatever the diff', () => {
    expect(selectRealTmuxFiles(['src/server/plans/a.ts'], [TERMINAL], MERGE_BASE, true)).toEqual([
      { file: TERMINAL.file, run: true, reason: 'forced' },
    ])
  })
})

describe('the @exercises guard rows G1–G2', () => {
  const tracked = ['src/server/terminal/outputCoalescer.ts', 'src/server/ws/messageRouter.ts']

  test('G1: a real-tmux file without an @exercises header fails the guard, naming the file', () => {
    expect(exercisesProblems([{ file: 'a.test.ts', globs: [] }], tracked)).toEqual([
      'a.test.ts: no @exercises header in its first 20 lines',
    ])
  })

  test('G2: a glob matching no tracked file fails the guard, naming the file and the glob', () => {
    expect(exercisesProblems([{ file: 'a.test.ts', globs: ['src/server/terminal/**', 'src/server/gone/**'] }], tracked)).toEqual([
      'a.test.ts: @exercises glob src/server/gone/** matches no tracked file',
    ])
  })

  test('a header with live globs passes the guard', () => {
    expect(exercisesProblems([{ file: 'a.test.ts', globs: ['src/server/ws/*.ts'] }], tracked)).toEqual([])
  })

  // @covers: dev-checks › Real-tmux files run only when affected › An undeclared file
  test('every real-tmux file declares @exercises globs that each match a tracked file', () => {
    const files = REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`)
    const listed = runGit(['ls-files', '-z'], { cwd: process.cwd() })
    expect(listed.ok).toBe(true)
    const trackedFiles = listed.stdout.split('\0').filter(Boolean)
    expect(exercisesProblems(readDeclarations(process.cwd(), files), trackedFiles)).toEqual([])
  })

  test('every shared trigger matches a tracked file', () => {
    const trackedFiles = runGit(['ls-files', '-z'], { cwd: process.cwd() }).stdout.split('\0').filter(Boolean)
    for (const trigger of REAL_TMUX_SHARED_TRIGGERS) {
      expect({ trigger, matches: trackedFiles.some((file) => new Bun.Glob(trigger).match(file)) }).toEqual({ trigger, matches: true })
    }
  })
})

describe('header parsing and the selection record', () => {
  test('parseExercisesHeader reads comma-separated globs from the first 20 lines only', () => {
    const lines = ['// @exercises: a/**, b.ts', '// @reads: docs/x.md', '//   @exercises:  c/*.ts ,', ...Array(17).fill('//'), '// @exercises: late/**']
    expect(parseExercisesHeader(lines.join('\n'))).toEqual(['a/**', 'b.ts', 'c/*.ts'])
  })

  test('an unreadable real-tmux file declares everything, so it is never skipped', () => {
    const [declaration] = readDeclarations(os.tmpdir(), ['no-such-dir/missing.test.ts'])
    expect(selectRealTmuxFiles(['anything.ts'], [declaration], MERGE_BASE, false)[0].run).toBe(true)
  })

  test('the selection record round-trips, and a malformed one reads as none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-selection-record-'))
    try {
      expect(readSelectionRecord(dir)).toBeNull()
      writeSelectionRecord(dir, { mergeBase: MERGE_BASE, skipped: ['a.test.ts'] })
      expect(readSelectionRecord(dir)).toEqual({ mergeBase: MERGE_BASE, skipped: ['a.test.ts'] })
      fs.writeFileSync(path.join(dir, 'real-tmux-selection.json'), '{"mergeBase":3,"skipped":[]}')
      expect(readSelectionRecord(dir)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the changed set', () => {
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  const git = (cwd: string, ...args: string[]) => {
    const result = runGit(args, { cwd, env })
    if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }

  test('is the diff from the origin/master merge-base plus untracked files, renames as both paths, ignored files left out', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-changed-set-')))
    try {
      git(repo, 'init', '-q', '-b', 'master')
      fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
      fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
      fs.writeFileSync(path.join(repo, 'old.txt'), 'old\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'base')
      const base = git(repo, 'rev-parse', 'HEAD')
      // No origin/master ref yet: no merge-base.
      expect(changedSet(repo)).toEqual({ mergeBase: null, changed: [] })
      git(repo, 'update-ref', 'refs/remotes/origin/master', base)
      git(repo, 'checkout', '-q', '-b', 'feature')
      fs.writeFileSync(path.join(repo, 'committed.txt'), 'c\n')
      git(repo, 'mv', 'old.txt', 'renamed.txt')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'feature')
      fs.writeFileSync(path.join(repo, 'base.txt'), 'edited\n')
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n')
      fs.writeFileSync(path.join(repo, 'ignored.txt'), 'i\n')
      expect(changedSet(repo)).toEqual({
        mergeBase: base,
        changed: ['base.txt', 'committed.txt', 'old.txt', 'renamed.txt', 'untracked.txt'],
      })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

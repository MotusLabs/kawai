// escapeClosure.test.ts — the escape set covers the check machinery's whole
// import closure (per-result-suite design D2, CP1 F2/A2). The commit hook
// skips the full check for a change the selection does not escape; a change
// to any module the runner, the check, the selection, or a hook script loads
// can alter what those decide, so every such module must escape. The walk
// follows relative imports (static, re-exports, and dynamic) from the entry
// scripts; a new module outside scripts/ joins ESCAPE_CLOSURE_FILES or this
// test fails naming it. The walk is deliberately narrow: only the check
// pipeline's five entry scripts. Every other script escapes as scripts/**
// itself, and what it imports from outside scripts/ is ordinary source that
// Bun's --changed pass selects (CP1 R2).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { isEscapeCandidate } from '../affected-tests'
import { importClosure } from './helpers/importClosure'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const ENTRIES = [
  'scripts/test-runner.ts',
  'scripts/check.ts',
  'scripts/affected-tests.ts',
  'scripts/pre-commit.ts',
  'scripts/pre-push.ts',
].filter((entry) => fs.existsSync(path.join(ROOT, entry)))

describe('the escape set covers the check machinery (D2)', () => {
  test('every module the entry scripts load escapes', () => {
    const closure = importClosure(ENTRIES)
    expect(closure).toContain('src/server/git/gitCommand.ts')
    expect(closure.filter((module) => !isEscapeCandidate(module))).toEqual([])
  })

  test('the walk sees the hook scripts and their library modules', () => {
    expect(ENTRIES).toContain('scripts/pre-commit.ts')
    const closure = importClosure(ENTRIES)
    expect(closure).toEqual(expect.arrayContaining(['src/server/checks/checkKey.ts', 'src/server/checks/checkRecords.ts', 'scripts/lib/treeRecord.ts']))
  })
})

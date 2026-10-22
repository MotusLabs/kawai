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

const ROOT = path.resolve(import.meta.dir, '..', '..')
const ENTRIES = [
  'scripts/test-runner.ts',
  'scripts/check.ts',
  'scripts/affected-tests.ts',
  'scripts/pre-commit.ts',
  'scripts/pre-push.ts',
].filter((entry) => fs.existsSync(path.join(ROOT, entry)))

const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g

function resolveModule(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`unresolved import ${specifier} in ${path.relative(ROOT, fromFile)}`)
}

function importClosure(entries: string[]): string[] {
  const seen = new Set<string>()
  const pending = entries.map((entry) => path.join(ROOT, entry))
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_PATTERN)) pending.push(resolveModule(file, match[1]))
  }
  return [...seen].map((file) => path.relative(ROOT, file).split(path.sep).join('/')).sort()
}

describe('the escape set covers the check machinery (D2)', () => {
  test('every module the entry scripts load escapes', () => {
    const closure = importClosure(ENTRIES)
    expect(closure).toContain('src/server/git/gitCommand.ts')
    expect(closure.filter((module) => !isEscapeCandidate(module))).toEqual([])
  })

  test('the walk sees the hook scripts and their library modules', () => {
    expect(ENTRIES).toContain('scripts/pre-commit.ts')
    const closure = importClosure(ENTRIES)
    expect(closure).toEqual(expect.arrayContaining(['scripts/lib/checkKey.ts', 'scripts/lib/treeRecord.ts']))
  })
})

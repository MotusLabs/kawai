// affectedTests.test.ts — classification and selection for the affected-test
// script (per-result-suite task 2.1): real git state in temporary
// repositories, the D2 escape list, and the disjoint D1 pass lists with
// their runner command lines. The report wording and the JUnit cases live
// in affectedReport.test.ts (task 2.2). Fixture sources are embedded as
// strings, so the repo-wide guard scan sees only the literals declared
// below.
// @reads: AGENTS.md, docs/**, openspec/**
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../../src/server/git/gitCommand'
import {
  collectChangedPaths,
  findEscapePaths,
  isDocsOnlyCommit,
  isDocsOnlyPath,
  isEscapeCandidate,
  runAffectedTests,
  selectAffectedTests,
  type AffectedSelection,
} from '../affected-tests'
import { listUnitTestFiles } from '../lib/reads'

let repoRoot = ''

function git(args: string[]): void {
  const result = runGit(args, { cwd: repoRoot })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

function writeRepoFile(relative: string, content: string): void {
  const target = path.join(repoRoot, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function stage(relative: string, content: string): void {
  writeRepoFile(relative, content)
  git(['add', relative])
}

// A repository whose unit tests cover the selection's inputs: one test
// declaring the agents file, one declaring a docs file, one declaring
// nothing, an independent shared test, and a slow-tier file declaring the
// docs file. Every fast-tier test imports the leaf module, so a leaf edit
// reaches them all through `--changed`.
function initRepo(): void {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-repo-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Affected Tests'])
  writeRepoFile('src/leaf.ts', 'export const leaf = 1\n')
  writeRepoFile('AGENTS.md', '# agents\n')
  writeRepoFile('docs/guide.md', '# guide\n')
  writeRepoFile(
    'src/server/__tests__/agents.test.ts',
    [
      '// @reads: AGENTS.md',
      'import fs from "node:fs"',
      'import { leaf } from "../leaf"',
      'const agents = fs.readFileSync("AGENTS.md", "utf8")',
      'export { leaf, agents }',
      '',
    ].join('\n')
  )
  writeRepoFile(
    'src/server/__tests__/plain.test.ts',
    ['import { leaf } from "../leaf"', 'export const plain = leaf', ''].join('\n')
  )
  writeRepoFile(
    'src/server/__tests__/guide.test.ts',
    [
      '// @reads: docs/guide.md',
      'import fs from "node:fs"',
      'import { leaf } from "../leaf"',
      'const guide = fs.readFileSync("docs/guide.md", "utf8")',
      'export { leaf, guide }',
      '',
    ].join('\n')
  )
  writeRepoFile(
    'src/server/__tests__/slowdoc.integration.test.ts',
    ['// @reads: docs/guide.md', 'import { leaf } from "../leaf"', ''].join('\n')
  )
  writeRepoFile('src/shared/__tests__/shared.test.ts', 'export const shared = 1\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'base'])
}

afterEach(() => {
  if (repoRoot !== '') {
    fs.rmSync(repoRoot, { recursive: true, force: true })
    repoRoot = ''
  }
})

function selection(): AffectedSelection {
  return selectAffectedTests({
    root: repoRoot,
    unitFiles: listUnitTestFiles(repoRoot),
    changed: collectChangedPaths(repoRoot),
  })
}

const FAST_FILES = [
  'src/server/__tests__/agents.test.ts',
  'src/server/__tests__/guide.test.ts',
  'src/server/__tests__/plain.test.ts',
  'src/shared/__tests__/shared.test.ts',
]

describe('selectAffectedTests over a temporary repository', () => {
  test('a leaf-module change selects every fast-tier file for the --changed pass', () => {
    initRepo()
    stage('src/leaf.ts', 'export const leaf = 2\n')
    const picked = selection()
    expect(picked.kind).toBe('source')
    expect(picked.declarationFiles).toEqual([])
    expect(picked.changedPassFiles).toEqual(FAST_FILES)
    expect(picked.slowTierExcluded).toBe(0)
    expect(picked.workingTreeContributors).toEqual([])
  })

  test('a docs change matched by @reads selects only the declaring tests', () => {
    initRepo()
    stage('docs/guide.md', '# guide v2\n')
    const picked = selection()
    expect(picked.kind).toBe('docs-only')
    expect(picked.declarationFiles).toEqual(['src/server/__tests__/guide.test.ts'])
    expect(picked.changedPassFiles).toEqual([])
    expect(picked.slowTierExcluded).toBe(1)
    expect(picked.workingTreeContributors).toEqual([])
  })

  test('a change nothing reaches still passes every fast-tier file to --changed', () => {
    initRepo()
    stage('src/stray.ts', 'export const stray = 1\n')
    const picked = selection()
    expect(picked.kind).toBe('source')
    expect(picked.declarationFiles).toEqual([])
    expect(picked.changedPassFiles).toEqual(FAST_FILES)
  })

  test('a lockfile or Bun pin change escapes before classification', () => {
    initRepo()
    stage('bun.lock', '')
    expect(selection().kind).toBe('escape')
    initRepo()
    stage('.bun-version', '1.4.4\n')
    const picked = selection()
    expect(picked.kind).toBe('escape')
    expect(picked.escapePaths).toEqual(['.bun-version'])
  })

  test('the escape fires ahead of the docs-only classification', () => {
    initRepo()
    stage('docs/guide.md', '# guide v2\n')
    stage('.bun-version', '1.4.4\n')
    const picked = selection()
    expect(picked.kind).toBe('escape')
    expect(picked.escapePaths).toEqual(['.bun-version'])
  })

  test('an unstaged escape path overrides a docs-only staging', () => {
    initRepo()
    stage('docs/guide.md', '# guide v2\n')
    writeRepoFile('.bun-version', '1.4.5\n')
    const picked = selection()
    expect(picked.kind).toBe('escape')
    expect(picked.escapePaths).toEqual(['.bun-version'])
    expect(picked.workingTreeContributors).toEqual(['.bun-version'])
  })

  test('a staged rename contributes both sides to the union', () => {
    initRepo()
    git(['mv', 'src/leaf.ts', 'src/leaf2.ts'])
    expect(collectChangedPaths(repoRoot).staged).toEqual(['src/leaf.ts', 'src/leaf2.ts'])
    expect(selection().kind).toBe('source')
  })

  test('a deleted test file leaves the passes', () => {
    initRepo()
    git(['rm', '-q', 'src/server/__tests__/plain.test.ts'])
    const picked = selection()
    expect(picked.changedPassFiles).not.toContain('src/server/__tests__/plain.test.ts')
    expect(picked.changedPassFiles).toContain('src/server/__tests__/agents.test.ts')
    expect(picked.kind).toBe('source')
  })

  test('an unstaged runtime-read edit contributes without being staged', () => {
    initRepo()
    stage('src/leaf.ts', 'export const leaf = 2\n')
    writeRepoFile('docs/guide.md', '# guide edited\n')
    const picked = selection()
    expect(picked.declarationFiles).toEqual(['src/server/__tests__/guide.test.ts'])
    expect(picked.workingTreeContributors).toEqual(['docs/guide.md'])
    expect(picked.changedPassFiles).not.toContain('src/server/__tests__/guide.test.ts')
  })

  test('a docs-only commit nothing declares runs no pass', () => {
    initRepo()
    stage('docs/other.md', '# other\n')
    const picked = selection()
    expect(picked.kind).toBe('docs-only')
    expect(picked.declarationFiles).toEqual([])
    expect(picked.changedPassFiles).toEqual([])
  })

  test('a test selected by both routes lands in one pass only', () => {
    initRepo()
    stage('docs/guide.md', '# guide v2\n')
    stage('src/leaf.ts', 'export const leaf = 2\n')
    const picked = selection()
    expect(picked.kind).toBe('source')
    expect(picked.declarationFiles).toEqual(['src/server/__tests__/guide.test.ts'])
    expect(picked.changedPassFiles).toEqual([
      'src/server/__tests__/agents.test.ts',
      'src/server/__tests__/plain.test.ts',
      'src/shared/__tests__/shared.test.ts',
    ])
    const overlap = picked.declarationFiles.filter((file) =>
      picked.changedPassFiles.includes(file)
    )
    expect(overlap).toEqual([])
  })
})

describe('runAffectedTests', () => {
  function literalSelection(partial: Partial<AffectedSelection>): AffectedSelection {
    return {
      kind: 'source',
      escapePaths: [],
      declarationFiles: [],
      changedPassFiles: [],
      slowTierExcluded: 0,
      workingTreeContributors: [],
      ...partial,
    }
  }

  interface PassCall {
    cmd: string[]
    reportPath: string
  }

  // A passing pass must leave a JUnit report at the path it was given, so a
  // scripted success takes the report content to write there (2.2).
  const junitReport = (file: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test"><testsuite name="t" file="${file}" tests="1" failures="0"></testsuite></testsuites>\n`

  function recorder(calls: PassCall[], exitCodes: number[], reports?: (string | undefined)[]) {
    return async (cmd: string[], reportPath: string): Promise<number> => {
      calls.push({ cmd, reportPath })
      const index = Math.min(calls.length - 1, exitCodes.length - 1)
      const report = reports?.[index]
      if (exitCodes[index] === 0 && report !== undefined) fs.writeFileSync(reportPath, report)
      return exitCodes[index]
    }
  }

  test('a runtime-only declaration match executes without --changed', async () => {
    initRepo()
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: repoRoot,
      selection: literalSelection({
        kind: 'docs-only',
        declarationFiles: ['src/server/__tests__/guide.test.ts'],
      }),
      runPass: recorder(calls, [0], [
        junitReport('./src/server/__tests__/guide.test.ts'),
      ]),
    })
    expect(outcome.code).toBe(0)
    expect(outcome.failures).toEqual([])
    expect(calls.length).toBe(1)
    expect(calls[0].cmd).not.toContain('--changed')
    expect(calls[0].cmd.slice(0, 5)).toEqual([
      'bun',
      expect.stringMatching(/\/scripts\/test-runner\.ts$/),
      '--skip-slow',
      '--reporter=junit',
      expect.stringMatching(/^--reporter-outfile=/),
    ])
    expect(calls[0].cmd.slice(-1)).toEqual(['./src/server/__tests__/guide.test.ts'])
    expect(outcome.executed).toEqual({
      declaration: ['src/server/__tests__/guide.test.ts'],
      changed: [],
    })
  })

  test('a source commit runs the declaration pass first, then --changed', async () => {
    initRepo()
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: repoRoot,
      selection: literalSelection({
        declarationFiles: ['src/server/__tests__/guide.test.ts'],
        changedPassFiles: ['src/server/__tests__/plain.test.ts'],
      }),
      runPass: recorder(
        calls,
        [0, 0],
        [
          junitReport('./src/server/__tests__/guide.test.ts'),
          junitReport('src/server/__tests__/plain.test.ts'),
        ]
      ),
    })
    expect(outcome.code).toBe(0)
    expect(calls.length).toBe(2)
    expect(calls[0].cmd).not.toContain('--changed')
    expect(calls[1].cmd).toContain('--changed')
    expect(calls[1].cmd.slice(-1)).toEqual(['./src/server/__tests__/plain.test.ts'])
    expect(calls[0].reportPath).not.toBe(calls[1].reportPath)
    expect(outcome.executed).toEqual({
      declaration: ['src/server/__tests__/guide.test.ts'],
      changed: ['src/server/__tests__/plain.test.ts'],
    })
  })

  test('two invocations never share a report path', async () => {
    initRepo()
    const paths: string[] = []
    const record = async (_cmd: string[], reportPath: string): Promise<number> => {
      paths.push(reportPath)
      return 0
    }
    const input = {
      root: repoRoot,
      selection: literalSelection({ declarationFiles: ['src/server/__tests__/guide.test.ts'] }),
    }
    await runAffectedTests({ ...input, runPass: record })
    await runAffectedTests({ ...input, runPass: record })
    expect(paths.length).toBe(2)
    expect(paths[0]).not.toBe(paths[1])
  })

  test('empty candidate lists skip their pass', async () => {
    initRepo()
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: repoRoot,
      selection: literalSelection({ kind: 'docs-only' }),
      runPass: recorder(calls, [0]),
    })
    expect(outcome.code).toBe(0)
    expect(calls).toEqual([])
    expect(outcome.lines).toEqual([
      'affected-tests: ran 0 test file(s) (declaration: 0, changed: 0); slow-tier candidates excluded: 0',
    ])
  })

  test('a failed declaration pass fails the run and stops the changed pass', async () => {
    initRepo()
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: repoRoot,
      selection: literalSelection({
        declarationFiles: ['src/server/__tests__/guide.test.ts'],
        changedPassFiles: ['src/server/__tests__/plain.test.ts'],
      }),
      runPass: recorder(calls, [1]),
    })
    expect(outcome.code).toBe(1)
    expect(outcome.failures).toEqual(['affected-tests: declaration pass failed (exit 1)'])
    expect(calls.length).toBe(1)
  })

  test('a failed changed pass fails the run', async () => {
    initRepo()
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: repoRoot,
      selection: literalSelection({
        changedPassFiles: ['src/server/__tests__/plain.test.ts'],
      }),
      // The empty declaration list skips its pass, so the run's first (and
      // only) invocation is the changed pass.
      runPass: recorder(calls, [3]),
    })
    expect(outcome.code).toBe(1)
    expect(outcome.failures).toEqual(['affected-tests: changed pass failed (exit 3)'])
    expect(calls.length).toBe(1)
    expect(calls[0].cmd).toContain('--changed')
  })

  test('the escape delegates to the full check and runs no pass', async () => {
    initRepo()
    const calls: PassCall[] = []
    let fullChecks = 0
    const outcome = await runAffectedTests({
      root: repoRoot,
      selection: literalSelection({ kind: 'escape', escapePaths: ['bun.lock'] }),
      runPass: recorder(calls, [0]),
      runFullCheck: async () => {
        fullChecks += 1
        return 7
      },
    })
    expect(outcome.code).toBe(7)
    expect(outcome.fullCheckExit).toBe(7)
    expect(fullChecks).toBe(1)
    expect(calls).toEqual([])
    expect(outcome.lines).toEqual([
      'affected-tests: escape matched bun.lock; running the full check',
    ])
  })
})

describe('isDocsOnlyPath mirrors the shell rule', () => {
  test('documentation paths pass and runtime paths fail', () => {
    for (const doc of [
      'AGENTS.md',
      'docs/guide.md',
      'docs/shot.png',
      'openspec/changes/demo/proposal.md',
      'openspec/changes/demo/.openspec.yaml',
      'notes.txt',
      'manual.rst',
      'LICENSE',
      'LICENSE.APACHE',
      'CHANGELOG',
      'CHANGELOG.2.md',
    ]) {
      expect(isDocsOnlyPath(doc)).toBe(true)
    }
    for (const source of ['src/leaf.ts', 'scripts/test-runner.ts', 'docs.ts', 'package.json']) {
      expect(isDocsOnlyPath(source)).toBe(false)
    }
    expect(isDocsOnlyCommit([])).toBe(false)
    expect(isDocsOnlyCommit(['src/leaf.ts', 'AGENTS.md'])).toBe(false)
    expect(isDocsOnlyCommit(['AGENTS.md', 'docs/x.txt'])).toBe(true)
  })
})

describe('the D2 escape list', () => {
  test('machinery, manifests, hooks, and root configs escape', () => {
    for (const escaped of [
      'scripts/test-runner.ts',
      'scripts/check.ts',
      'scripts/affected-tests.ts',
      'scripts/test-preload.ts',
      'package.json',
      'bun.lock',
      '.bun-version',
      'bunfig.toml',
      '.githooks/pre-commit',
      'tsconfig.json',
      'tsconfig.node.json',
    ]) {
      expect(isEscapeCandidate(escaped)).toBe(true)
    }
    for (const kept of [
      'src/leaf.ts',
      'nested/tsconfig.json',
      'src/server/tsconfig.json',
      'scripts/lib/reads.ts',
    ]) {
      expect(isEscapeCandidate(kept)).toBe(false)
    }
  })

  test('a helper no test names escapes; an imported helper is left to --changed', () => {
    const helper = 'src/server/__tests__/helpers/fixture.ts'
    expect(findEscapePaths([helper], ['import { x } from "../helpers/fixture"'])).toEqual([])
    expect(
      findEscapePaths([helper], ['import { x } from "../helpers/other"'])
    ).toEqual([helper])
    expect(findEscapePaths(['src/leaf.ts'], [])).toEqual([])
  })

  test('a helper mention ends at a quote or a dot, so a stem is not a prefix', () => {
    const db = 'src/server/__tests__/helpers/db.ts'
    expect(findEscapePaths([db], ['import { pool } from "../helpers/dbSchema"'])).toEqual([db])
    expect(findEscapePaths([db], ['import { pool } from "../helpers/db"'])).toEqual([])
    expect(findEscapePaths([db], ['the helpers/db.test.ts fixtures load first'])).toEqual([])
  })
})

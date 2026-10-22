// preCommit.test.ts — the commit hook's decision table and its execution
// (per-result-suite task 3.1). planPreCommit is pure; runPreCommit runs
// against a spawn double that records every command, cwd, and environment,
// so each row's exact commands and exit handling are asserted. The real
// composition (a temporary repository, real git commit, the real check) is
// preCommitHook.integration.test.ts. Its fixture paths are strings only.
// @reads: AGENTS.md, docs/**
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { AffectedSelection, ChangedPaths } from '../affected-tests'
import { importClosure } from './helpers/importClosure'
import {
  FULL_CHECK,
  LINT,
  TYPECHECK,
  outsideSourcePaths,
  planPreCommit,
  runPreCommit,
  type PreCommitPlan,
  type SpawnRequest,
} from '../pre-commit'

const ROOT = '/repo'
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

function selection(overrides: Partial<AffectedSelection>): AffectedSelection {
  return {
    kind: 'source',
    escapePaths: [],
    declarationFiles: [],
    changedPassFiles: [],
    slowTierExcluded: 0,
    workingTreeContributors: [],
    ...overrides,
  }
}

function changed(overrides: Partial<ChangedPaths>): ChangedPaths {
  return { staged: [], unstaged: [], untracked: [], ...overrides }
}

// The runner's JUnit flag carries the report path; a double that "runs" a
// pass writes an empty report there so the run reads zero executed files.
function harness(exitFor: (command: string[]) => number = () => 0) {
  const calls: SpawnRequest[] = []
  const logs: string[] = []
  const errors: string[] = []
  const deps = {
    root: ROOT,
    env: { PATH: '/bin', HOME: '/home/x', GIT_INDEX_FILE: '/repo/.git/index.lock', GIT_DIR: '/repo/.git' },
    spawn: async (request: SpawnRequest) => {
      calls.push(request)
      const outfile = request.command.find((arg) => arg.startsWith('--reporter-outfile='))
      if (outfile !== undefined) {
        fs.writeFileSync(outfile.slice('--reporter-outfile='.length), '<testsuites></testsuites>')
      }
      return exitFor(request.command)
    },
    log: (line: string) => logs.push(line),
    error: (line: string) => errors.push(line),
  }
  return { deps, calls, logs, errors }
}

const commands = (calls: SpawnRequest[]) => calls.map((call) => call.command)
const isRunner = (command: string[]) => command.some((arg) => arg.endsWith('test-runner.ts'))

describe('planPreCommit', () => {
  test('a selection error plans the full check', () => {
    expect(planPreCommit({ ok: false, error: 'git diff failed' })).toEqual({
      kind: 'full',
      reason: 'selection failed (git diff failed); running the full check',
    })
  })

  test('an escape plans the full check, ahead of the empty-staged amend gate', () => {
    const escape = selection({ kind: 'escape', escapePaths: ['bun.lock'] })
    const plan = planPreCommit({ ok: true, changed: changed({ unstaged: ['bun.lock'] }), selection: escape, amendRecorded: true })
    expect(plan).toEqual({ kind: 'escape', selection: escape })
  })

  test('an empty staged diff with a recorded index tree plans lint and typecheck only', () => {
    const plan = planPreCommit({ ok: true, changed: changed({}), selection: selection({}), amendRecorded: true })
    expect(plan.kind).toBe('lint-typecheck')
  })

  test('an empty staged diff without a record plans the full check', () => {
    const plan = planPreCommit({ ok: true, changed: changed({}), selection: selection({}), amendRecorded: false })
    expect(plan.kind).toBe('full')
  })

  test('a staged change plans the partial run, naming working-tree source edits outside it', () => {
    const plan = planPreCommit({
      ok: true,
      changed: changed({ staged: ['src/a.ts'], unstaged: ['src/b.ts', 'notes.md'], untracked: ['src/c.ts'] }),
      selection: selection({}),
      amendRecorded: false,
    })
    expect(plan).toEqual({ kind: 'partial', selection: selection({}), outsideSourcePaths: ['src/b.ts', 'src/c.ts'] })
  })

  test('a docs-only commit reports no outside source paths: it runs no --changed pass', () => {
    const plan = planPreCommit({
      ok: true,
      changed: changed({ staged: ['AGENTS.md'], unstaged: ['src/b.ts'] }),
      selection: selection({ kind: 'docs-only' }),
      amendRecorded: false,
    })
    expect(plan).toMatchObject({ kind: 'partial', outsideSourcePaths: [] })
  })

  test('outsideSourcePaths drops staged paths and documentation', () => {
    expect(outsideSourcePaths(changed({ staged: ['src/a.ts'], unstaged: ['src/a.ts', 'docs/x.md'] }))).toEqual([])
  })
})

describe('runPreCommit', () => {
  test('the full plan runs exactly `bun run check`, with GIT_* stripped', async () => {
    const { deps, calls } = harness()
    expect(await runPreCommit({ kind: 'full', reason: 'r' }, deps)).toBe(0)
    expect(commands(calls)).toEqual([FULL_CHECK])
    expect(calls[0].cwd).toBe(ROOT)
    expect(calls[0].env).toEqual({ PATH: '/bin', HOME: '/home/x' })
  })

  test('an escape runs only the full check, and its exit is the hook exit (I3)', async () => {
    const { deps, calls, logs } = harness(() => 3)
    const plan: PreCommitPlan = { kind: 'escape', selection: selection({ kind: 'escape', escapePaths: ['bun.lock'] }) }
    expect(await runPreCommit(plan, deps)).toBe(3)
    expect(commands(calls)).toEqual([FULL_CHECK])
    expect(Object.keys(calls[0].env).some((name) => name.startsWith('GIT_'))).toBe(false)
    expect(logs.join('\n')).toContain('escape matched bun.lock; running the full check')
  })

  test('an escape through an unstaged path only still runs the full check (I3)', async () => {
    const { deps, calls, logs } = harness()
    const escape = selection({ kind: 'escape', escapePaths: ['package.json'], workingTreeContributors: ['package.json'] })
    const plan = planPreCommit({ ok: true, changed: changed({ staged: ['src/a.ts'], unstaged: ['package.json'] }), selection: escape, amendRecorded: false })
    expect(await runPreCommit(plan, deps)).toBe(0)
    expect(commands(calls)).toEqual([FULL_CHECK])
    expect(logs.join('\n')).toContain('unstaged/untracked paths affected selection: package.json')
  })

  test('the amend fast path runs lint and typecheck and no tests', async () => {
    const { deps, calls } = harness()
    expect(await runPreCommit({ kind: 'lint-typecheck', reason: 'r' }, deps)).toBe(0)
    expect(commands(calls)).toEqual([LINT, TYPECHECK])
  })

  test('a source commit runs lint, typecheck, the declaration pass, then --changed', async () => {
    const { deps, calls, logs } = harness()
    const plan: PreCommitPlan = {
      kind: 'partial',
      selection: selection({ declarationFiles: ['src/x.test.ts'], changedPassFiles: ['src/y.test.ts'] }),
      outsideSourcePaths: ['src/wip.ts'],
    }
    expect(await runPreCommit(plan, deps)).toBe(0)
    const ran = commands(calls)
    expect(ran.slice(0, 2)).toEqual([LINT, TYPECHECK])
    expect(ran).toHaveLength(4)
    expect(ran[2]).toContain('./src/x.test.ts')
    expect(ran[2]).not.toContain('--changed')
    expect(ran[3]).toContain('--changed')
    expect(ran[3]).toContain('./src/y.test.ts')
    expect(ran.slice(2).every((command) => isRunner(command) && command.includes('--skip-slow'))).toBe(true)
    expect(ran).not.toContainEqual(FULL_CHECK)
    for (const call of calls) {
      expect(Object.keys(call.env).some((name) => name.startsWith('GIT_'))).toBe(false)
    }
    expect(logs.join('\n')).toContain('working-tree source edits outside this commit may have selected tests: src/wip.ts')
  })

  test('a docs-only commit runs no --changed pass', async () => {
    const { deps, calls } = harness()
    const plan: PreCommitPlan = {
      kind: 'partial',
      selection: selection({ kind: 'docs-only', declarationFiles: ['src/agents.test.ts'] }),
      outsideSourcePaths: [],
    }
    expect(await runPreCommit(plan, deps)).toBe(0)
    const ran = commands(calls)
    expect(ran).toHaveLength(3)
    expect(ran[2]).toContain('./src/agents.test.ts')
    expect(ran.some((command) => command.includes('--changed'))).toBe(false)
  })

  test('a docs-only commit nothing declares runs lint and typecheck only', async () => {
    const { deps, calls } = harness()
    const plan: PreCommitPlan = { kind: 'partial', selection: selection({ kind: 'docs-only' }), outsideSourcePaths: [] }
    expect(await runPreCommit(plan, deps)).toBe(0)
    expect(commands(calls)).toEqual([LINT, TYPECHECK])
  })

  test.each([
    ['lint', LINT, 1],
    ['typecheck', TYPECHECK, 2],
  ] as const)('a failing %s aborts with its exit code and runs nothing after it', async (_name, failing, ranBefore) => {
    const { deps, calls, errors } = harness((command) => (command === failing ? 7 : 0))
    const plan: PreCommitPlan = {
      kind: 'partial',
      selection: selection({ changedPassFiles: ['src/y.test.ts'] }),
      outsideSourcePaths: [],
    }
    expect(await runPreCommit(plan, deps)).toBe(7)
    expect(calls).toHaveLength(ranBefore)
    expect(errors.join('\n')).toContain('failed (exit 7)')
  })

  test('a failing test pass fails the hook', async () => {
    const { deps } = harness((command) => (isRunner(command) ? 1 : 0))
    const plan: PreCommitPlan = {
      kind: 'partial',
      selection: selection({ changedPassFiles: ['src/y.test.ts'] }),
      outsideSourcePaths: [],
    }
    expect(await runPreCommit(plan, deps)).toBe(1)
  })
})

describe('the commit hook never writes a record (I1)', () => {
  test('pre-commit.ts imports no record writer', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, '..', 'pre-commit.ts'), 'utf8')
    expect(source).not.toMatch(/writeRecord|removeRecord|runCheck\b/)
    expect(source).toContain("from './lib/treeRecord'")
    // The walk reaches every module pre-commit.ts loads (F-u3): a record
    // writer imported through any of them would write a partial check's
    // record, so only the defining modules may mention the names at all.
    const closure = importClosure(['scripts/pre-commit.ts'])
    expect(closure).toEqual(
      expect.arrayContaining(['scripts/lib/treeRecord.ts', 'scripts/lib/checkRecords.ts', 'scripts/lib/checkRun.ts'])
    )
    const writer = /writeRecord|removeRecord|runCheck\b/
    const offenders = closure.filter(
      (file) =>
        file !== 'scripts/lib/checkRecords.ts' &&
        file !== 'scripts/lib/checkRun.ts' &&
        writer.test(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})

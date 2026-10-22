// preCommitHook.integration.test.ts — the commit hook end to end (per-result-
// suite task 3.1; the MODIFIED "The commit hook reuses recorded passes"
// scenarios; I1 and I3). Real `git commit` in a temporary repository runs
// this checkout's scripts/pre-commit.ts through core.hooksPath; the real
// test runner runs the fixture's tests, and the real scripts/check.ts runs
// stub lint/typecheck/test steps and writes real records. The log names
// every step and test a commit ran.
// @reads: AGENTS.md, docs/**
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { indexTreeRecorded } from '../pre-commit'
import { createHookRepo, type HookRepo } from './helpers/hookRepo'

let fixture: HookRepo

beforeEach(() => {
  fixture = createHookRepo()
})

afterEach(() => {
  fixture.remove()
})

const FULL_CHECK_STEPS = ['step:lint', 'step:typecheck', 'step:test']
const LINT_TYPECHECK = ['step:lint', 'step:typecheck']

function stage(relative: string, content: string): void {
  fixture.write(relative, content)
  fixture.git(['add', relative])
}

describe('the commit hook in a temporary repository', () => {
  test('a source change runs lint, typecheck, and only its affected test, and records nothing (I1)', () => {
    stage('src/shared/leaf.ts', 'export const leaf = 1 // edited\n')
    const result = fixture.commit(['-m', 'leaf'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([...LINT_TYPECHECK, 'ran:leaf'])
    expect(result.output).toContain('ran 1 test file(s) (declaration: 0, changed: 1)')
    expect(fixture.records()).toEqual([])
  })

  test('a docs-only change declared by a test runs that test with lint and typecheck, and records nothing (I1)', () => {
    stage('AGENTS.md', '# agents, edited\n')
    const result = fixture.commit(['-m', 'agents'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([...LINT_TYPECHECK, 'ran:agents'])
    expect(fixture.records()).toEqual([])
  })

  test('a docs-only change nothing declares runs lint and typecheck only, and records nothing (I1)', () => {
    stage('docs/guide.md', '# guide, edited\n')
    const result = fixture.commit(['-m', 'guide'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(LINT_TYPECHECK)
    expect(fixture.records()).toEqual([])
  })

  test('a change no test reaches runs lint and typecheck and no test file, and records nothing (I1)', () => {
    stage('src/shared/lone.ts', 'export const lone = 2\n')
    const result = fixture.commit(['-m', 'lone'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(LINT_TYPECHECK)
    expect(result.output).toContain('ran 0 test file(s)')
    expect(fixture.records()).toEqual([])
  })

  test('a failing affected test refuses the commit', () => {
    stage('src/shared/leaf.ts', 'export const leaf = 2\n')
    const head = fixture.git(['rev-parse', 'HEAD'])
    const result = fixture.commit(['-m', 'broken leaf'])
    expect(result.code).not.toBe(0)
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(head)
  })

  test('an escape path runs the full check, which records the tree (I3)', () => {
    stage('bun.lock', 'lock 2\n')
    const result = fixture.commit(['-m', 'lock'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(result.output).toContain('escape matched bun.lock; running the full check')
    expect(fixture.records()).toHaveLength(1)
  })

  test('an escape through an unstaged path alone still runs the full check (I3)', () => {
    stage('src/shared/lone.ts', 'export const lone = 3\n')
    fixture.write('bun.lock', 'lock 3, unstaged\n')
    const result = fixture.commit(['-m', 'lone with an unstaged lock'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(result.output).toContain('unstaged/untracked paths affected selection: bun.lock')
  })

  test('a failing full check on an escape refuses the commit (I3)', () => {
    stage('bun.lock', 'lock 4\n')
    fixture.fail('test')
    const result = fixture.commit(['-m', 'lock'])
    expect(result.code).not.toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(fixture.records()).toEqual([])
  })

  test('a repeated escape whose content key passed reports the recorded pass and runs no step', () => {
    stage('bun.lock', 'lock 5\n')
    expect(fixture.check().code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    const result = fixture.commit(['-m', 'lock'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([])
    expect(result.output).toContain('check: recorded pass')
  })

  test('a message-only amend after a full pass runs lint and typecheck only', () => {
    stage('src/shared/lone.ts', 'export const lone = 6\n')
    expect(fixture.commit(['-m', 'lone']).code).toBe(0)
    expect(fixture.check().code).toBe(0)
    const before = fixture.records()
    fixture.takeLog()
    const result = fixture.commit(['--amend', '-m', 'lone, reworded'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(LINT_TYPECHECK)
    expect(result.output).toContain('the index tree has a recorded full pass')
    expect(fixture.records()).toEqual(before)
  })

  test('a message-only amend beside an unstaged bun.lock edit runs the full check (I3)', () => {
    stage('src/shared/lone.ts', 'export const lone = 9\n')
    expect(fixture.commit(['-m', 'lone']).code).toBe(0)
    expect(fixture.check().code).toBe(0)
    fixture.takeLog()
    fixture.write('bun.lock', 'lock 9, unstaged\n')
    const result = fixture.commit(['--amend', '-m', 'lone, reworded'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(result.output).toContain('escape matched bun.lock; running the full check')
  })

  test('a message-only amend whose record is unreadable runs the full check (R3)', () => {
    stage('src/shared/lone.ts', 'export const lone = 10\n')
    expect(fixture.commit(['-m', 'lone']).code).toBe(0)
    expect(fixture.check().code).toBe(0)
    fixture.takeLog()
    const [name] = fixture.records()
    fs.writeFileSync(path.join(fixture.repo, '.git', 'kawai-checks', name), '{ not json')
    const result = fixture.commit(['--amend', '-m', 'lone, reworded'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(result.output).toContain('no recorded full pass for the index tree')
  })

  test('the amend gate reads no record when write-tree fails (R3)', () => {
    expect(indexTreeRecorded(fixture.root, undefined)).toBe(false)
    expect(indexTreeRecorded(fixture.repo, path.join(fixture.root, 'missing-dir', 'index'))).toBe(false)
  })

  test('a message-only amend of an unchecked commit runs the full check, which records the tree', () => {
    stage('src/shared/lone.ts', 'export const lone = 7\n')
    expect(fixture.commit(['--no-verify', '-m', 'lone, unchecked']).code).toBe(0)
    fixture.takeLog()
    const result = fixture.commit(['--amend', '-m', 'lone, reworded'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual(FULL_CHECK_STEPS)
    expect(fixture.records()).toHaveLength(1)
  })

  test('a broken unstaged source edit outside the commit refuses it, and the hook names the edit', () => {
    stage('src/shared/lone.ts', 'export const lone = 8\n')
    fixture.write('src/shared/leaf.ts', 'export const leaf = 2 // unstaged, broken\n')
    const result = fixture.commit(['-m', 'lone'])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(
      'working-tree source edits outside this commit may have selected tests: src/shared/leaf.ts'
    )
  })

  test('the shipped pre-commit shim refuses with a message outside a repository (R6)', () => {
    const [name, verb] = ['pre-commit', 'commit']
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside)
    const result = Bun.spawnSync(['sh', path.join(import.meta.dir, '..', '..', '.githooks', name)], {
      cwd: outside,
      env: { PATH: process.env.PATH ?? '', HOME: fixture.root, GIT_CEILING_DIRECTORIES: fixture.root },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(`${name}: cannot resolve the repository root; ${verb} refused`)
  })

  test('a working tree greener than the commit passes the commit hook: the push is the certificate', () => {
    stage('src/shared/leaf.ts', 'export const leaf = 2 // staged, broken\n')
    fixture.write('src/shared/leaf.ts', 'export const leaf = 1 // working tree, fixed\n')
    const result = fixture.commit(['-m', 'leaf, broken in the commit'])
    expect(result.code).toBe(0)
    expect(fixture.takeLog()).toEqual([...LINT_TYPECHECK, 'ran:leaf'])
    // The committed tree has no full-pass record; pre-push refuses it
    // (prePush.integration.test.ts).
    expect(fixture.records()).toEqual([])
  })
})

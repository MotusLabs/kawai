// agentRuntimeCheckIntegration.test.ts - The agent-runtime package inside the
// root checks (extract-agent-runtime 6.4). A package test run by the real
// runner inside the stock check pipeline (runCheck) fails the check and
// records nothing when it fails, and is named in the record's test list when
// it passes; the root typecheck command compiles the package's own NodeNext
// project after the root one and fails on a package-only type error; and the
// root lint script reaches package files. Each case runs the production code in a
// disposable tree and removes it. The collector's exactly-once listing lives
// in scripts/__tests__/packageCollection.test.ts.
// @reads: packages/agent-runtime/**
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { readRecord, recordsDir } from '../checks/checkRecords'
import { readTestList } from '../checks/testLists'
import { runCheck, type CheckStepSpec } from '../../../scripts/lib/checkRun'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'test-runner.ts')
const PACKAGE = 'packages/agent-runtime'
const BIN = path.join(REPO_ROOT, 'node_modules', '.bin')
const SCRIPTS = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

const owned: string[] = []

// A nested check owns its own report directory: the probe's steps never see
// an outer run's KAWAI_TEST_JUNIT_DIR, so a failing probe cannot write into
// the records of the check that runs this file.
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, KAWAI_TEST_WORKERS: '1' }
  delete env.KAWAI_TEST_JUNIT_DIR
  return env
}
afterAll(() => {
  for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true })
  try {
    fs.rmdirSync(path.join(REPO_ROOT, '.kawai-fixture-probes'))
  } catch {
    // another probe still holds the parent
  }
})

function tempTree(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  owned.push(dir)
  return dir
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function gitInit(dir: string): void {
  const inited = Bun.spawnSync(['git', 'init', '-q', dir], { env: cleanGitEnv() })
  if (inited.exitCode !== 0) throw new Error(`git init failed: ${inited.stderr.toString()}`)
}

/** Runs a root package.json script's command line through a shell in
 * `cwd`, with the repository's node_modules/.bin first on PATH, as
 * `bun run` would. */
function runSegment(segment: string, cwd: string): { code: number; output: string } {
  const result = Bun.spawnSync(['sh', '-c', segment], {
    cwd,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` }
}

describe('the agent-runtime package inside the root checks (6.4)', () => {
  // The probe repositories sit beneath the driving repository (ignored):
  // the child's bare --preload path resolves at the nearest bun project
  // root, which only the driving repository provides (runnerRoots.test.ts).
  function makeProbeRepo(packageTestBody: string): string {
    const parent = path.join(REPO_ROOT, '.kawai-fixture-probes')
    fs.mkdirSync(parent, { recursive: true })
    const repo = fs.mkdtempSync(path.join(parent, 'package-check-probe-'))
    owned.push(repo)
    gitInit(repo)
    for (const tree of ['src/server/__tests__', 'src/client/__tests__', 'src/shared/__tests__', 'scripts/__tests__']) {
      fs.mkdirSync(path.join(repo, tree), { recursive: true })
    }
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'test-preload.ts'), path.join(repo, 'scripts', 'test-preload.ts'))
    write(repo, 'packages/probe/__tests__/probe.test.ts', packageTestBody)
    return repo
  }

  const PROBE_STEPS: CheckStepSpec[] = [
    { name: 'lint', command: ['true'] },
    { name: 'typecheck', command: ['true'] },
    { name: 'test', command: [process.execPath, RUNNER, '--skip-real-tmux', '--no-retry'] },
  ]

  test('a failing package test fails the stock check at its test step and records nothing', async () => {
    const repo = makeProbeRepo("import { expect, test } from 'bun:test'\ntest('package probe fails', () => {\n  expect('package').toBe('root')\n})\n")
    const outcome = await runCheck({ cwd: repo, steps: PROBE_STEPS, env: probeEnv() })
    expect(outcome).toEqual({ kind: 'failed', step: 'test', exitCode: 1 })
    expect(fs.existsSync(recordsDir(repo)) ? fs.readdirSync(recordsDir(repo)).filter((name) => name.endsWith('.json')) : []).toEqual([])
  }, 60_000)

  test('a passing package test is recorded by name in the stock check\'s test list', async () => {
    const repo = makeProbeRepo("import { expect, test } from 'bun:test'\ntest('package probe passes', () => {\n  expect('package').toBe('package')\n})\n")
    const outcome = await runCheck({ cwd: repo, steps: PROBE_STEPS, env: probeEnv() })
    expect(outcome.kind).toBe('passed')
    if (outcome.kind !== 'passed') return
    const record = readRecord(recordsDir(repo), outcome.key)
    expect(record).not.toBeNull()
    const list = readTestList(recordsDir(repo), record!)
    expect(list?.map((entry) => [entry.file, entry.name, entry.status])).toEqual([
      ['packages/probe/__tests__/probe.test.ts', 'package probe passes', 'passed'],
    ])
  }, 60_000)

  test('the root typecheck command compiles the package project after the root one, and a package-only type error fails it', () => {
    const segments = SCRIPTS.typecheck!.split('&&').map((segment) => segment.trim())
    expect(segments[0]).toBe('tsc --noEmit')
    const packageSegment = segments.find((segment) => segment.includes(`${PACKAGE}/tsconfig.json`))
    expect(packageSegment).toBe(`tsc -p ${PACKAGE}/tsconfig.json`)
    // The package's own NodeNext project, whose include reaches its sources,
    // examples and tests; the root project stays the bundler one.
    const projectConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, PACKAGE, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { module: string; moduleResolution: string }
      include: string[]
    }
    expect([projectConfig.compilerOptions.module, projectConfig.compilerOptions.moduleResolution, projectConfig.include]).toEqual([
      'NodeNext',
      'NodeNext',
      ['src', 'examples', '__tests__'],
    ])
    // The whole root typecheck command runs in a disposable tree: a small
    // root project (the real one keeps incremental build info under the real
    // node_modules, which the tree links) and a copy of the package's
    // compiled inputs with its dependencies linked. Unchanged, both compile;
    // a package-only error fails the command after the root tsc succeeded;
    // a root error stops it before the package step.
    const tree = tempTree('agent-runtime-typecheck-')
    write(tree, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }))
    write(tree, 'src/rootProbe.ts', 'export const root: number = 1\n')
    const copy = path.join(tree, PACKAGE)
    fs.mkdirSync(copy, { recursive: true })
    for (const entry of ['src', 'examples', '__tests__', 'tsconfig.json', 'package.json']) {
      fs.cpSync(path.join(REPO_ROOT, PACKAGE, entry), path.join(copy, entry), { recursive: true })
    }
    fs.symlinkSync(path.join(REPO_ROOT, PACKAGE, 'node_modules'), path.join(copy, 'node_modules'))
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tree, 'node_modules'))
    const clean = runSegment(SCRIPTS.typecheck!, tree)
    expect([clean.code, clean.output]).toEqual([0, ''])
    write(tree, `${PACKAGE}/__tests__/typeProbe.test.ts`, "export const probe: number = 'not a number'\n")
    const packageBroken = runSegment(SCRIPTS.typecheck!, tree)
    expect(packageBroken.code).toBe(2)
    expect(packageBroken.output.trim().split('\n')).toEqual([`${PACKAGE}/__tests__/typeProbe.test.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`])
    write(tree, 'src/rootProbe.ts', "export const root: number = 'not a number'\n")
    const rootBroken = runSegment(SCRIPTS.typecheck!, tree)
    expect(rootBroken.code).toBe(2)
    expect(rootBroken.output.trim().split('\n')).toEqual([`src/rootProbe.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`])
  }, 60_000)

  test('the root lint script reaches package files: a package-only error fails it', () => {
    const tree = tempTree('agent-runtime-lint-')
    gitInit(tree)
    for (const config of ['oxlint.json', '.gitignore']) fs.copyFileSync(path.join(REPO_ROOT, config), path.join(tree, config))
    // A parse error is an error under any rule configuration, so the exit
    // code alone says whether the script linted the package file.
    write(tree, `${PACKAGE}/src/lintProbe.ts`, 'export const broken = (\n')
    const lint = runSegment(SCRIPTS.lint!, tree)
    expect(lint.code).toBe(1)
    expect(lint.output).toContain(`${PACKAGE}/src/lintProbe.ts`)
    expect(lint.output).toContain('Found 0 warnings and 1 error.')
  })
})

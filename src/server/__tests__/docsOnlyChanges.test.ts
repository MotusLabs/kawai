// docsOnlyChanges.test.ts - docs-only gate for the pre-commit hook (staged
// index) and CI (a PR's commit range). Renames must not hide a source-path
// side: git's rename detection reports only the
// destination, so `git mv src/runtime.ts docs/runtime.txt` would otherwise be
// classified as a docs-only commit and skip the unit suite while removing
// runtime code.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv, runGit } from '../git/gitCommand'

const repoRoot = path.resolve(import.meta.dir, '../../..')
const classifier = path.join(repoRoot, 'scripts/docs-only-changes.sh')

let tempRoot: string
let repo: string

function git(...args: string[]) {
  const result = runGit(args, { cwd: repo, timeoutMs: 5000 })
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function classify(...args: string[]) {
  const proc = Bun.spawnSync({
    cmd: [classifier, ...args],
    cwd: repo,
    // Scrub the git hook exports (GIT_DIR/GIT_INDEX_FILE/…): without this,
    // a run under the pre-commit hook classifies the real commit's index
    // instead of this fixture's, and every docs-only expectation fails.
    env: cleanGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return proc.exitCode
}

function isDocsOnly() {
  return classify() === 0
}

function commit(message: string) {
  git('add', '-A')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', message)
}

function write(relativePath: string, contents: string) {
  const absolute = path.join(repo, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-docsonly-'))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  git('init', '--initial-branch=main')
  write('README.md', '# repo\n')
  write('src/runtime.ts', 'export const runtime = 1\n')
  git('add', '.')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('docs-only-changes', () => {
  test('markdown-only changes are docs-only', () => {
    write('openspec/changes/demo/proposal.md', '# proposal\n')
    write('docs/guide.md', '# guide\n')
    write('CHANGELOG.md', '# changes\n')
    git('add', '.')
    expect(isDocsOnly()).toBe(true)
  })

  test('openspec yaml and docs images are docs-only', () => {
    write('openspec/changes/demo/.openspec.yaml', 'schema: 1\n')
    write('docs/shot.png', 'png')
    git('add', '.')
    expect(isDocsOnly()).toBe(true)
  })

  test('a single source file turns the suite back on', () => {
    write('README.md', '# readme\n')
    write('src/extra.ts', 'export const extra = 1\n')
    git('add', '.')
    expect(isDocsOnly()).toBe(false)
  })

  test('a lockfile is not documentation', () => {
    write('bun.lock', '{}\n')
    git('add', '.')
    expect(isDocsOnly()).toBe(false)
  })

  test('source-to-docs rename is not docs-only', () => {
    fs.mkdirSync(path.join(repo, 'docs'))
    git('mv', 'src/runtime.ts', 'docs/runtime.txt')
    expect(git('diff', '--cached', '--name-only').trim()).toBe('docs/runtime.txt')
    expect(isDocsOnly()).toBe(false)
  })

  test('source-to-openspec rename is not docs-only', () => {
    fs.mkdirSync(path.join(repo, 'openspec/changes/demo'), { recursive: true })
    git('mv', 'src/runtime.ts', 'openspec/changes/demo/runtime.md')
    expect(isDocsOnly()).toBe(false)
  })

  test('docs-to-docs rename stays docs-only', () => {
    write('docs/original.md', '# original\n')
    git('add', 'docs/original.md')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed doc')
    git('mv', 'docs/original.md', 'docs/renamed.md')
    expect(isDocsOnly()).toBe(true)
  })

  test('docs-to-source rename is not docs-only', () => {
    write('docs/original.md', '# original\n')
    git('add', 'docs/original.md')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed doc')
    git('mv', 'docs/original.md', 'src/from-docs.ts')
    expect(isDocsOnly()).toBe(false)
  })

  test('deleting source is not docs-only', () => {
    git('rm', 'src/runtime.ts')
    expect(isDocsOnly()).toBe(false)
  })

  test('deleting documentation is docs-only', () => {
    write('docs/old.md', '# old\n')
    git('add', 'docs/old.md')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed doc')
    git('rm', 'docs/old.md')
    expect(isDocsOnly()).toBe(true)
  })

  test('an empty index is docs-only', () => {
    expect(isDocsOnly()).toBe(true)
  })

  test('git env exported by the hook does not leak into the classifier', () => {
    // A pre-commit hook runs this suite with GIT_DIR/GIT_INDEX_FILE pointing
    // at the commit in progress; the classifier must still judge the fixture
    // repo. Without scrubbing, it reads the foreign index, sees its staged
    // source file, and answers "not docs-only" for a docs-only fixture. The
    // pollution must ride the spawn environment from process start — Bun's
    // default spawn env is the startup one, not runtime process.env edits —
    // so the check re-runs a docs-only expectation as a subprocess.
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-docsonly-foreign-'))
    const foreign = path.join(foreignRoot, 'repo')
    fs.mkdirSync(foreign)
    const gitInForeign = (...args: string[]) =>
      runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: foreign })
    if (!gitInForeign('init', '--initial-branch=main').ok) throw new Error('foreign init failed')
    fs.mkdirSync(path.join(foreign, 'src'), { recursive: true })
    fs.writeFileSync(path.join(foreign, 'src/runtime.ts'), 'export const runtime = 1\n')
    if (!gitInForeign('add', '.').ok) throw new Error('foreign add failed')
    try {
      const proc = Bun.spawnSync({
        cmd: [process.execPath, 'test', import.meta.path, '-t', 'an empty index is docs-only'],
        cwd: repoRoot,
        env: {
          ...process.env,
          GIT_DIR: path.join(foreign, '.git'),
          GIT_INDEX_FILE: path.join(foreign, '.git', 'index'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(0)
    } finally {
      fs.rmSync(foreignRoot, { recursive: true, force: true })
    }
  })
})

describe('docs-only-changes with a commit range', () => {
  beforeEach(() => {
    git('checkout', '-b', 'feature')
  })

  test('a range of docs-only commits is docs-only', () => {
    write('openspec/changes/demo/proposal.md', '# proposal\n')
    commit('docs: proposal')
    write('docs/guide.md', '# guide\n')
    commit('docs: guide')
    expect(classify('main...HEAD')).toBe(0)
  })

  test('one source commit in the range is not docs-only', () => {
    write('docs/guide.md', '# guide\n')
    commit('docs: guide')
    write('src/extra.ts', 'export const extra = 1\n')
    commit('feat: extra')
    expect(classify('main...HEAD')).toBe(1)
  })

  test('a source-to-docs rename in the range is not docs-only', () => {
    fs.mkdirSync(path.join(repo, 'docs'))
    git('mv', 'src/runtime.ts', 'docs/runtime.txt')
    commit('move runtime')
    expect(classify('main...HEAD')).toBe(1)
  })

  test('the staged index is ignored in range mode', () => {
    write('docs/guide.md', '# guide\n')
    commit('docs: guide')
    write('src/staged.ts', 'export const staged = 1\n')
    git('add', 'src/staged.ts')
    expect(classify('main...HEAD')).toBe(0)
  })

  test('an unknown range fails instead of reading as docs-only', () => {
    expect(classify('0000000000000000000000000000000000000000...HEAD')).toBe(2)
  })
})

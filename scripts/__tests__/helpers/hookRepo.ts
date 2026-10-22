// hookRepo.ts — a temporary repository wired to THIS checkout's hook scripts
// (per-result-suite tasks 3.1–3.2). core.hooksPath points at shims that exec
// scripts/pre-commit.ts and scripts/pre-push.ts by absolute path, and the
// repository's package.json runs the REAL scripts/check.ts, whose lint,
// typecheck, and test steps are stubs that log their name and fail or dirty
// the tree on request. Its unit tests run through the real test runner.
// A local bare repository is the push remote. Every git spawn uses
// cleanGitEnv, so a hook running this suite never redirects into the real
// repository.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv, runGit } from '../../../src/server/git/gitCommand'

const CHECKOUT = path.resolve(import.meta.dir, '..', '..', '..')
const IDENTITY = ['-c', 'user.name=hook-test', '-c', 'user.email=hook-test@example.com']

// Each stub step and each fixture test appends one line to the log, so a
// test asserts exactly what a hook ran.
const STUB = `import fs from 'node:fs'
import path from 'node:path'
const name = process.argv[2]
const dir = process.env.HOOK_STUB_DIR
fs.appendFileSync(path.join(dir, 'log'), 'step:' + name + '\\n')
if (fs.existsSync(path.join(dir, 'dirty-' + name))) fs.writeFileSync('stray-' + name + '.txt', 'x')
process.exit(fs.existsSync(path.join(dir, 'fail-' + name)) ? 1 : 0)
`

const fixtureTest = (name: string, body: string, header = '') => `${header}import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'
${body}
test('${name}', () => {
  fs.appendFileSync(path.join(process.env.HOOK_STUB_DIR ?? '', 'log'), 'ran:${name}\\n')
  check()
})
`

export interface RunResult {
  code: number
  output: string
}

export interface HookRepo {
  root: string
  repo: string
  remote: string
  stubDir: string
  git(args: string[]): string
  write(relative: string, content: string): void
  /** Steps and tests run since the last call, in order. */
  takeLog(): string[]
  fail(step: string): void
  dirty(step: string): void
  clearRequests(): void
  commit(args: string[]): RunResult
  push(args: string[]): RunResult
  check(): RunResult
  records(): string[]
  remove(): void
}

function spawn(cmd: string[], cwd: string, stubDir: string): RunResult {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...cleanGitEnv(), HOOK_STUB_DIR: stubDir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  })
  return {
    code: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

export function createHookRepo(): HookRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-hook-repo-'))
  const repo = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  const hooks = path.join(root, 'hooks')
  const stubDir = path.join(root, 'stub')
  for (const dir of [repo, hooks, stubDir]) fs.mkdirSync(dir)

  const git = (args: string[]) => {
    const result = runGit(args, { cwd: repo, timeoutMs: 30_000 })
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }
  const write = (relative: string, content: string) => {
    const target = path.join(repo, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }

  git(['init', '--initial-branch=main'])
  write(
    'package.json',
    JSON.stringify({
      name: 'hook-fixture',
      private: true,
      scripts: {
        lint: 'bun stub.ts lint',
        typecheck: 'bun stub.ts typecheck',
        test: 'bun stub.ts test',
        check: `bun ${path.join(CHECKOUT, 'scripts', 'check.ts')}`,
      },
    })
  )
  write('stub.ts', STUB)
  // The runner's bare `--preload scripts/test-preload.ts` resolves through
  // baseUrl, as in the real tsconfig.
  write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } }))
  write('scripts/test-preload.ts', fs.readFileSync(path.join(CHECKOUT, 'scripts', 'test-preload.ts'), 'utf8'))
  write('bun.lock', 'lock 1\n')
  write('AGENTS.md', '# agents\n')
  write('docs/guide.md', '# guide\n')
  write('src/shared/leaf.ts', 'export const leaf = 1\n')
  write('src/shared/lone.ts', 'export const lone = 1\n')
  write(
    'src/shared/__tests__/leaf.test.ts',
    fixtureTest('leaf', "import { leaf } from '../leaf'\nconst check = () => expect(leaf).toBe(1)")
  )
  write(
    'src/shared/__tests__/agents.test.ts',
    fixtureTest('agents', 'const check = () => {}', '// @reads: AGENTS.md\n')
  )
  write('src/shared/__tests__/other.test.ts', fixtureTest('other', 'const check = () => {}'))
  git(['add', '-A'])
  git([...IDENTITY, 'commit', '-m', 'fixture'])
  git(['init', '--bare', '--initial-branch=main', remote])
  git(['remote', 'add', 'origin', remote])

  fs.writeFileSync(
    path.join(hooks, 'pre-commit'),
    `#!/bin/sh\nexec bun ${path.join(CHECKOUT, 'scripts', 'pre-commit.ts')}\n`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(hooks, 'pre-push'),
    `#!/bin/sh\nexec bun ${path.join(CHECKOUT, 'scripts', 'pre-push.ts')} "$@"\n`,
    { mode: 0o755 }
  )
  git(['config', 'core.hooksPath', hooks])

  const logPath = path.join(stubDir, 'log')
  const recordsPath = path.join(repo, '.git', 'kawai-checks')
  return {
    root,
    repo,
    remote,
    stubDir,
    git,
    write,
    takeLog() {
      const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []
      fs.rmSync(logPath, { force: true })
      return lines
    },
    fail: (step) => fs.writeFileSync(path.join(stubDir, `fail-${step}`), ''),
    dirty: (step) => fs.writeFileSync(path.join(stubDir, `dirty-${step}`), ''),
    clearRequests() {
      for (const name of fs.readdirSync(stubDir)) {
        if (name.startsWith('fail-') || name.startsWith('dirty-')) fs.rmSync(path.join(stubDir, name))
      }
    },
    commit: (args) => spawn(['git', ...IDENTITY, 'commit', ...args], repo, stubDir),
    push: (args) => spawn(['git', 'push', ...args], repo, stubDir),
    check: () => spawn(['bun', 'run', 'check'], repo, stubDir),
    records: () =>
      fs.existsSync(recordsPath)
        ? fs.readdirSync(recordsPath).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort()
        : [],
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

// The scope fact (implementation-contract D6, table S1–S10) over real
// temporary repositories: the paths a result's commit changes since its
// merge base with origin's default branch, judged against the scope of the
// contract of the revision the result is pinned to. A rename is judged by
// both paths; the linked change's own directory is in scope, and no other
// change's; `*` never crosses `/`; at most 20 paths are listed. S8 and the
// no-gate scenario (I3) run through TaskService over a real store, in
// resultCheckTaskHandoffs.test.ts.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { computeResultFacts, makeCheckGit, type ResultCheckInput } from '../verification/resultChecks'
import type { ScopeInput } from '../verification/scopeFact'
import { serializeFacts } from '../verification/serializeFacts'
import { parseContract, type ImplementationContract } from '../../shared/implementationContract'
import type { ResultScopeFact } from '../../shared/teamTasks'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}
/** Long enough that git's rename detection pairs a moved file with its source. */
const BODY = Array.from({ length: 40 }, (_, line) => `export const line${line} = ${line}`).join('\n') + '\n'

const contractWith = (scope: string[]): ImplementationContract => {
  const text = ['## Implementation contract', '### Acceptance', '- A1: Works', '### Invariants', '### Scope',
    ...scope.map(glob => `- \`${glob}\``), '### Verification', '- V1: check passes', '### Excluded'].join('\n')
  const parsed = parseContract(text)
  if (!parsed.contract) throw new Error(JSON.stringify(parsed.problems))
  return parsed.contract
}
const TEAM_SCOPE = contractWith(['src/server/team/**'])

let tempRoot: string
let root: string
const git = (args: string[]) => {
  const result = runGit(args, { cwd: root, timeoutMs: 10_000, env: COMMIT_ENV })
  if (!result.ok) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
const write = (file: string, content = BODY) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}
const commitAll = (message: string) => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']) }

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-scope-fact-')))
  root = path.join(tempRoot, 'repo')
  fs.mkdirSync(root)
  runGit(['init', '-q', '--initial-branch=master', root], { timeoutMs: 10_000 })
  write('src/server/team/a.ts')
  write('src/shared/b.ts', BODY.replace(/line/g, 'other'))
  const base = commitAll('base')
  git(['update-ref', 'refs/remotes/origin/HEAD', base])
  git(['checkout', '-q', '-b', 'feature'])
})
afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

const input = (contract: ImplementationContract | null, linkedChange: string | null = 'c1'): ScopeInput =>
  ({ identity: 'r2#0123456789ab', contract, linkedChange })

async function scopeOf(scope: ScopeInput, given: string | null = git(['rev-parse', 'HEAD']), overrides: Partial<ResultCheckInput> = {}): Promise<ResultScopeFact> {
  const facts = await computeResultFacts({ given, worktree: null, repoRoot: root, others: [], host: { platform: process.platform, arch: process.arch }, scope, ...overrides }, makeCheckGit())
  return facts.scope!
}

// @covers: task-results › Kawai checks a result against its contract's scope › Everything in scope
test('S1: a team file and the linked change\'s tasks.md are within scope, naming no path, against the pinned identity', async () => {
  write('src/server/team/x.ts')
  write('openspec/changes/c1/tasks.md', '- [x] 1.1\n')
  commitAll('in scope')
  expect(await scopeOf(input(TEAM_SCOPE))).toEqual({
    status: 'pass', withinScope: true, outside: [], more: 0, contractIdentity: 'r2#0123456789ab', note: null,
  })
})

// @covers: task-results › Kawai checks a result against its contract's scope › Outside the scope
test('S2: a client file no glob matches is named, as a warning', async () => {
  write('src/server/team/x.ts')
  write('openspec/changes/c1/tasks.md', '- [x] 1.1\n')
  write('src/client/App.tsx')
  commitAll('one outside')
  expect(await scopeOf(input(TEAM_SCOPE))).toMatchObject({ status: 'warn', withinScope: false, outside: ['src/client/App.tsx'], more: 0 })
})

// @covers: task-results › Kawai checks a result against its contract's scope › Rename out of scope
test('S3: a rename is judged by both paths and listed by its new one, whichever side is outside', async () => {
  git(['mv', 'src/server/team/a.ts', 'src/shared/a.ts'])
  commitAll('move out')
  expect(await scopeOf(input(TEAM_SCOPE))).toMatchObject({ status: 'warn', outside: ['src/shared/a.ts'] })
  // The other direction: only the old path is outside, and the move still counts.
  git(['reset', '-q', '--hard', 'refs/remotes/origin/HEAD'])
  git(['mv', 'src/shared/b.ts', 'src/server/team/b.ts'])
  commitAll('move in')
  expect(git(['diff', '--name-status', '-M', 'HEAD~1', 'HEAD'])).toStartWith('R')
  expect(await scopeOf(input(TEAM_SCOPE))).toMatchObject({ status: 'warn', outside: ['src/server/team/b.ts'] })
})

// @covers: task-results › Kawai checks a result against its contract's scope › Many paths outside scope
test('S4: twenty-five paths outside scope list twenty and count five, and the stored facts keep the count', async () => {
  for (let index = 0; index < 25; index += 1) write(`docs/n${String(index).padStart(2, '0')}.md`, `${index}\n`)
  commitAll('many')
  const fact = await scopeOf(input(TEAM_SCOPE))
  expect(fact.outside).toHaveLength(20)
  expect(fact.outside[0]).toBe('docs/n00.md')
  expect(fact.more).toBe(5)
})

// @covers: task-results › The scope fact says when it cannot judge › Task without a contract
test('S5: a pinned revision without a contract reads no-contract and names no path, with or without a commit', async () => {
  write('src/client/App.tsx')
  commitAll('anything')
  const none: ResultScopeFact = { status: 'no-contract', withinScope: null, outside: [], more: 0, contractIdentity: 'r2#0123456789ab', note: null }
  expect(await scopeOf(input(null))).toEqual(none)
  expect(await scopeOf(input(null), null)).toEqual(none)
})

test('S6: a commit that does not resolve, or no commit, reads unknown with the reason', async () => {
  const unresolved = await scopeOf(input(TEAM_SCOPE), 'deadbeef'.repeat(5))
  expect(unresolved).toMatchObject({ status: 'unknown', withinScope: null, outside: [] })
  expect(unresolved.note).toBeTruthy()
  expect((await scopeOf(input(TEAM_SCOPE), null)).status).toBe('unknown')
})

test('S7: an unset base ref reads unknown, naming the ref and the fix', async () => {
  write('src/client/App.tsx')
  commitAll('outside, but no base')
  git(['update-ref', '-d', 'refs/remotes/origin/HEAD'])
  const fact = await scopeOf(input(TEAM_SCOPE))
  expect(fact).toMatchObject({ status: 'unknown', withinScope: null, outside: [] })
  expect(fact.note).toBe('refs/remotes/origin/HEAD is unset; git remote set-head origin --auto fixes it')
})

test('S9: `*` does not cross `/`: src/a/b.ts is outside `src/*.ts`, src/c.ts is inside', async () => {
  write('src/c.ts')
  write('src/a/b.ts')
  commitAll('star')
  expect(await scopeOf(input(contractWith(['src/*.ts']), null), git(['rev-parse', 'HEAD']))).toMatchObject({ outside: ['src/a/b.ts'] })
})

test('S10: only the linked change\'s directory is exempt; another change\'s design.md is listed', async () => {
  write('openspec/changes/c1/design.md', '# mine\n')
  write('openspec/changes/other/design.md', '# theirs\n')
  commitAll('two changes')
  expect(await scopeOf(input(TEAM_SCOPE))).toMatchObject({ outside: ['openspec/changes/other/design.md'] })
  // With no linked change, both are outside.
  expect((await scopeOf(input(TEAM_SCOPE, null))).outside).toEqual(['openspec/changes/c1/design.md', 'openspec/changes/other/design.md'])
})

test('a stored scope list shrinks with the others under 64 KB, its count preserved', async () => {
  for (let index = 0; index < 25; index += 1) write(`docs/n${String(index).padStart(2, '0')}.md`, `${index}\n`)
  commitAll('many')
  const facts = await computeResultFacts({ given: git(['rev-parse', 'HEAD']), worktree: null, repoRoot: root, others: [],
    host: { platform: process.platform, arch: process.arch }, scope: input(TEAM_SCOPE) }, makeCheckGit())
  // Twenty listed paths of 4 KB each are 80 KB: past the cap.
  const padded = { ...facts, scope: { ...facts.scope!, outside: facts.scope!.outside.map(file => `${file}/${'x'.repeat(4000)}`) } }
  const json = serializeFacts(padded)
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(64 * 1024)
  const stored = (JSON.parse(json) as typeof facts).scope!
  expect(stored.outside.length).toBeLessThan(20)
  expect(stored.outside.length + stored.more).toBe(25)
})

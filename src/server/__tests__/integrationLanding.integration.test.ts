// The integration-landing manager bench (integration-candidates PR A
// acceptance): `new ChatSessionManager` composes the landing registry, the
// integration store and mechanism, and Start's promotion read exactly as
// production does, over a local bare origin behind a GitHub-shaped remote
// with the stub `gh` (planExecutionBenchStubs.ts) acting on it and fixture
// agents. Nothing here calls a tick, a wake, or the executor: every advance
// comes from a production wake (Start's commit, a result or findings write,
// a mail change) or the 60 s timer's first pass, within the test's timeout.
// The stub's `move-<b>`/`rewrite-<b>` files stand in for the owner acting on
// the branch on GitHub just before Kawai's fast-forward.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PlanLanding } from '../../shared/plans'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { taskHandlers } from '../team/taskTools'
import { cleanGitEnv } from '../git/gitCommand'
import { planInput } from '../../shared/__tests__/planFixtures'
import { benchGhStub, benchOpenspecStub } from './planExecutionBenchStubs'
import { PromotionRunner } from '../plans/landing/integration/promotionRunner'
import { PromotionService } from '../plans/landing/integration/PromotionService'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const GITHUB_URL = 'https://github.com/acme/app.git'
const CHANGES = ['ib-a', 'ib-b', 'ib-c', 'ib-d', 'ib-e', 'ib-p']

let root: string
let repo: string
let origin: string
let bin: string
let manager: ChatSessionManager
let team: TeamIdentity
let human: { kind: 'human'; team: TeamIdentity }
const saved = { path: process.env.PATH, config: process.env.CLAUDE_CONFIG_DIR }

async function waitFor(check: () => boolean, label: string, ms = 30_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}
const originHead = (branch: string): string | null => {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8', env: cleanGitEnv() })
  return result.status === 0 ? result.stdout.trim() : null
}
const contains = (ancestor: string, descendant: string) =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: origin, env: cleanGitEnv() }).status === 0

const executions = () => (manager as unknown as { executionCore: { executionStore: import('../plans/execution/executionStore').ExecutionStore } }).executionCore.executionStore
const changeRow = (executionId: string, change: string) => executions().change(executionId, change)!
const db = () => (manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db
const candidates = (branch: string) => db().db.prepare(
  'SELECT seq, state, commit_sha AS commitSha, outside_json AS outside FROM plan_integration_candidates WHERE branch = ? ORDER BY seq',
).all(branch) as Array<{ seq: number; state: string; commitSha: string; outside: string | null }>

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-integration-bench-')))
  repo = path.join(root, 'repo')
  origin = path.join(root, 'origin.git')
  git(['init', '-q', '-b', 'master', repo])
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'middle-devs.md'), '---\nmax: 10\n---\nBuild.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), '---\nmax: 5\n---\nReview.')
  for (const change of CHANGES) {
    fs.mkdirSync(path.join(repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(repo, 'changes')
  git(['init', '-q', '--bare', '-b', 'master', origin])
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'master'], repo)
  git(['remote', 'set-url', 'origin', GITHUB_URL], repo)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], repo)

  bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const entries = git(['ls-tree', '-r', 'HEAD'], repo).trim().split('\n').map(line => {
    const [meta, file] = line.split('\t')
    return { path: file!, sha: meta!.split(' ')[2]!, type: 'blob' }
  })
  fs.writeFileSync(path.join(bin, 'trees.json'), JSON.stringify({ tree: entries }))
  fs.writeFileSync(path.join(bin, 'gh'), benchGhStub(path.join(bin, 'trees.json'), origin, bin), { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'openspec'), benchOpenspecStub(), { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ''}`

  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai', 'teams.json'), JSON.stringify({
    maxSpawnedSessions: 20, planExecution: { floorChecks: FLOOR, maxParallelChanges: 3, mergeMethod: 'merge' },
  }))
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  manager = new ChatSessionManager({
    db: initDatabase({ path: path.join(root, 'sessions.db') }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: () => {},
    queryFactory: params => {
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      const prompt = (async function* () {
        for await (const message of params.prompt) {
          fs.appendFileSync(file, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
          yield message
        }
      })()
      const fixture = fixtureQueryFactory({ ...params, prompt })
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
        yield* fixture
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  await manager.whenRestored()
  team = await resolveTeam(repo)
  human = { kind: 'human', team }
}, 30_000)

afterAll(() => {
  manager.shutdown()
  db().close()
  process.env.PATH = saved.path
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved.config
  fs.rmSync(root, { recursive: true, force: true })
})

/** A plan created, submitted, validated through the stub CLI, and approved as the human. */
async function approved(name: string, changes: Array<{ change: string; dependsOn?: string[] }>, landing: PlanLanding) {
  const { plan } = await manager.plans.create(human, {
    title: `Bench ${name}`,
    content: planInput({
      changes: changes.map(({ change, dependsOn = [] }) => ({ change, dependsOn, group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' })),
      roles: [{ group: 'middle-devs', profiles: [] }, { group: 'reviewers', profiles: [] }],
      reviewGroup: 'reviewers',
      landing,
    }),
  })
  const submitted = await manager.plans.submit(human, { plan_id: plan.id })
  if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`)
  const { revision, contentHash } = submitted.revision
  const validated = await manager.validation.validate(human, { planId: plan.id, revision })
  if (!validated.ok) throw new Error(`validation refused: ${validated.message}`)
  const done = await manager.plans.approve(human, { planId: plan.id, revision, contentHash, expectedApprovedRevision: null, commandId: `approve-${name}` })
  if (!done.ok) throw new Error(`approve refused: ${done.message} ${JSON.stringify(done.failures ?? [])}`)
  return { planId: plan.id, revision, contentHash }
}

async function started(name: string, changes: Array<{ change: string; dependsOn?: string[] }>, landing: PlanLanding) {
  const plan = await approved(name, changes, landing)
  const start = await manager.executions.start(human, { ...plan, commandId: `start-${name}` })
  if (!start.ok) throw new Error(`start refused: ${start.message} ${JSON.stringify((start as { failures?: unknown }).failures ?? [])}`)
  return { planId: plan.planId, executionId: start.execution.id }
}

const instruction = (executionId: string, change: string) => {
  const taskId = changeRow(executionId, change).taskId
  return taskId === null ? undefined : manager.tasks.store.assignmentsOf(taskId).at(-1)
}

async function implementer(executionId: string, change: string): Promise<string> {
  await waitFor(() => {
    const id = instruction(executionId, change)?.messageId
    return id != null && manager.mailbox.store.get(id)?.state === 'delivered'
  }, `${change}: implement instruction delivered`)
  const member = manager.mailbox.store.get(instruction(executionId, change)!.messageId!)!.claimedBy!
  await waitFor(() => manager.getSnapshot(member)?.status === 'waiting', `${change}: implementer idle`)
  return member
}

/** Implement in the change's worktree, submit through the tool, and pass review through the reviewer's tool. */
async function implementAndPass(executionId: string, change: string): Promise<string> {
  const member = await implementer(executionId, change)
  const row = changeRow(executionId, change)
  fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), 'export const done = true\n')
  commitAll(row.worktree!, `implement ${change}`)
  const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
  const result = await taskHandlers(manager.tasks, member, manager.results).task_submit_result!({
    task_id: row.taskId!, summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }],
  }) as { id: string }
  const review = () => manager.tasks.store.assignmentsOf(row.taskId!).find(entry => entry.handoffKind === 'review')
  await waitFor(() => {
    const id = review()?.messageId
    return id != null && manager.mailbox.store.get(id)?.state === 'delivered'
  }, `${change}: review delivered`)
  const reviewer = manager.mailbox.store.get(review()!.messageId!)!.claimedBy!
  await waitFor(() => manager.getSnapshot(reviewer)?.status === 'waiting', `${change}: reviewer idle`)
  await taskHandlers(manager.tasks, reviewer, manager.results).task_submit_findings!({
    task_id: row.taskId!, result_id: result.id, kind: 'review', verdict: 'pass', findings: 'Looks right.',
  })
  return commit
}

describe('the integration-landing manager bench', () => {
  test('(a) Start creates the branch at the default head before any provision; (b) the change fast-forwards it and a dependent provisions from the new head', async () => {
    const branch = 'int-ab'
    const master = originHead('master')!
    expect(originHead(branch)).toBeNull()
    const { planId, executionId } = await started('ab', [{ change: 'ib-a' }, { change: 'ib-b', dependsOn: ['ib-a'] }], { mode: 'integration-branch', branch })
    // (a) The execution-level effect creates the branch at the default head.
    await waitFor(() => changeRow(executionId, 'ib-a').baselineCommit !== null, 'ib-a: provisioned')
    expect(originHead(branch)).toBe(master)
    const effects = executions().effectsOf(executionId)
    const create = effects.find(effect => effect.kind === 'create-integration')!
    expect(create).toMatchObject({ state: 'done', change: null })
    const provisions = effects.filter(effect => effect.kind === 'provision')
    expect(provisions.map(effect => effect.change)).toEqual(['ib-a'])
    expect(create.finishedAt! <= provisions[0]!.createdAt).toBe(true)
    expect(changeRow(executionId, 'ib-a').baselineCommit).toBe(master)

    // (b) A passed change lands by a non-forced fast-forward; master is untouched.
    const commitA = await implementAndPass(executionId, 'ib-a')
    await waitFor(() => changeRow(executionId, 'ib-a').state === 'landed', 'ib-a: landed')
    const head = originHead(branch)!
    expect(contains(commitA, head)).toBe(true)
    expect(originHead('master')).toBe(master)
    expect(candidates(branch).map(candidate => candidate.state)).toEqual(['landed'])
    expect(executions().landings(planId)).toEqual([expect.objectContaining({ change: 'ib-a', mechanism: 'integration-branch', headSha: head, mergeSha: head, treeVerified: true })])
    expect(manager.tasks.store.get(changeRow(executionId, 'ib-a').taskId!)?.status).toBe('done')
    // The dependent provisions from the integration branch's new head and sees ib-a's work.
    await waitFor(() => changeRow(executionId, 'ib-b').worktree !== null && changeRow(executionId, 'ib-b').baselineCommit !== null, 'ib-b: provisioned')
    expect(changeRow(executionId, 'ib-b').baselineCommit).toBe(head)
    expect(fs.existsSync(path.join(changeRow(executionId, 'ib-b').worktree!, 'src', 'ib-a.ts'))).toBe(true)
  }, 120_000)

  test('(c) a branch moved by hand supersedes the candidate, keeps the change landing, and the next candidate flags the owner\'s commit', async () => {
    const branch = 'int-c'
    const { executionId } = await started('c', [{ change: 'ib-c' }], { mode: 'integration-branch', branch })
    await waitFor(() => originHead(branch) !== null, 'int-c: created')
    fs.writeFileSync(path.join(bin, `move-${branch}`), '')
    await implementAndPass(executionId, 'ib-c')
    await waitFor(() => changeRow(executionId, 'ib-c').state === 'landed', 'ib-c: landed')
    const owner = fs.readFileSync(path.join(bin, `moved-${branch}`), 'utf8').trim()
    const rows = candidates(branch)
    expect(rows.map(candidate => candidate.state)).toEqual(['superseded', 'landed'])
    expect((JSON.parse(rows[1]!.outside!) as Array<{ sha: string }>).map(commit => commit.sha)).toEqual([owner])
    expect(originHead(branch)).toBe(rows[1]!.commitSha)
    expect(contains(owner, rows[1]!.commitSha)).toBe(true)
  }, 120_000)

  test('(d) a rewritten branch stops the change as integration-rewritten naming the head and the missing commit; Kawai never forces it', async () => {
    const branch = 'int-d'
    const { planId, executionId } = await started('d', [{ change: 'ib-d' }], { mode: 'integration-branch', branch })
    await waitFor(() => originHead(branch) !== null, 'int-d: created')
    const created = originHead(branch)!
    fs.writeFileSync(path.join(bin, `rewrite-${branch}`), '')
    await implementAndPass(executionId, 'ib-d')
    await waitFor(() => changeRow(executionId, 'ib-d').state === 'stopped', 'ib-d: stopped')
    const rewritten = fs.readFileSync(path.join(bin, `rewritten-${branch}`), 'utf8').trim()
    const row = changeRow(executionId, 'ib-d')
    expect(row.stopReason).toBe('integration-rewritten')
    expect(row.stopDetail?.names).toEqual([rewritten, created])
    expect(originHead(branch)).toBe(rewritten)
    expect(executions().landings(planId)).toEqual([])
  }, 120_000)

  test('(e) direct mode in the same manager is unchanged: the pull request merges into master', async () => {
    const before = originHead('master')!
    const { planId, executionId } = await started('e', [{ change: 'ib-e' }], { mode: 'direct' })
    expect(executions().effectsOf(executionId).some(effect => effect.kind === 'create-integration')).toBe(false)
    await waitFor(() => changeRow(executionId, 'ib-e').baselineCommit !== null, 'ib-e: provisioned')
    expect(changeRow(executionId, 'ib-e').baselineCommit).toBe(before)
    await implementAndPass(executionId, 'ib-e')
    await waitFor(() => changeRow(executionId, 'ib-e').state === 'landed', 'ib-e: landed')
    const master = originHead('master')!
    expect(master).not.toBe(before)
    expect(executions().landings(planId)).toEqual([expect.objectContaining({ change: 'ib-e', mechanism: 'direct', mergeSha: master, treeVerified: true })])
    expect(candidates('master')).toEqual([])
  }, 120_000)

  test('Start reads the integration store\'s running promotion: promotion-idle refuses naming it', async () => {
    const plan = await approved('p', [{ change: 'ib-p' }], { mode: 'integration-branch', branch: 'int-p' })
    db().db.prepare(`INSERT INTO plan_promotions (id, team_id, plan_id, branch, number, command_id, from_sha, through_seq, target_branch,
      promotion_branch, floor_json, step, state, started_at) VALUES ('promo-p', ?, ?, 'int-p', 1, 'cmd', 'f', 0, 'master', 'promote/int-p', '{}', 'ci', 'running', 'now')`)
      .run(team.teamId, plan.planId)
    const refused = await manager.executions.start(human, { ...plan, commandId: 'start-p' })
    expect(refused.ok).toBe(false)
    const failure = ((refused as { failures?: Array<{ name: string; message: string }> }).failures ?? []).find(entry => entry.name === 'promotion-idle')
    expect(failure?.message).toContain('promo-p')
    expect(originHead('int-p')).toBeNull()
    // The composition registered the promotion holder kind (D10 step 3): a running promotion holds the slot, labelled by its branch.
    expect(executions().takeSlotFor(team.teamId, 'promotion', 'promo-p')).toBe(true)
    expect(executions().slotHolderLabel(team.teamId)).toBe('promote/int-p')
    executions().releaseSlotFor(team.teamId, 'promotion', 'promo-p')
  }, 60_000)

  test('the composition wires the promotion runner into the executor and the runtime, and the service onto the manager (I1)', () => {
    const runtime = (manager as unknown as { executionRuntime: { promotions: unknown; deps: { executor: { deps: { promotions: unknown } } } } }).executionRuntime
    expect(runtime.promotions).toBeInstanceOf(PromotionRunner)
    expect(runtime.deps.executor.deps.promotions).toBe(runtime.promotions)
    expect(manager.promotions).toBeInstanceOf(PromotionService)
  })
})

// The promotion manager bench (integration-candidates 9.1): `new
// ChatSessionManager` composes the promotion service, runner, effect queue,
// and shared landing slot exactly as production does, over a local bare
// origin behind a GitHub-shaped remote with the stub `gh`
// (planExecutionBenchStubs.ts) acting on it and fixture agents. Nothing here
// calls a tick, a wake, the runner, or the executor: every advance comes
// from a production wake (a committed Start, Promote, or Cancel, a result or
// findings write, a mail change) or the executor's timer. The stub's
// `move-master`, `pending-ci`, and `hang-<b>` files stand in for the owner
// pushing to master, CI still running, and the process dying in the middle
// of the integration branch's fast-forward; the restart is a second manager
// over the same database file.
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
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { benchGhStub, benchOpenspecStub } from './planExecutionBenchStubs'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const GITHUB_URL = 'https://github.com/acme/app.git'
const CHANGES = ['pa-1', 'pa-2', 'pb-1', 'pd-1', 'pc-1', 'pe-1']

let root: string
let repo: string
let origin: string
let bin: string
let manager: ChatSessionManager
let team: TeamIdentity
let human: { kind: 'human'; team: TeamIdentity }
const saved = { path: process.env.PATH, config: process.env.CLAUDE_CONFIG_DIR }

async function waitFor(check: () => boolean, label: string | (() => string), ms = 45_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${typeof label === 'string' ? label : label()}`)
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
const parents = (sha: string) => git(['rev-list', '--parents', '-n', '1', sha], origin).trim().split(' ').slice(1)
const contains = (ancestor: string, descendant: string) =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: origin, env: cleanGitEnv() }).status === 0

const executions = () => (manager as unknown as { executionCore: { executionStore: import('../plans/execution/executionStore').ExecutionStore } }).executionCore.executionStore
const changeRow = (executionId: string, change: string) => executions().change(executionId, change)!
const db = () => (manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db
const integration = () => new IntegrationStore(db().db)
const promotionOf = (id: string) => integration().promotion(id)!
const fastForwards = (branch: string) => fs.readFileSync(path.join(bin, 'fast-forwards'), 'utf8').trim().split('\n').filter(line => line === branch).length
const promotionDump = (id: string) => () => JSON.stringify({ promotion: promotionOf(id), effects: integration().promotionEffects(id), slot: executions().slot(team.teamId) })
const finishedEvents = (planId: string) => db().db.prepare("SELECT id FROM plan_events WHERE plan_id = ? AND kind = 'promotion-finished'").all(planId)

/** A manager over the bench's database file, its fixture agents writing transcripts the mailbox confirms. */
async function startManager(): Promise<ChatSessionManager> {
  const transcriptDir = path.join(root, 'claude', 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  const next = new ChatSessionManager({
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
  await next.whenRestored()
  return next
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-promotion-bench-')))
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
    maxSpawnedSessions: 20, planExecution: { floorChecks: FLOOR, maxParallelChanges: 3, mergeMethod: 'squash' },
  }))
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  manager = await startManager()
  team = await resolveTeam(repo)
  human = { kind: 'human', team }
}, 30_000)

afterAll(() => {
  manager.shutdown()
  db().close()
  const hung = path.join(bin, 'hung-pid')
  if (fs.existsSync(hung)) spawnSync('kill', [fs.readFileSync(hung, 'utf8').trim()])
  process.env.PATH = saved.path
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved.config
  fs.rmSync(root, { recursive: true, force: true })
})

/** A plan approved through the stub CLI's validation and started as the human. */
async function started(name: string, changes: Array<{ change: string; dependsOn?: string[] }>, landing: PlanLanding) {
  const { plan } = await manager.plans.create(human, {
    title: `Promotion bench ${name}`,
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
  const start = await manager.executions.start(human, { planId: plan.id, revision, contentHash, commandId: `start-${name}` })
  if (!start.ok) throw new Error(`start refused: ${start.message} ${JSON.stringify((start as { failures?: unknown }).failures ?? [])}`)
  return { planId: plan.id, executionId: start.execution.id }
}

const instruction = (executionId: string, change: string) => {
  const taskId = changeRow(executionId, change).taskId
  return taskId === null ? undefined : manager.tasks.store.assignmentsOf(taskId).at(-1)
}

/** Implement in the change's worktree, submit through the tool, and pass review through the reviewer's tool. */
async function implementAndPass(executionId: string, change: string): Promise<string> {
  await waitFor(() => {
    const id = instruction(executionId, change)?.messageId
    return id != null && manager.mailbox.store.get(id)?.state === 'delivered'
  }, `${change}: implement instruction delivered`)
  const member = manager.mailbox.store.get(instruction(executionId, change)!.messageId!)!.claimedBy!
  await waitFor(() => manager.getSnapshot(member)?.status === 'waiting', `${change}: implementer idle`)
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

/** One integration plan whose changes all land (each after the one before), its execution finished. */
async function landed(name: string, branch: string, changes: string[]): Promise<{ planId: string; commits: string[] }> {
  const { planId, executionId } = await started(name, changes.map((change, index) => ({ change, dependsOn: index === 0 ? [] : [changes[index - 1]!] })), { mode: 'integration-branch', branch })
  const commits: string[] = []
  for (const change of changes) {
    commits.push(await implementAndPass(executionId, change))
    await waitFor(() => changeRow(executionId, change).state === 'landed', `${change}: landed`)
  }
  await waitFor(() => executions().execution(executionId)?.state === 'finished', `${name}: execution finished`)
  return { planId, commits }
}

async function promote(planId: string, branch: string, commandId: string) {
  const fromSha = originHead(branch)!
  const outcome = await manager.promotions.promote(human, { planId, branch, fromSha, commandId })
  if (!outcome.ok) throw new Error(`promote refused: ${outcome.message} ${JSON.stringify(outcome.failures ?? [])}`)
  return { id: outcome.promotion.id, fromSha }
}

describe('the promotion manager bench (9.1)', () => {
  test('(a) two landings, then Promote merges with a merge commit and the integration branch moves to the verified head', async () => {
    const branch = 'int-pa'
    const { planId, commits } = await landed('a', branch, ['pa-1', 'pa-2'])
    const before = originHead('master')!
    expect(contains(commits[1]!, originHead(branch)!)).toBe(true)
    const { id, fromSha } = await promote(planId, branch, 'promote-a')
    await waitFor(() => promotionOf(id).state !== 'running', promotionDump(id))
    const promotion = promotionOf(id)
    expect(promotion).toMatchObject({ outcome: 'merged', treeVerified: true, fastForwarded: true, headSha: fromSha, promotionBranch: `${branch}--promote-1` })
    // A merge commit whatever the team's merge method (squash here): master's parents are its old head and the promoted head.
    const master = originHead('master')!
    expect(promotion.mergeSha).toBe(master)
    expect(parents(master)).toEqual([before, fromSha])
    expect(fs.readFileSync(path.join(bin, 'merge-args'), 'utf8').trim().split('\n').at(-1)).toContain('--merge')
    expect(originHead(branch)).toBe(promotion.headSha)
    expect(finishedEvents(planId)).toHaveLength(1)
    expect(executions().slot(team.teamId)).toBeNull()
  }, 180_000)

  test('(b) a target that moves once while CI runs returns to the up-to-date step and still merges', async () => {
    const branch = 'int-pb'
    const { planId } = await landed('b', branch, ['pb-1'])
    // The owner pushes to master the first time the promotion's CI is read.
    fs.writeFileSync(path.join(bin, 'move-master'), '')
    const { id, fromSha } = await promote(planId, branch, 'promote-b')
    await waitFor(() => promotionOf(id).state !== 'running', promotionDump(id))
    const owner = fs.readFileSync(path.join(bin, 'moved-master'), 'utf8').trim()
    const promotion = promotionOf(id)
    expect(promotion).toMatchObject({ outcome: 'merged', moves: 1, treeVerified: true })
    expect(promotion.headSha).not.toBe(fromSha)
    expect(contains(owner, promotion.headSha!)).toBe(true)
    expect(contains(fromSha, promotion.headSha!)).toBe(true)
    expect(parents(originHead('master')!)).toEqual([owner, promotion.headSha!])
  }, 180_000)

  test('(d) Cancel while CI runs closes the pull request and keeps the promotion and integration branches', async () => {
    const branch = 'int-pd'
    const { planId } = await landed('d', branch, ['pd-1'])
    const master = originHead('master')!
    fs.writeFileSync(path.join(bin, 'pending-ci'), '')
    try {
      const { id, fromSha } = await promote(planId, branch, 'promote-d')
      await waitFor(() => promotionOf(id).step === 'ci' && promotionOf(id).prNumber !== null, 'd: CI running')
      const cancelled = await manager.promotions.cancel(human, { promotionId: id, reason: 'Not this week', commandId: 'cancel-d' })
      expect(cancelled.ok).toBe(true)
      const pr = promotionOf(id).prNumber!
      await waitFor(() => fs.existsSync(path.join(bin, `closed-${pr}`)), 'd: pull request closed')
      expect(promotionOf(id)).toMatchObject({ state: 'finished', outcome: 'cancelled', cancelReason: 'Not this week', mergeSha: null })
      expect(originHead(`${branch}--promote-1`)).toBe(fromSha)
      expect(originHead(branch)).toBe(fromSha)
      expect(originHead('master')).toBe(master)
      expect(executions().slot(team.teamId)).toBeNull()
      expect(finishedEvents(planId)).toHaveLength(1)
    } finally { fs.rmSync(path.join(bin, 'pending-ci'), { force: true }) }
  }, 180_000)

  test('(e) direct mode in the same manager is unchanged: the pull request merges into master and nothing promotes', async () => {
    const before = originHead('master')!
    const { planId, executionId } = await started('e', [{ change: 'pe-1' }], { mode: 'direct' })
    expect(executions().effectsOf(executionId).some(effect => effect.kind === 'create-integration')).toBe(false)
    await implementAndPass(executionId, 'pe-1')
    await waitFor(() => changeRow(executionId, 'pe-1').state === 'landed', 'pe-1: landed')
    expect(originHead('master')).not.toBe(before)
    expect(executions().landings(planId)).toEqual([expect.objectContaining({ change: 'pe-1', mechanism: 'direct', treeVerified: true })])
    expect(integration().promotionsOf(planId)).toEqual([])
  }, 120_000)
  test('(c) a restart in the middle of the fast-forward inspects it, completes the promotion, and writes promotion-finished once', async () => {
    const branch = 'int-pc'
    const { planId } = await landed('c', branch, ['pc-1'])
    // The stub moves the branch, then hangs: the process dies with the effect running.
    fs.writeFileSync(path.join(bin, `hang-${branch}`), '')
    const landingForwards = fastForwards(branch)
    const { id } = await promote(planId, branch, 'promote-c')
    await waitFor(() => fs.existsSync(path.join(bin, 'hung-pid')), 'c: fast-forward hung')
    const effect = () => integration().promotionEffects(id).find(row => row.kind === 'fast-forward')!
    expect(effect().state).toBe('running')
    expect(promotionOf(id)).toMatchObject({ state: 'running', step: 'fast-forward', fastForwarded: null })
    const verified = promotionOf(id).headSha!
    expect(originHead(branch)).toBe(verified)
    manager.shutdown()
    db().close()

    manager = await startManager()
    await waitFor(() => promotionOf(id).state !== 'running', promotionDump(id))
    expect(effect().state).toBe('done')
    // Inspected, never repeated: the stub saw the one hung fast-forward of the branch.
    expect(fastForwards(branch)).toBe(landingForwards + 1)
    expect(promotionOf(id)).toMatchObject({ outcome: 'merged', fastForwarded: true })
    expect(originHead(branch)).toBe(verified)
    expect(finishedEvents(planId)).toHaveLength(1)
    // The hung call ends against a closed database: nothing more is written.
    spawnSync('kill', [fs.readFileSync(path.join(bin, 'hung-pid'), 'utf8').trim()])
    fs.rmSync(path.join(bin, 'hung-pid'))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(finishedEvents(planId)).toHaveLength(1)
  }, 180_000)

})

// The plan-execution manager bench (plan-execution rev 5 acceptance): the
// whole server path — `new ChatSessionManager` composes the executor, its
// runtime, the wakes, and the team services exactly as production does —
// over a local bare origin behind a GitHub-shaped remote, with stub `gh`
// and `openspec` executables on a private PATH and fixture agents. Nothing
// here calls `runtime.command`, `executor.wake`, or a tick, and the 60 s
// timer stays: every advance below comes from a production wake (Start's
// commit, a result write, a task change, a mail change, an archive, the
// plan-close hook) within seconds, or the test times out.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { taskHandlers } from '../team/taskTools'
import { cleanGitEnv } from '../git/gitCommand'
import { planInput } from '../../shared/__tests__/planFixtures'
import { benchGhStub, benchOpenspecStub } from './planExecutionBenchStubs'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const GITHUB_URL = 'https://github.com/acme/app.git'
const CHANGES = ['bench-a', 'bench-c', 'bench-d', 'bench-e', 'bench-g', 'bench-h', 'bench-i']

let root: string
let repo: string
let origin: string
let transcriptDir: string
let manager: ChatSessionManager
let team: TeamIdentity
let human: { kind: 'human'; team: TeamIdentity }
const saved = { path: process.env.PATH, config: process.env.CLAUDE_CONFIG_DIR }

async function waitFor(check: () => boolean, label: string, ms = 20_000): Promise<void> {
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
const writeGroup = (id: string, body: string) => fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), body)

// Read-only access to the one execution store the manager composed.
const executions = () => (manager as unknown as { executionCore: { executionStore: import('../plans/execution/executionStore').ExecutionStore } }).executionCore.executionStore
const changeRow = (executionId: string, change: string) => executions().change(executionId, change)!
const db = () => (manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-exec-bench-')))
  repo = path.join(root, 'repo')
  origin = path.join(root, 'origin.git')
  git(['init', '-q', '-b', 'master', repo])
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  writeGroup('middle-devs', '---\nmax: 10\n---\nBuild.')
  writeGroup('reviewers', '---\nmax: 5\n---\nReview.')
  writeGroup('held-devs', '---\nmax: 1\n---\nBuild, one at a time.')
  writeGroup('gone-devs', '---\nmax: 2\n---\nBuild, until the file goes.')
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

  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const entries = git(['ls-tree', '-r', 'HEAD'], repo).trim().split('\n').map(line => {
    const [meta, file] = line.split('\t')
    return { path: file!, sha: meta!.split(' ')[2]!, type: 'blob' }
  })
  fs.writeFileSync(path.join(bin, 'trees.json'), JSON.stringify({ tree: entries }))
  fs.writeFileSync(path.join(bin, 'gh'), benchGhStub(path.join(bin, 'trees.json')), { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'openspec'), benchOpenspecStub(), { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ''}`

  // The user-level settings (D16) live beside the profile catalog.
  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai', 'teams.json'), JSON.stringify({
    maxSpawnedSessions: 20, planExecution: { floorChecks: FLOOR, maxParallelChanges: 3, mergeMethod: 'merge' },
  }))
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  transcriptDir = path.join(configDir, 'projects', 'fixture')
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

/** A one-change plan, validated through the stub CLI, approved, and started as the human. */
async function started(change: string, group = 'middle-devs'): Promise<{ planId: string; revision: number; executionId: string }> {
  const { plan } = await manager.plans.create(human, {
    title: `Bench ${change}`,
    content: planInput({
      changes: [{ change, dependsOn: [], group, acceptance: [], extraChecks: [], guidance: '' }],
      roles: [{ group, profiles: [] }, { group: 'reviewers', profiles: [] }],
      reviewGroup: 'reviewers',
    }),
  })
  const submitted = await manager.plans.submit(human, { plan_id: plan.id })
  if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`)
  const { revision, contentHash } = submitted.revision
  const validated = await manager.validation.validate(human, { planId: plan.id, revision })
  if (!validated.ok) throw new Error(`validation refused: ${validated.message}`)
  const approved = await manager.plans.approve(human, { planId: plan.id, revision, contentHash, expectedApprovedRevision: null, commandId: `approve-${change}` })
  if (!approved.ok) throw new Error(`approve refused: ${approved.message} ${JSON.stringify(approved.failures ?? [])}`)
  const start = await manager.executions.start(human, { planId: plan.id, revision, contentHash, commandId: `start-${change}` })
  if (!start.ok) throw new Error(`start refused: ${start.message}`)
  return { planId: plan.id, revision, executionId: start.execution.id }
}

/** The change's instruction: the newest assignment of its task once dispatched. */
function instruction(executionId: string, change: string) {
  const taskId = changeRow(executionId, change).taskId
  return taskId === null ? undefined : manager.tasks.store.assignmentsOf(taskId).at(-1)
}

/** Wait for the implement instruction's delivery; returns the spawned implementer. */
async function implementer(executionId: string, change: string): Promise<string> {
  await waitFor(() => {
    const id = instruction(executionId, change)?.messageId
    return id != null && manager.mailbox.store.get(id)?.state === 'delivered'
  }, `${change}: implement instruction delivered`)
  const member = manager.mailbox.store.get(instruction(executionId, change)!.messageId!)!.claimedBy!
  await waitFor(() => manager.getSnapshot(member)?.status === 'waiting', `${change}: implementer idle`)
  return member
}

/** The implementer commits in the change's worktree and submits through the kawai-team tool. */
async function submit(executionId: string, change: string, member: string): Promise<{ commit: string; resultId: string }> {
  const row = changeRow(executionId, change)
  fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), 'export const done = true\n')
  commitAll(row.worktree!, `implement ${change}`)
  const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
  const tool = taskHandlers(manager.tasks, member, manager.results)
  const result = await tool.task_submit_result!({ task_id: row.taskId!, summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] }) as { id: string }
  return { commit, resultId: result.id }
}

const originHead = (branch: string): string | null => {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8', env: cleanGitEnv() })
  return result.status === 0 ? result.stdout.trim() : null
}

describe('the plan-execution manager bench', () => {
  test('(a) Start dispatches the implement attempt with the execution in its envelope; (b) a tool-submitted result pushes; (f) manual assign and accept refused', async () => {
    const { revision, executionId } = await started('bench-a')
    const member = await implementer(executionId, 'bench-a')
    const message = manager.mailbox.store.get(instruction(executionId, 'bench-a')!.messageId!)!
    // (a) The delivered envelope names the execution and its revision (D7).
    const transcripts = fs.readdirSync(transcriptDir).map(file => fs.readFileSync(path.join(transcriptDir, file), 'utf8'))
    const delivered = transcripts.find(text => text.includes(message.id))
    expect(delivered).toContain(`Execution: ${executionId} running plan revision ${revision}`)

    // (b) The result write alone wakes the executor: the round pushes to origin.
    const { commit, resultId } = await submit(executionId, 'bench-a', member)
    await waitFor(() => originHead('bench-a') === commit, 'bench-a: round pushed to origin', 10_000)
    const taskId = changeRow(executionId, 'bench-a').taskId!

    // (f) Ownership refuses a manual assign and an accept — as the human and as an agent.
    await expect(manager.assignments.dispatch(human, {
      taskId, target: { kind: 'group', id: 'middle-devs' }, instruction: 'take it over', requestKey: 'manual-human',
    })).rejects.toThrow('owned by a running execution')
    await expect(manager.assignments.dispatch({ kind: 'agent', sessionId: member }, {
      taskId, target: { kind: 'group', id: 'middle-devs' }, instruction: 'take it over', requestKey: 'manual-agent',
    })).rejects.toThrow('owned by a running execution')
    await expect(manager.results.accept(human, taskId, resultId)).rejects.toThrow('owned by a running execution')
    // An agent is refused before ownership is consulted: only Kawai created the task.
    await expect(manager.results.accept({ kind: 'agent', sessionId: member }, taskId, resultId)).rejects.toThrow("Only the task's creator")
    expect(manager.tasks.store.get(taskId)?.status).not.toBe('done')
  }, 60_000)

  test('(c) a human close of the owned task stops the change as task-closed', async () => {
    const { executionId } = await started('bench-c')
    await waitFor(() => instruction(executionId, 'bench-c') !== undefined, 'bench-c: dispatched')
    await manager.tasks.setStatus(human, changeRow(executionId, 'bench-c').taskId!, 'cancelled')
    await waitFor(() => changeRow(executionId, 'bench-c').state === 'stopped', 'bench-c: stopped')
    expect(changeRow(executionId, 'bench-c')).toMatchObject({ stopReason: 'task-closed' })
  }, 60_000)

  test('(d) a human cancel of the queued instruction stops the change as instruction-failed', async () => {
    // held-devs is at its max with a member outside the change's worktree,
    // so the instruction can neither be delivered nor spawn: it stays queued.
    const holder = await manager.createAvailableSession({ projectPath: repo, groupId: 'held-devs', name: 'holder' })
    if (!holder.ok) throw new Error(holder.error)
    const { executionId } = await started('bench-d', 'held-devs')
    await waitFor(() => {
      const id = instruction(executionId, 'bench-d')?.messageId
      return id != null && manager.mailbox.store.get(id)?.state === 'queued'
    }, 'bench-d: instruction queued')
    const cancelled = manager.mailbox.store.cancelResult(instruction(executionId, 'bench-d')!.messageId!, { kind: 'human' })
    expect(cancelled.ok).toBe(true)
    await waitFor(() => changeRow(executionId, 'bench-d').state === 'stopped', 'bench-d: stopped')
    expect(changeRow(executionId, 'bench-d')).toMatchObject({ stopReason: 'instruction-failed' })
  }, 60_000)

  test('(e) archiving the implementer lets release-before-review dispatch the review', async () => {
    const { executionId } = await started('bench-e')
    const member = await implementer(executionId, 'bench-e')
    // An approval card keeps the implementer from being released (not ready).
    await manager.send(member, 'please ask for approval')
    await waitFor(() => manager.getSnapshot(member)?.status === 'permission', 'bench-e: implementer awaiting approval')
    await submit(executionId, 'bench-e', member)
    await waitFor(() => changeRow(executionId, 'bench-e').step === 'releasing', 'bench-e: holding at releasing')
    const taskId = changeRow(executionId, 'bench-e').taskId!
    expect(manager.tasks.store.assignmentsOf(taskId).some(row => row.handoffKind === 'review')).toBe(false)
    // The human archives it: the archive wake alone runs the release step again.
    expect(manager.archive(member)).toEqual({ ok: true })
    await waitFor(() => manager.tasks.store.assignmentsOf(taskId).some(row => row.handoffKind === 'review'), 'bench-e: review dispatched', 10_000)
    expect(changeRow(executionId, 'bench-e')).toMatchObject({ state: 'gating', step: 'reviewing' })
  }, 60_000)

  test('(g) closing the plan stops the execution as Kawai, cancels its tasks, releases its members, and dispatches nothing more', async () => {
    const { planId, executionId } = await started('bench-g')
    const member = await implementer(executionId, 'bench-g')
    const taskId = changeRow(executionId, 'bench-g').taskId!
    const closed = await manager.plans.close(human, { planId, outcome: 'cancelled', reason: 'not needed', commandId: 'close-bench-g' })
    expect(closed.ok).toBe(true)
    // The hook is awaited by the close: everything below holds at once.
    expect(executions().execution(executionId)).toMatchObject({ state: 'finished', outcome: 'stopped', stopReason: 'plan-closed' })
    const stopEvent = manager.plans.store.events(planId).find(event => event.kind === 'execution-stopped')
    expect(stopEvent).toMatchObject({ actor: { kind: 'system', sessionId: null }, commandId: `exec:${executionId}:stop-for-plan` })
    expect(manager.tasks.store.get(taskId)?.status).toBe('cancelled')
    expect(changeRow(executionId, 'bench-g').state).toBe('cancelled')
    await waitFor(() => db().getChatSessions().find(row => row.sessionId === member)?.archivedAt != null, 'bench-g: member released')
    const mailCount = () => (db().db.prepare('SELECT COUNT(*) AS n FROM team_messages WHERE task_id = ?').get(taskId) as { n: number }).n
    const before = mailCount()
    // A later wake (another team change) dispatches nothing for it.
    await manager.tasks.create(human, { title: 'unrelated', direction: 'nudge the team' })
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(mailCount()).toBe(before)
    expect(manager.tasks.store.assignmentsOf(taskId)).toHaveLength(1)
  }, 60_000)

  test('(h) a dispatch refusal stops the change as instruction-failed and the process lives on', async () => {
    const { executionId } = await started('bench-h', 'gone-devs')
    // The group file goes after Start: the implement dispatch is refused.
    fs.rmSync(path.join(repo, '.kawai', 'groups', 'gone-devs.md'))
    try {
      await waitFor(() => changeRow(executionId, 'bench-h').state === 'stopped', 'bench-h: stopped')
      const row = changeRow(executionId, 'bench-h')
      expect(row).toMatchObject({ stopReason: 'instruction-failed', stopDetail: { stage: 'implement' } })
      expect(row.stopDetail?.refusal).toBeTruthy()
      // Still serving: a later Start on another plan works.
      expect(executions().execution(executionId)?.state).toBe('running')
    } finally {
      writeGroup('gone-devs', '---\nmax: 2\n---\nBuild, until the file goes.')
    }
  }, 60_000)

  test('(i) each production wake fires from its own source: task change, result write, archive', async () => {
    // Several sources often coincide (a close also settles mail), so each
    // seam is observed on its own: the runtime's executor wakes and the hub.
    type Internals = { executionRuntime: { deps: { executor: { wake: (teamId: string) => void } } }; executionCore: { wakes: Record<string, (id: string) => void> } }
    const internals = manager as unknown as Internals
    const executor = internals.executionRuntime.deps.executor
    const hub = internals.executionCore.wakes
    const woken: string[] = []
    const seen: string[] = []
    const originals = { wake: executor.wake, resultWrite: hub.resultWrite!, archived: hub.archived! }
    executor.wake = teamId => { woken.push(teamId); originals.wake.call(executor, teamId) }
    hub.resultWrite = taskId => { seen.push(`result:${taskId}`); originals.resultWrite(taskId) }
    hub.archived = sessionId => { seen.push(`archived:${sessionId}`); originals.archived(sessionId) }
    try {
      const { executionId } = await started('bench-i')
      const member = await implementer(executionId, 'bench-i')
      const taskId = changeRow(executionId, 'bench-i').taskId!
      // A task-store change of an owned task (no mail involved) wakes the team.
      woken.length = 0
      await manager.tasks.setStatus(human, taskId, 'blocked')
      expect(woken).toContain(team.teamId)
      await manager.tasks.setStatus(human, taskId, 'active')
      // The result write reaches the hub from the mailbox's result service.
      await submit(executionId, 'bench-i', member)
      expect(seen).toContain(`result:${taskId}`)
      // Every archive reaches the hub, after it succeeded.
      await waitFor(() => manager.getSnapshot(member)?.status === 'waiting' || manager.getSnapshot(member) == null, 'bench-i: member settled')
      if (db().getChatSessions().find(row => row.sessionId === member)?.archivedAt == null) manager.archive(member)
      expect(seen).toContain(`archived:${member}`)
      // A failed archive (an unknown session) never wakes.
      expect(manager.archive('no-such-session').ok).toBe(false)
      expect(seen).not.toContain('archived:no-such-session')
    } finally {
      executor.wake = originals.wake
      hub.resultWrite = originals.resultWrite
      hub.archived = originals.archived
    }
  }, 60_000)
})

// Apply through the composed server (plan-revision-apply oracle PC1, PC2;
// task 2.2's checkpoint). Every frame runs through the real WS router
// (`handleMessage`), ChatConnections and its execution connections, and the
// services `composePlanServices` builds with the team services, the
// started runtime, and the real executor — the construction the server
// runs. The change's branch lives on a real bare origin, so the composed
// branch-head read (`lsRemoteHead`) supplies the adapted fix's start
// commit. PC1: one change chosen continue and one adapted while its
// developer holds the attempt; the result carries the new revision, the
// adapted task has one new revision with its notice, the post-commit wake
// reaches the runtime, the executor's owed step dispatches the fix attempt
// naming the new revisions, and the next `team-plan-detail` lists both
// history rows. PC2: the same path with a stale expectedRevision is refused
// with nothing written.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { handleMessage, type MessageRouterContext } from '../ws/messageRouter'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { PlanExecutionWithRevisions } from '../../shared/planRevisionControl'
import { cleanGitEnv } from '../git/gitCommand'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import type { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { composeExecutionCore, composePlanServices } from '../plans/planComposition'
import { pauseHolderFacts } from '../plans/revisionControl/pauseTick'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { advanceExecutionRevision } from '../plans/execution/executionApplyStore'
import type { ExecutionRuntime } from '../plans/execution/executionRuntime'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'
import type { FloorMap } from '../../shared/planExecution'
import { createPlanWorld, sessionRow, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let world: PlanWorld
let bench: ImpactBench
let mail: MailboxStore
let tasks: TaskService
let composed: ReturnType<typeof composePlanServices>
let runtime: ExecutionRuntime
let messages: ServerMessage[]
let route: (frame: ClientMessage) => void
let uiHead: string

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

beforeAll(async () => {
  world = await createPlanWorld('kawai-apply-composition-')
  // origin: a bare repository holding each change's branch, read by the composed head read.
  const origin = path.join(world.root, 'origin.git')
  git(['init', '-q', '--bare', origin], world.root)
  git(['remote', 'add', 'origin', origin], world.repo)
  git(['branch', 'ui-branch'], world.repo)
  git(['branch', 'api-branch'], world.repo)
  git(['push', '-q', 'origin', 'ui-branch', 'api-branch'], world.repo)
  uiHead = git(['rev-parse', 'ui-branch'], world.repo)

  bench = createImpactBench(world)
  bench.records.set('dev', sessionRow('dev', 'middle-devs', world.feature))
  const core = composeExecutionCore(bench.db.db)
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  tasks = new TaskService(bench.tasks, {
    getSession: id => bench.records.get(id), homeDir: world.home, restoreSession: () => undefined, plans: bench.plans, ownership: core.ownership,
  })
  const releases = new MemberRelease(bench.db.db, {
    store: mail, tasks: bench.tasks, records: () => bench.records.values(), getRecord: id => bench.records.get(id),
    teamOf: () => world.team, definition: async () => undefined, cachedDefinition: () => undefined, recipient: () => undefined,
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: () => ({ ok: false as const, error: 'no archive in this test' }), notify: () => undefined,
  })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = () => world.team
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership: core.ownership,
  })
  const results = new TaskResultService(tasks, {
    getSession: id => bench.records.get(id), assignments, releases, records: () => bench.records.values(), homeDir: world.home,
    ownership: core.ownership, onWrite: taskId => core.wakes.resultWrite(taskId),
  })
  const teamMailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
  composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact: bench.impact, adapter: fakeAdapter(),
    getSession: id => bench.records.get(id), homeDir: world.home,
    caps: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionCore: core,
    executionTeam: {
      tasks, assignments, results, taskStore: bench.tasks, mailbox: mail, teamMailbox, releases,
      pendingSpawns: () => [], records: () => bench.records.values(),
      identityOf: id => (id === world.team.teamId ? world.team : undefined), teamOfSession: teamOf,
      supervision: { holder: () => null, blocker: () => null },
      pauseFacts: pauseHolderFacts({
        getRecord: id => bench.records.get(id), pendingRequest: () => false, hasLiveWorkers: () => false,
        hasRunningBackgroundTasks: () => false, parkedResumes: () => [], cooldownUntil: () => null,
      }),
    },
    executionValidation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-next', inputHash: 'ih-next', readiness: { carriedConditions: [] } } }),
    },
    executionProbe: async () => ({ findings: [], repo: null, base: null }),
  })
  bench.service = composed.plans
  runtime = composed.runtime!
  await runtime.start()

  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId, world.otherTeam.teamId] })
  const manager = {
    whenRestored: () => Promise.resolve(), teamScopes, plans: composed.plans, executions: composed.executions,
    impact: bench.impact, validation: composed.validation, validationDetail: composed.validationDetail,
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  messages = []
  const peer = { send: (message: ServerMessage) => { messages.push(message) } }
  const ctx = {
    hub: { send: (_ws: unknown, message: ServerMessage) => { messages.push(message) } },
    chatConnections: connections, chatPeer: () => peer,
  } as unknown as MessageRouterContext
  route = frame => handleMessage(ctx, {} as ServerWebSocket<never>, JSON.stringify(frame))
})

afterAll(() => {
  runtime.stop()
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)

async function until(probe: () => boolean, tries = 300): Promise<void> {
  for (let attempt = 0; attempt < tries && !probe(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

async function command(frame: ClientMessage & { requestId: string }) {
  route(frame)
  const answer = () => all('team-plan-result').find(message => message.requestId === frame.requestId) ?? all('error').at(-1)
  await until(() => answer() !== undefined)
  return answer()!
}

const counts = () => Object.fromEntries(['plan_events', 'plan_execution_revisions', 'plan_execution_publication_changes', 'team_task_revisions', 'team_messages', 'plan_execution_attempts']
  .map(table => [table, (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]))

let serial = 0

/**
 * A plan approved at revision 1 running api and ui, each with a task, a
 * claimed instruction held by session `dev`, and its dispatched implement
 * attempt; then revision 2 rewording both approved.
 */
async function runningWorld() {
  for (const row of composed.executionStore.ownedChanges(world.team.teamId)) composed.executionStore.finishExecution(row.executionId, 'completed')
  const draft = await bench.draftInReview()
  expect((await bench.approve(draft.planId, draft.revision)).ok).toBe(true)
  const store = composed.executionStore
  const execution = store.insertExecution({
    teamId: world.team.teamId, planId: draft.planId, revision: draft.revision, contentHash: draft.hash, reportId: 'rep-1', inputHash: 'ih-1',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: FLOOR as FloorMap },
    maxParallel: 2, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }],
  })
  new ExecutionRevisionStore(bench.db.db).recordAt(1, {
    executionId: execution.id, revision: draft.revision, contentHash: draft.hash, reportId: 'rep-1', inputHash: 'ih-1',
    appliedAt: execution.startedAt, rationale: null, commandId: null, payload: null,
  }, [])
  const held: Record<string, { taskId: string; assignmentId: string; mailId: string }> = {}
  for (const change of ['api', 'ui']) {
    const task = bench.tasks.create({ teamId: world.team.teamId, title: `${change} work`, direction: 'Build it', creator: { kind: 'human', sessionId: null } })
    const message = mail.enqueue({
      teamId: world.team.teamId, toKind: 'session', toId: 'dev', fromKind: 'human', fromSession: null, fromGroup: null,
      originPath: world.repo, body: `Build ${change}.`, taskId: task.id, actor: 'human',
    })
    const inserted = bench.assignmentStore.insert({
      teamId: world.team.teamId, taskId: task.id, requestKey: `rk-${change}-${++serial}`, targetKind: 'session', targetId: 'dev',
      role: null, instruction: `Build ${change}.`, creator: { kind: 'human', sessionId: null }, messageId: message.id,
    })
    mail.claim(message.id, 'dev')
    store.insertAttempt({
      executionId: execution.id, change, kind: 'implement', assignmentId: inserted.assignment.id, manifestHash: 'mh-1',
      manifest: { version: 1, plan: { id: draft.planId, revision: 1, contentHash: draft.hash }, execution: execution.id, task: { id: task.id, revision: 1 },
        validation: { reportId: 'rep-1', inputHash: 'ih-1' }, baseline: 'base', startCommit: 'base', artifacts: {}, roleProfiles: [] },
    })
    const row = store.change(execution.id, change)!
    expect(store.transition(execution.id, change, row, { state: 'implementing', worktree: world.repo, branch: `${change}-branch`, baselineCommit: 'base', taskId: task.id })).not.toBeNull()
    held[change] = { taskId: task.id, assignmentId: inserted.assignment.id, mailId: message.id }
  }
  const draftRow = bench.plans.getDraft(draft.planId, 'lead')!
  const content = bench.plans.revision(draft.planId, 1)!.content
  const saved = await bench.service.saveDraft(bench.agent('lead'), {
    plan_id: draft.planId, expected_draft_hash: draftRow.contentHash,
    content: { ...content, changes: content.changes.map(entry => ({ ...entry, guidance: `${entry.guidance} Revised for ${entry.change}.` })) },
  })
  if (!saved.ok) throw new Error(saved.message)
  const submitted = await bench.service.submit(bench.agent('lead'), { plan_id: draft.planId })
  if (!submitted.ok) throw new Error(submitted.message)
  expect((await bench.approve(draft.planId, submitted.revision.revision)).ok).toBe(true)
  return { planId: draft.planId, executionId: execution.id, held, target: submitted.revision }
}

const applyFrame = (running: Awaited<ReturnType<typeof runningWorld>>, requestId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'team-plan-execution-apply' as const, teamPath: world.repo, requestId,
  executionId: running.executionId, expectedRevision: 1, revision: running.target.revision, contentHash: running.target.contentHash,
  choices: { api: 'continue', ui: 'adapt' }, rationale: 'the owner rethought the store', commandId: `cmd-${requestId}`, ...overrides,
}) as ClientMessage & { requestId: string }

describe('Apply through the composed server (PC)', () => {
  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › Adapt notifies the developer
  test('PC1: Apply with one change continued and one adapted while held: the new revision, one task revision and notice, the wake, the executor\'s fix attempt naming it, and the next detail listing both revision rows', async () => {
    const applied = await runningWorld()
    route({ type: 'team-plan-open', teamPath: world.repo, planId: applied.planId })
    await until(() => all('team-plan-detail').length > 0)
    const pushedBefore = all('team-plan-detail').length
    const wake = spyOn(runtime, 'command')
    try {
      const answer = await command(applyFrame(applied, 'pc1'))
      expect(answer).toMatchObject({ type: 'team-plan-result', replayed: false, applied: { seq: 2, revision: applied.target.revision, contentHash: applied.target.contentHash } })
      const rows = (answer as { applied: { changes: Array<{ change: string; choice: string | null; taskRevision: number | null }> } }).applied.changes
      expect(rows.map(row => [row.change, row.choice, row.taskRevision])).toEqual([['api', 'continue', null], ['ui', 'adapt', 2]])
      // The post-commit wake reaches the composed runtime.
      expect(wake).toHaveBeenCalledWith(world.team.teamId)
    } finally {
      wake.mockRestore()
    }
    // One task revision with its notice to the holder; api untouched.
    expect(bench.tasks.get(applied.held.ui!.taskId)!.revision).toBe(2)
    expect(bench.tasks.get(applied.held.api!.taskId)!.revision).toBe(1)
    const notices = mail.forTask(applied.held.ui!.taskId).filter(message => message.tags.includes(REVISION_NOTICE_TAG))
    expect(notices.map(notice => [notice.toKind, notice.toId])).toEqual([['session', 'dev']])
    // The executor's owed step dispatches the fix attempt naming the new revisions.
    const store = composed.executionStore
    await until(() => store.attempts(applied.executionId, 'ui')[1]?.assignmentId != null)
    const fix = store.attempts(applied.executionId, 'ui')[1]!
    expect(fix).toMatchObject({ kind: 'fix', number: 2 })
    expect(fix.manifest).toMatchObject({ plan: { revision: applied.target.revision }, task: { revision: 2 }, startCommit: uiHead })
    const assignment = bench.assignmentStore.byId(fix.assignmentId!)!
    expect(assignment.requestKey).toBe(`exec:${applied.executionId}:ui:attempt:2:${store.change(applied.executionId, 'ui')!.generation}`)
    expect(assignment.instruction).toContain(`re-issued under plan revision ${applied.target.revision} and task revision 2`)
    expect(bench.assignmentStore.byId(applied.held.ui!.assignmentId)!.supersededBy).toBe('apply:cmd-pc1')
    // The continued change keeps its running attempt.
    expect(store.attempts(applied.executionId, 'api')).toHaveLength(1)
    // The next team-plan-detail lists both history rows.
    const withRevisions = () => all('team-plan-detail').slice(pushedBefore)
      .map(message => (message.detail.executions as PlanExecutionWithRevisions[] | undefined)?.find(execution => execution.id === applied.executionId))
      .find(execution => execution?.revisions.length === 2)
    await until(() => withRevisions() !== undefined)
    expect(withRevisions()!.revisions.map(row => [row.seq, row.revision, row.rationale])).toEqual([[1, 1, null], [2, applied.target.revision, 'the owner rethought the store']])
    expect(withRevisions()!.revision).toBe(applied.target.revision)
  })

  test('PC2: the same path with a stale expectedRevision is refused execution-revision-unchanged with nothing written', async () => {
    const applied = await runningWorld()
    const before = counts()
    const wake = spyOn(runtime, 'command')
    try {
      const answer = await command(applyFrame(applied, 'pc2', { expectedRevision: 0 }))
      expect(answer).toMatchObject({ type: 'team-plan-result', reason: 'precondition' })
      expect((answer as { failures: Array<{ name: string }> }).failures[0]).toMatchObject({ name: 'execution-revision-unchanged' })
      expect(wake).not.toHaveBeenCalled()
    } finally {
      wake.mockRestore()
    }
    expect(counts()).toEqual(before)
    expect(composed.executionStore.execution(applied.executionId)!.revision).toBe(1)
    expect(bench.tasks.get(applied.held.ui!.taskId)!.revision).toBe(1)
  })
  // plan-revision-apply D4 with B3: an Apply committed and the process stopped before its completion check; the executor's pass completes the run.
  test('an execution whose current revision fully landed, left running by a stop after an Apply commit, completes on the executor\'s next pass with the plan', async () => {
    const applied = await runningWorld()
    const store = composed.executionStore
    // The committed Apply's writes: the seq-2 row and the advanced columns.
    new ExecutionRevisionStore(bench.db.db).recordAt(2, {
      executionId: applied.executionId, revision: applied.target.revision, contentHash: applied.target.contentHash, reportId: 'rep-next', inputHash: 'ih-next',
      appliedAt: new Date().toISOString(), rationale: 'r', commandId: 'cmd-b3', payload: null,
    }, [])
    expect(advanceExecutionRevision(bench.db.db, applied.executionId, 1, { revision: applied.target.revision, contentHash: applied.target.contentHash, reportId: 'rep-next', inputHash: 'ih-next' })).toBe(true)
    for (const change of ['api', 'ui']) {
      store.insertLanding({ planId: applied.planId, change, executionId: applied.executionId, teamId: world.team.teamId, mechanism: 'direct', prNumber: null, prUrl: null, headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true })
      const row = store.change(applied.executionId, change)!
      expect(store.transition(applied.executionId, change, row, { state: 'landed', step: null })).not.toBeNull()
    }
    expect(store.execution(applied.executionId)!.state).toBe('running')
    runtime.command(world.team.teamId)
    await until(() => store.execution(applied.executionId)!.state === 'finished')
    expect(store.execution(applied.executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
    expect(bench.plans.get(applied.planId)!.lifecycle).toBe('completed')
  })
})

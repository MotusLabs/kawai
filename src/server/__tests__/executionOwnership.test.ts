// ExecutionOwnership and the team-service guards (plan-execution D7/D9,
// §8.1–8.6): the null implementation keeps every service passing unchanged;
// the real one links Kawai's tasks to the execution's revision, refuses
// other links, dispatches, handoffs, and release onto an owned task, checks
// result submissions against the change's branch, and adds the execution to
// the delivered task envelope. Replies to Kawai's mail are refused with the
// guidance (D18) for the agent tool and the human composer alike.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { KAWAI_REPLY_GUIDANCE } from '../../shared/team'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TaskRelease } from '../team/taskRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { buildTaskContext } from '../team/taskContext'
import { normalizePlanContent } from '../../shared/plans'
import { ExecutionStore } from '../plans/execution/executionStore'
import { executionOwnership, NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import type { PlanBench, PlanWorld } from './planHarness'
import { createPlanBench, createPlanWorld, writeGroup } from './planHarness'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let world: PlanWorld
let bench: PlanBench
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let executions: ExecutionStore
let ownership: ExecutionOwnership
let system: TaskCaller

beforeAll(async () => {
  world = await createPlanWorld('kawai-ownership-')
  writeGroup(world, 'reviewers', 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

/** A stub git for checkResult: ancestors as sets, an origin head per branch. */
/** A stub git for checkResult: `permissive` accepts every commit (the bench default); otherwise ancestry is the given pairs and origin heads the given map. */
function stubGit(ancestors: Array<[string, string]>, originHeads: Record<string, string> = {}, permissive = false): { isAncestor: never; lsRemoteHead: never } {
  const contains = (ancestor: string, descendant: string) =>
    permissive || ancestor === descendant || ancestors.some(([from, to]) => from === ancestor && to === descendant)
  return {
    isAncestor: (async (_cwd: string, ancestor: string, descendant: string) =>
      contains(ancestor, descendant) ? { ok: true, ancestor: true } : { ok: true, ancestor: false }) as never,
    lsRemoteHead: (async (_cwd: string, ref: string) =>
      ({ ok: true, sha: permissive ? null : originHeads[ref] ?? null })) as never,
  }
}

/** An execution owning `change`, its task, and the ownership wired into the services. */
async function ownedChange(change = 'api', overrides: { step?: 'updating' | 'merging' } = {}): Promise<{ taskId: string; executionId: string }> {
  const { planId, revision, hash } = await bench.draftInReview()
  await bench.approve(planId, revision)
  // Earlier executions in this test give up the change first.
  for (const row of executions.ownedChanges(world.team.teamId)) {
    if (row.change === change) executions.finishExecution(row.executionId, 'completed')
  }
  const execution = executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change, landed: false }],
  })
  if (overrides.step) {
    const row = executions.change(execution.id, change)!
    executions.transition(execution.id, change, row, { state: 'implementing', step: overrides.step, worktree: world.repo, branch: change })
  } else {
    executions.transition(execution.id, change, executions.change(execution.id, change)!, { state: 'provisioning', worktree: world.repo, branch: change })
  }
  const task = await tasks.create(system, { title: `${change} — Wave C`, direction: 'Build it', plan_id: planId, plan_change: change, worktree: world.repo })
  executions.transition(execution.id, change, executions.change(execution.id, change)!, { taskId: task.id })
  return { taskId: task.id, executionId: execution.id }
}

beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  executions = new ExecutionStore(bench.db.db)
  ownership = executionOwnership(executions, stubGit([], {}, true), () => null)
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans, ownership })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership,
  })
  results = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments, ownership })
  system = { kind: 'system', team: world.team, executionId: '' }
})

describe('the null implementation keeps the services unchanged', () => {
  test('nothing is owned, every result accepts, no message is Kawai\'s', async () => {
    expect(NULL_OWNERSHIP.ownerOfTask('any')).toBeNull()
    expect(NULL_OWNERSHIP.ownerOfChange('team', 'api')).toBeNull()
    await expect(NULL_OWNERSHIP.checkResult('any', { commit: null })).resolves.toBeNull()
    expect(NULL_OWNERSHIP.isKawaiMessage('m')).toBe(false)
    expect(NULL_OWNERSHIP.revisionOf('exec')).toBeNull()
    // The services build and dispatch without any ownership wired.
    const bare = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
    const task = await bare.create(bench.human, { title: 't', direction: 'd' })
    expect(task.creator.kind).toBe('human')
  })
})

describe('8.2 the system create path links to the execution\'s revision', () => {
  test('a task links to the revision the execution runs, not the current approved one', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const execution = executions.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
      maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
    })
    system = { kind: 'system', team: world.team, executionId: execution.id }
    // Revision 2 drops `api`; the execution still runs revision 1.
    const second = bench.plans.atomically(() => bench.plans.insertRevision(planId, {
      content: normalizePlanContent({ goal: 'G', successCriteria: ['S'], changes: [{ change: 'ui', group: 'leads', dependsOn: [], acceptance: [], extraChecks: [], guidance: '' }], roles: [{ group: 'leads', profiles: [] }] }),
      contentHash: 'h2', pin: null, author: { kind: 'human', sessionId: null },
    }))
    bench.plans.setRevisionStatus(planId, revision, 'superseded')
    bench.plans.setRevisionStatus(planId, second, 'approved')
    bench.plans.setCurrentApproved(planId, second)
    const task = await tasks.create(system, { title: 'api — Wave C', direction: 'Build it', plan_id: planId, plan_change: 'api' })
    expect(task.planChange).toBe('api')
    // A human link to the same owned change is refused naming the execution.
    await expect(tasks.create(bench.human, { title: 'parallel', direction: 'd', plan_id: planId, plan_change: 'api' }))
      .rejects.toThrow(execution.id)
    expect(tasks.store.list(world.team.teamId)).toHaveLength(1)
  })

  test('after the execution finishes, the link follows the plan-change rules again', async () => {
    const { taskId, executionId } = await ownedChange('api')
    expect(executions.finishExecution(executionId, 'completed')).toBe(true)
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const task = await tasks.create(bench.human, { title: 'after', direction: 'd', plan_id: planId, plan_change: 'api' })
    expect(task.planChange).toBe('api')
    expect(tasks.store.get(taskId)!.planChange).toBe('api')
  })
})

describe('8.3 only Kawai dispatches a running change\'s task', () => {
  test('the human and agents are refused naming the execution, and nothing is written', async () => {
    const { taskId, executionId } = await ownedChange('api')
    const before = assignments ? bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments').get() : null
    for (const caller of [bench.human, bench.agent('dev')] as TaskCaller[]) {
      await expect(assignments.dispatch(caller, {
        taskId, target: { kind: 'group', id: 'middle-devs' }, instruction: 'again', requestKey: `human-${(caller as { sessionId?: string }).sessionId ?? 'h'}`,
      })).rejects.toThrow(executionId)
    }
    const after = bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments').get() as { n: number }
    expect(after.n).toBe((before as { n: number }).n)
    // Kawai's own dispatch passes the guard and records it as dispatcher.
    system = { kind: 'system', team: world.team, executionId }
    const outcome = await assignments.dispatch(system, {
      taskId, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Implement api', requestKey: 'exec:attempt:1',
      allowedProfiles: ['default'], tags: ['author-profile:default'],
    })
    expect(outcome.assignment.createdBy).toEqual({ kind: 'system', sessionId: null })
  })

  test('an agent cannot pass allowedProfiles or tags', async () => {
    const task = await tasks.create(bench.human, { title: 'plain', direction: 'd' })
    await expect(assignments.dispatch(bench.agent('dev'), {
      taskId: task.id, target: { kind: 'group', id: 'middle-devs' }, instruction: 'x', requestKey: 'role-limited', allowedProfiles: ['glm'],
    })).rejects.toThrow('allowedProfiles')
  })
})

describe('8.4 handoffs, release, and result submission on an owned task', () => {
  test('a non-system handoff is refused; findings still accept', async () => {
    const { taskId, executionId } = await ownedChange('api')
    const task = await tasks.create(bench.human, { title: 'other', direction: 'd' })
    const plain = await results.submit(bench.agent('dev'), task.id, { summary: 'ok', commit: 'c1' })
    // Owned task: an agent's handoff is refused naming the execution.
    const owned = await results.submit(bench.agent('dev'), taskId, { summary: 'first', commit: 'c1' })
    await expect(results.handoff(bench.agent('dev'), taskId, {
      kind: 'review', resultId: owned.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'r', requestKey: 'nope',
    })).rejects.toThrow(executionId)
    // Findings on the owned task's result still accept (D9: every other stage).
    const findings = await results.submitFindings(bench.agent('lead2'), taskId, { resultId: owned.id, kind: 'review', verdict: 'pass', findings: 'clean' })
    expect(findings.verdict).toBe('pass')
    expect(plain.summary).toBe('ok')
  })

  test('release refuses an owned task; submission checks the branch and the step', async () => {
    const updating = await ownedChange('api', { step: 'updating' })
    await expect(results.submit(bench.agent('dev'), updating.taskId, { summary: 's', diff: 'd' }))
      .rejects.toThrow('writing the change\'s branch')
    // The human's release-and-hand-off refuses before anything is archived.
    const release = new TaskRelease(results, {
      releases: { membersOf: () => [], readiness: () => ({ ready: true }) } as never,
      records: () => bench.records.values(), ownership,
    })
    const { taskId, executionId } = await ownedChange('api')
    await expect(release.release(bench.human, taskId, {
      target: 'reviewers', instructions: 'review it', requestKey: 'rel',
    })).rejects.toThrow(executionId)

    const git = stubGit([['head1', 'refs/heads/api'], ['base', 'head1']], { 'refs/heads/api': 'base' })
    const wired = executionOwnership(executions, git, () => null)
    const checked = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments, ownership: wired })
    const ownedRow = executions.ownerOfTask(taskId)!
    executions.transition(ownedRow.executionId, 'api', executions.change(ownedRow.executionId, 'api')!, { step: null })
    // The commit is not on the branch: refused.
    await expect(checked.submit(bench.agent('dev'), taskId, { summary: 's', commit: 'elsewhere' })).rejects.toThrow('not on the change\'s branch')
    // A commit containing origin's head of the branch: accepted.
    const accepted = await checked.submit(bench.agent('dev'), taskId, { summary: 'good', commit: 'head1' })
    expect(accepted.commit).toBe('head1')
  })
})

describe('8.5 replies to Kawai\'s mail are refused with guidance', () => {
  test('the agent tool path and the human composer path, with nothing queued', async () => {
    const { taskId, executionId } = await ownedChange('api')
    system = { kind: 'system', team: world.team, executionId }
    const outcome = await assignments.dispatch(system, {
      taskId, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Implement api', requestKey: 'kawai-dispatch',
    })
    const kawaiMessage = outcome.message!
    mail.claim(kawaiMessage.id, 'dev')
    mail.markPushed(kawaiMessage.id)
    mail.markDelivered(kawaiMessage.id)
    const mailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
    await expect(mailbox.reply(bench.agent('dev'), { message_id: kawaiMessage.id, body: 'done' })).rejects.toThrow(KAWAI_REPLY_GUIDANCE)
    await expect(mailbox.reply(bench.human, { message_id: kawaiMessage.id, body: 'status?' })).rejects.toThrow(KAWAI_REPLY_GUIDANCE)
    const queued = bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages WHERE thread_id = ?').get(kawaiMessage.threadId) as { n: number }
    expect(queued.n).toBe(1)
  })
})

describe('8.6 the delivered envelope names the execution', () => {
  test('an owned task carries execution { id, revision } beside the plan; others keep their shape', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const execution = executions.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
      maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
    })
    system = { kind: 'system', team: world.team, executionId: execution.id }
    const task = await tasks.create(system, { title: 'api — Wave C', direction: 'Build it', plan_id: planId, plan_change: 'api' })
    executions.transition(execution.id, 'api', executions.change(execution.id, 'api')!, { taskId: task.id })
    const context = buildTaskContext(tasks.store, task.id, bench.plans, ownership)!
    expect(context.execution).toEqual({ id: execution.id, revision })
    expect(context.plan!.revision).toBe(revision)
    // The header names the execution line.
    expect(buildTaskContext(tasks.store, task.id, bench.plans, ownership)!.execution).toBeDefined()
    const plain = await tasks.create(bench.human, { title: 'plain', direction: 'd' })
    const plainContext = buildTaskContext(tasks.store, plain.id, bench.plans, ownership)!
    expect(plainContext.execution).toBeUndefined()
    expect(plainContext.plan).toBeUndefined()
  })
})

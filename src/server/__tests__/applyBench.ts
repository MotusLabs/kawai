// The Apply bench (plan-revision-apply 2.2–2.4): the pause-targets bench's
// stores (plan bench, executions, the real TaskService with notices, the
// assignment store, mail) behind a real ApplyService. The execution is
// built the way Start leaves it — its seq-1 history row included — over a
// plan approved at revision 1; `approveNext` publishes and approves the next
// revision from an edit of the current one. Git reads are doubles that
// check their arguments: the probe has no base (so changes-on-base compares
// nothing), and the branch-head read returns a fixed, distinguishable sha.
// `useWake` puts a hook in the post-commit wake (a throw there is a crash at
// B3), and `executor()` builds the production executor over the same stores,
// as a restarted server does.
import { expect } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import { ApplyService, type ApplyInput, type ApplyOutcome } from '../plans/revisionControl/applyService'
import type { AdaptHeadFacts } from '../plans/revisionControl/pauseResolve'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import type { FloorMap } from '../../shared/planExecution'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { planSteps, type PlanSteps } from '../plans/execution/executionPlanner'
import { executionSnapshot } from '../plans/execution/executionSnapshot'
import { assignmentState } from '../team/assignmentStore'
import { ExecutionExecutor } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { TaskResultService } from '../team/TaskResultService'
import { neutralExecutorSeams } from './executorTestSeams'
import { pauseTargetsBench, type PauseTargetsBench } from './pauseTargetsBench'
import type { PlanBenchFixture } from './planHarness'
import { sessionRow } from './planHarness'

export const APPLY_HEAD = 'apply-head-sha'

export type ApplyBench = PauseTargetsBench & {
  apply: ApplyService
  revisions: ExecutionRevisionStore
  /** The team ids the post-commit wake received. */
  applyWakes: string[]
  /** The branch-head reads Apply made, in order. */
  headReads: Array<{ executionId: string; change: string }>
  /** Swap the branch-head read (restore it in a finally). */
  useHead: (read: (executionId: string, change: string) => AdaptHeadFacts | null) => void
  /** A running execution of a plan approved at revision 1 over `changes` (default: the fixture's api and ui), with its seq-1 row. */
  running: (overrides?: Record<string, unknown>) => Promise<{ planId: string; executionId: string }>
  /** Publish and approve the plan's next revision from an edit of its current approved content. */
  approveNext: (planId: string, edit: (content: PlanContent) => PlanContent) => Promise<{ revision: number; hash: string }>
  /** One human Apply with the execution's current revision and the plan's approved target unless given. */
  applyAs: (input: Partial<ApplyInput> & { executionId: string }) => Promise<ApplyOutcome>
  /** Row counts of every table an Apply writes. */
  counts: () => Record<string, number>
  /** `inFlight` for a task Kawai created (as an execution's tasks are), so Kawai may close it. */
  inFlightByKawai: (executionId: string, change: string, holder?: string) => ReturnType<PauseTargetsBench['inFlight']>
  /** The production planner over the bench stores: what the executor's next tick would run. */
  planFor: () => PlanSteps
  /** Record the newest attempt's round with a result pinning `taskRevision` (the change moves to gating). Returns the round id. */
  answerNewestRow: (executionId: string, change: string, taskRevision: number) => string
  /** The revision notices on a task. */
  notices: (taskId: string) => ReturnType<PauseTargetsBench['bench']['mail']['forTask']>
  /** Run `hook` inside the post-commit wake (a throw there is a crash at B3); null removes it. */
  useWake: (hook: ((teamId: string) => void) | null) => void
  /** A fresh executor over the bench stores, as a restarted server builds one; holds read the bench's store, no git effects run. */
  executor: () => ExecutionExecutor
}

export async function applyBench(prefix: string, fixture: PlanBenchFixture = {}): Promise<ApplyBench> {
  const wired = await pauseTargetsBench(prefix, fixture)
  const { bench, executions } = wired
  bench.records.set('dev', sessionRow('dev', 'middle-devs', wired.world.feature))
  const revisions = new ExecutionRevisionStore(bench.db.db)
  const applyWakes: string[] = []
  const headReads: Array<{ executionId: string; change: string }> = []
  let wakeHook: ((teamId: string) => void) | null = null
  let headRead = (_executionId: string, _change: string): AdaptHeadFacts | null => ({ ok: true, startCommit: APPLY_HEAD, artifacts: {} })
  const apply = new ApplyService({
    store: executions, plansStore: bench.plans, plans: bench.service, executionRevisions: revisions,
    validation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-next', inputHash: 'ih-next', readiness: { carriedConditions: [] } } }),
    },
    impact: { gate: () => null },
    settings: { planExecution: async () => ({ floorChecks: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }, maxParallelChanges: 3, mergeMethod: 'merge' }) },
    probe: async input => {
      expect(input.main).toBe(wired.world.repo)
      return { findings: [], repo: null, base: null }
    },
    startFacts: async input => {
      expect(input.main).toBe(wired.world.repo)
      return { runningPromotion: null, offBaseLandings: [] }
    },
    writes: { store: executions, tasks: wired.tasks, assignments: bench.assignmentStore, mailbox: bench.mail, sessionExists: id => bench.records.has(id) },
    adaptHead: async (executionId, change) => {
      headReads.push({ executionId, change })
      return headRead(executionId, change)
    },
    wake: teamId => {
      applyWakes.push(teamId)
      wakeHook?.(teamId)
    },
  })

  let planCounter = 0
  async function running(overrides: Record<string, unknown> = {}): Promise<{ planId: string; executionId: string }> {
    // One running execution owns a change name per team: earlier ones finish first.
    for (const row of executions.ownedChanges(wired.teamId)) executions.finishExecution(row.executionId, 'completed')
    const draft = await bench.draftInReview(overrides)
    const approved = await bench.approve(draft.planId, draft.revision, `approve-apply-${++planCounter}`)
    if (!approved.ok) throw new Error(approved.message)
    const changes = bench.plans.revision(draft.planId, draft.revision)!.content.changes.map(entry => entry.change)
    const execution = executions.insertExecution({
      teamId: wired.teamId, planId: draft.planId, revision: draft.revision, contentHash: draft.hash, reportId: 'rep-1', inputHash: 'ih-1',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
      maxParallel: 3, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
    })
    revisions.recordAt(1, {
      executionId: execution.id, revision: draft.revision, contentHash: draft.hash, reportId: 'rep-1', inputHash: 'ih-1',
      appliedAt: execution.startedAt, rationale: null, commandId: null, payload: null,
    }, [])
    return { planId: draft.planId, executionId: execution.id }
  }

  async function approveNext(planId: string, edit: (content: PlanContent) => PlanContent): Promise<{ revision: number; hash: string }> {
    const current = bench.plans.revision(planId, bench.plans.get(planId)!.currentApprovedRevision!)!
    const draft = bench.plans.getDraft(planId, 'lead')!
    const saved = await bench.service.saveDraft(bench.agent('lead'), { plan_id: planId, content: edit(structuredClone(current.content)), expected_draft_hash: draft.contentHash })
    if (!saved.ok) throw new Error(saved.message)
    const submitted = await bench.service.submit(bench.agent('lead'), { plan_id: planId })
    if (!submitted.ok) throw new Error(submitted.message)
    const approved = await bench.approve(planId, submitted.revision.revision, `approve-apply-${++planCounter}`)
    if (!approved.ok) throw new Error(approved.message)
    return { revision: submitted.revision.revision, hash: submitted.revision.contentHash }
  }

  let commandCounter = 0
  async function applyAs(input: Partial<ApplyInput> & { executionId: string }): Promise<ApplyOutcome> {
    const execution = executions.execution(input.executionId)!
    const plan = bench.plans.get(execution.planId)!
    const target = bench.plans.revision(plan.id, plan.currentApprovedRevision!)!
    return apply.apply(bench.human, {
      expectedRevision: execution.revision, revision: target.revision, contentHash: target.contentHash,
      choices: {}, rationale: 'the owner rethought it', commandId: `apply-${++commandCounter}`, ...input,
    })
  }

  const count = (table: string): number => (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const counts = (): Record<string, number> => Object.fromEntries([
    'plan_events', 'plan_execution_revisions', 'plan_execution_publication_changes', 'team_task_revisions',
    'team_messages', 'plan_execution_attempts', 'plan_execution_changes',
  ].map(table => [table, count(table)]))

  function planFor(): PlanSteps {
    const snapshot = executionSnapshot(wired.teamId, wired.world.repo, executions, bench.plans,
      taskId => wired.tasks.store.results.listByTask(taskId)
        .map(result => ({ id: result.id, commit: result.commit, taskRevision: result.taskRevision, submittedBySession: result.submittedBy.kind === 'agent' ? result.submittedBy.sessionId : null }))
        .reverse(),
      taskId => wired.tasks.store.get(taskId)?.revision ?? 1,
      taskId => wired.tasks.store.get(taskId)?.status ?? 'active',
      taskId => {
        const outstanding = wired.tasks.store.assignmentsOf(taskId).filter(row => row.supersededBy === null).at(-1)
        if (outstanding === undefined) return null
        const state = assignmentState(outstanding, outstanding.messageId !== null ? bench.mail.get(outstanding.messageId) : null)
        return { id: outstanding.id, state: state.state, reason: state.reason, requestKey: outstanding.requestKey ?? null }
      },
      taskId => wired.tasks.store.assignmentsOf(taskId).map(row => ({ requestKey: row.requestKey })),
      planId => wired.holds.active(wired.teamId, planId).map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes })),
      planId => wired.pauses.forPlan(wired.teamId, planId, true).flatMap(pause => wired.pauses.targets(pause.id).map(row => ({ pauseId: pause.id, change: row.change, decision: row.decision }))))
    return planSteps(snapshot, wired.now().toISOString())
  }

  function answerNewestRow(executionId: string, change: string, taskRevision: number): string {
    const row = executions.change(executionId, change)!
    const attempt = executions.attempts(executionId, change).at(-1)!
    const result = wired.tasks.store.results.insert({
      teamId: wired.teamId, taskId: row.taskId!, summary: 'done', commit: 'round-commit', diff: null, worktree: null,
      tests: [], limitations: null, taskRevision, submittedBy: { kind: 'agent', sessionId: 'dev' },
    })
    return executions.insertRound({ executionId, change, attemptId: attempt.id, resultId: result.id, commitSha: 'round-commit', fixRound: false }).round.id
  }

  async function inFlightByKawai(executionId: string, change: string, holder = 'dev') {
    const flight = await wired.inFlight(executionId, change, holder)
    bench.db.db.prepare("UPDATE team_tasks SET creator_kind = 'system', creator_session = NULL WHERE id = ?").run(flight.taskId)
    return flight
  }

  const results = new TaskResultService(wired.tasks, { getSession: id => bench.records.get(id), assignments: wired.assignments })
  const executor = (): ExecutionExecutor => new ExecutionExecutor({
    ...neutralExecutorSeams, plansService: bench.service, store: executions, plans: bench.plans, tasks: wired.tasks,
    assignments: wired.assignments, mailbox: bench.mail, results, records: () => bench.records.values(),
    teamOf: id => (id === wired.teamId ? wired.world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
    holds: {
      active: (teamId, planId) => wired.holds.active(teamId, planId).map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes })),
      openTargets: () => [],
    },
    now: wired.now,
  })

  return {
    ...wired, apply, revisions, applyWakes, headReads, planFor, answerNewestRow, inFlightByKawai, executor,
    useHead: read => { headRead = read },
    useWake: hook => { wakeHook = hook },
    running, approveNext, applyAs, counts,
    notices: taskId => bench.mail.forTask(taskId).filter(message => message.tags.includes(REVISION_NOTICE_TAG)),
  }
}

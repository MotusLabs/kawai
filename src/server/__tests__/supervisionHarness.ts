// A bench for the supervision monitor tests (plan-supervision §8): the
// decision bench, the real execution and integration stores, and the
// production monitor composition (`composeSupervisionMonitor`) over a
// movable clock and recorded holder facts. Helpers start an execution of an
// approved plan, put a change on an attempt with delivered instruction mail,
// publish further revisions, record landings, and create fix tasks.
import type { HolderFacts } from '../../shared/planSupervision'
import type { PlanFixTask } from '../../shared/planDecisions'
import type { SystemCaller } from '../team/systemCaller'
import { ExecutionStore } from '../plans/execution/executionStore'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { composeSupervisionMonitor } from '../plans/supervision/monitorComposition'
import type { SupervisionMonitor } from '../plans/supervision/SupervisionMonitor'
import type { SupervisionDetailReads } from '../plans/supervision/planSupervisionDetail'
import { planInput } from '../../shared/__tests__/planFixtures'
import { createDecisionBench, LEAD_ROLES, type DecisionBench } from './decisionHarness'
import type { PlanWorld } from './planHarness'

export const T0 = Date.parse('2026-10-20T08:00:00.000Z')
export const MIN = 60_000

export interface SupervisionBench extends DecisionBench {
  executions: ExecutionStore
  integration: IntegrationStore
  clock: { at: number }
  holder: Partial<HolderFacts>
  announced: string[]
  logged: unknown[]
  /** Compose a monitor over the bench (a fresh one models a restart). */
  compose: () => { monitor: SupervisionMonitor; reads: SupervisionDetailReads }
  /** Start an execution of the plan's current approved revision. */
  start: (planId: string) => string
  setChange: (executionId: string, change: string, values: { state: string; step?: string | null; taskId?: string | null }) => void
  /** Put `change` on an implement attempt dispatched to `dev`, its instruction delivered at `deliveredAt`. */
  implementing: (executionId: string, planId: string, deliveredAt: string, change?: string) => Promise<{ taskId: string; messageId: string }>
  /** Publish and approve the next revision with these change overrides; returns its number. */
  revise: (planId: string, overrides: Record<string, unknown>) => Promise<number>
  land: (executionId: string, planId: string, change: string, mergeSha: string, treeVerified?: boolean) => void
  /** A fix task of the plan (override origin), its `plan_fix_tasks` row with it. */
  fixTask: (planId: string, sourceId?: string, sourceKind?: PlanFixTask['sourceKind']) => string
  messagesTagged: (tag: string) => Array<{ id: string; to_id: string; from_kind: string; task_id: string | null; tags: string; allowed_profiles: string | null; body: string }>
}

let serial = 0

export function createSupervisionBench(world: PlanWorld): SupervisionBench {
  const bench = createDecisionBench(world)
  const executions = new ExecutionStore(bench.db.db)
  const integration = new IntegrationStore(bench.db.db)
  const clock = { at: T0 }
  const holder: Partial<HolderFacts> = {}
  const announced: string[] = []
  const logged: unknown[] = []
  bench.plans.subscribe(plan => announced.push(plan.id))
  const compose = () => composeSupervisionMonitor({
    db: bench.db.db, plans: bench.plans, executions, decisions: bench.decisions, mailbox: bench.mail, tasks: bench.taskService, taskStore: bench.tasks,
    assignments: bench.assignments, integration,
    identityOf: teamId => (teamId === world.team.teamId ? world.team : undefined),
    reads: {
      db: bench.db.db, mail: bench.mail, executions, plans: bench.plans, decisions: bench.decisions, integration, tasks: bench.tasks,
      conditionsOf: () => [],
      runtime: {
        holder: session => ({
          session, group: 'middle-devs', profile: 'default', gone: false, turnRunning: false, pendingRequest: null, backgroundTasks: 0, workers: 0,
          dueDirectMail: false, parkedUntil: null, coolingUntil: null, lastTurnEndAt: null, lastTaskMailAt: null, ...holder,
        }),
        blocker: () => null,
      },
    },
    monitor: { now: () => new Date(clock.at), debounceMs: 0, timerMs: 3_600_000, log: (_message, error) => logged.push(error) },
  })
  const setChange: SupervisionBench['setChange'] = (executionId, change, values) => {
    bench.db.db.prepare('UPDATE plan_execution_changes SET state = ?, step = ?, task_id = ? WHERE execution_id = ? AND change = ?')
      .run(values.state, values.step ?? null, values.taskId ?? null, executionId, change)
  }
  return {
    ...bench, executions, integration, clock, holder, announced, logged, compose, setChange,
    start: planId => {
      const revision = bench.plans.approvedRevision(planId)!
      return executions.insertExecution({
        teamId: world.team.teamId, planId, revision: revision.revision, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc',
        floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
        maxParallel: 3, mergeMethod: 'merge', changes: revision.content.changes.map(entry => ({ change: entry.change, landed: false })),
      }).id
    },
    implementing: async (executionId, planId, deliveredAt, change = 'api') => {
      const taskId = await bench.onTask('dev', planId, change)
      setChange(executionId, change, { state: 'implementing', taskId })
      const outcome = await bench.assignments.dispatch(bench.human, { taskId, target: { kind: 'session', id: 'dev' }, instruction: 'Build', requestKey: `k-${taskId}` })
      const messageId = outcome.assignment.messageId!
      bench.db.db.prepare("UPDATE team_messages SET state = 'delivered', delivered_at = ?, claimed_by = 'dev' WHERE id = ?").run(deliveredAt, messageId)
      return { taskId, messageId }
    },
    revise: async (planId, overrides) => {
      const draft = bench.plans.getDraft(planId, 'lead')
      const saved = await bench.service.saveDraft(bench.agent('lead'), { plan_id: planId, content: planInput({ ...LEAD_ROLES, ...overrides }), expected_draft_hash: draft?.contentHash ?? null })
      if (!saved.ok) throw new Error(JSON.stringify(saved))
      const submitted = await bench.service.submit(bench.agent('lead'), { plan_id: planId })
      if (!submitted.ok) throw new Error(submitted.message)
      const approved = await bench.approve(planId, submitted.revision.revision)
      if (!approved.ok) throw new Error(approved.message)
      return submitted.revision.revision
    },
    land: (executionId, planId, change, mergeSha, treeVerified = true) => {
      executions.insertLanding({ teamId: world.team.teamId, planId, change, executionId, mergeSha, headSha: mergeSha, baseSha: 'base', treeVerified, mechanism: 'direct', prNumber: null, prUrl: null })
    },
    fixTask: (planId, sourceId = `decision-${++serial}`, sourceKind = 'override') => {
      const caller: SystemCaller = { kind: 'system', team: world.team, origin: sourceKind === 'override' ? { kind: 'override', decisionId: sourceId } : { kind: 'promotion', promotionId: sourceId } }
      return bench.taskService.createFixTask(caller, { title: 'Forward fix: x — Wave C', direction: 'Fix it', acceptance: 'Lands' }, created => {
        bench.decisions.insertFixTask({ taskId: created.id, teamId: world.team.teamId, planId, sourceKind, sourceId })
      }).id
    },
    messagesTagged: tag => (bench.db.db.prepare('SELECT * FROM team_messages ORDER BY created_at, rowid').all() as Array<{ id: string; to_id: string; from_kind: string; task_id: string | null; tags: string; allowed_profiles: string | null; body: string }>)
      .filter(row => (JSON.parse(row.tags) as string[]).includes(tag)),
  }
}

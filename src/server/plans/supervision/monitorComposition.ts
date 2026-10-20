// The production SupervisionMonitor (plan-supervision design D11), composed
// over the stores the plan composition already holds: the team work checks
// read the running executions and promotions, the open fix and correction
// tasks, and failed promotions still owed a correction; each sweep derives through the shared loader with the
// monitor's own `waitEndedAt`, raises alerts through `stallAlerts.ts`,
// creates corrections and completes fixes through `fixTasks.ts`, and keys each plan's detail for the
// change-only push (8.6). Notifications: plan, execution (landings and slot
// included), promotion, task, and mailbox writes of the team.
import type { Database } from 'bun:sqlite'
import type { PlanSupervisionDetail } from '../../../shared/planReport'
import type { AssignmentService } from '../../team/AssignmentService'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TaskService } from '../../team/TaskService'
import type { TaskStore } from '../../team/taskStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import { CORRECTED_OUTCOMES } from '../decisions/correctionText'
import { completeFixTasks, createCorrectionTasks, UNCORRECTED_PROMOTIONS, uncorrectedPromotionIds } from '../decisions/fixTasks'
import type { DecisionStore } from '../decisions/decisionStore'
import type { ExecutionStore } from '../execution/executionStore'
import type { IntegrationStore } from '../landing/integration/integrationStore'
import type { PlanStore } from '../planStore'
import { readPlanSupervisionDetail, type SupervisionDetailReads } from './planSupervisionDetail'
import { raiseStallAlerts } from './stallAlerts'
import { StallAlertStore } from './stallAlertStore'
import { derivePlanSupervision } from './supervisionRead'
import { SupervisionMonitor, type SupervisionMonitorDeps } from './SupervisionMonitor'

export interface MonitorCompositionOptions {
  db: Database
  plans: PlanStore
  executions: ExecutionStore
  decisions: DecisionStore
  mailbox: MailboxStore
  tasks: TaskService
  taskStore: TaskStore
  assignments: Pick<AssignmentService, 'dispatchWithin'>
  integration: Pick<IntegrationStore, 'promotion' | 'promotionsOf' | 'subscribe'>
  /** The detail reads without the monitor's wait seam; the composition adds it. */
  reads: SupervisionDetailReads
  identityOf: (teamId: string) => TeamIdentity | undefined
  /** Test seams. */
  monitor?: Partial<Pick<SupervisionMonitorDeps, 'now' | 'timerMs' | 'debounceMs' | 'log'>>
}

const OPEN_FIX_TEAMS = `SELECT DISTINCT f.team_id AS team FROM plan_fix_tasks f JOIN team_tasks t ON t.id = f.task_id
  WHERE t.status IN ('open', 'active', 'blocked')`

/**
 * The detail with its read-time fields blanked: `computedAt`, and a live
 * turn's activity time (it reads `now`). What remains moves only when a
 * record or a runtime fact moved.
 */
export function detailViewKey(detail: PlanSupervisionDetail | null): string | null {
  if (detail === null) return null
  const changes = detail.supervision.changes.map(change => (change.activity?.kind === 'live-turn' ? { ...change, activity: { ...change.activity, at: '' } } : change))
  return JSON.stringify({ ...detail, supervision: { ...detail.supervision, computedAt: '', changes } })
}

export function composeSupervisionMonitor(options: MonitorCompositionOptions): { monitor: SupervisionMonitor; reads: SupervisionDetailReads } {
  const { db } = options
  const alerts = new StallAlertStore(db)
  let monitor: SupervisionMonitor | null = null
  const reads: SupervisionDetailReads = { ...options.reads, waitEndedAt: (executionId, change) => monitor?.waitEndedAt(executionId, change) ?? null }
  const openFixTeams = db.prepare(OPEN_FIX_TEAMS)
  const runningPromotionTeams = db.prepare("SELECT DISTINCT team_id AS team FROM plan_promotions WHERE state = 'running'")
  const openFixOf = db.prepare(`${OPEN_FIX_TEAMS} AND f.team_id = ? LIMIT 1`)
  // Teams with a failed promotion still owed a correction (D8), so a restart creates it.
  const uncorrectedTeams = db.prepare(`SELECT DISTINCT p.team_id AS team ${UNCORRECTED_PROMOTIONS}`)
  const runningPromotionOf = db.prepare("SELECT 1 FROM plan_promotions WHERE state = 'running' AND team_id = ? LIMIT 1")
  const identity = (teamId: string): TeamIdentity => {
    const found = options.identityOf(teamId)
    if (found === undefined) throw new Error(`Unknown team: ${teamId}`)
    return found
  }
  const teamsOf = (statement: ReturnType<Database['prepare']>, ...params: string[]) => (statement.all(...params) as Array<{ team: string }>).map(row => row.team)
  monitor = new SupervisionMonitor({
    teamsWithWork: () => [...new Set([...options.executions.runningTeams(), ...teamsOf(runningPromotionTeams), ...teamsOf(openFixTeams), ...teamsOf(uncorrectedTeams, ...CORRECTED_OUTCOMES)])],
    hasWork: teamId => options.executions.runningForTeam(teamId).length > 0 || runningPromotionOf.get(teamId) !== null || openFixOf.get(teamId) !== null
      || uncorrectedPromotionIds(db, teamId).length > 0,
    runningChanges: teamId => options.executions.runningForTeam(teamId)
      .flatMap(execution => options.executions.changes(execution.id).map(row => ({ executionId: execution.id, change: row.change }))),
    plansOf: teamId => options.plans.openPlans(teamId).map(plan => plan.id),
    derive: (teamId, planId, now) => derivePlanSupervision(reads, teamId, planId, now),
    raiseStalls: (teamId, planId, derived) => raiseStallAlerts({ db, mail: options.mailbox, alerts, plans: options.plans }, identity(teamId), planId, derived),
    manageFixes: async teamId => {
      const team = identity(teamId)
      createCorrectionTasks({ db, decisions: options.decisions, tasks: options.tasks, assignments: options.assignments, plans: options.plans, promotions: options.integration }, team)
      await completeFixTasks({
        decisions: options.decisions, tasks: options.tasks, taskStore: options.taskStore, plans: options.plans, executions: options.executions, promotions: options.integration,
      }, team)
    },
    viewKey: (teamId, planId, now) => detailViewKey(readPlanSupervisionDetail(reads, teamId, planId, now)),
    announce: planId => options.plans.announce(planId),
    subscribe: notify => {
      const offs = [
        options.plans.subscribe(plan => notify(plan.teamId)),
        options.executions.subscribe(teamId => notify(teamId)),
        options.integration.subscribe(teamId => notify(teamId)),
        options.taskStore.subscribe(task => notify(task.teamId)),
        options.mailbox.subscribe(teamId => notify(teamId)),
      ]
      return () => { for (const off of offs) off() }
    },
    ...options.monitor,
  })
  return { monitor, reads }
}

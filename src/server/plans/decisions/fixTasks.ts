// Fix tasks (plan-supervision design D7): an owner's override creates one
// task, with no worktree, change, parent, or plan link, its `plan_fix_tasks`
// row in the same transaction, and dispatches it to the plan's Lead role.
// This file is the only one that mints the decision-origin system callers,
// through functions it does not export, so Kawai acting for a decision can
// do only what `systemCaller.ts` grants those origins: create the fix,
// dispatch it, and close its earlier fix as creator. `prepareOverrideFix`
// runs the asynchronous parts first; its `commit` runs inside the
// override's transaction. `completeFixTasks` is the monitor's D8 completion:
// an open fix or correction task closes as `done`, by its own origin as its
// creator, once a change naming it has landed (judged by the revision its
// landing execution ran) and no change of the current approved revision
// naming it is unlanded; a correction also closes once a later promotion
// of its plan merged. `createCorrectionTasks` is D8's correction creation:
// one task per promotion stored as `failed:promotion-conflict` or
// `failed:ci-failed`, its fix row and its dispatch to the Lead role in one
// transaction, so the unique source makes it exactly-once across restarts.
import type { Database } from 'bun:sqlite'
import { fixLandings, type DecisionCard, type PlanDecision, type PlanFixTask } from '../../../shared/planDecisions'
import type { Plan, PlanRevision } from '../../../shared/plans'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskService } from '../../team/TaskService'
import type { TaskStore } from '../../team/taskStore'
import type { AssignmentService } from '../../team/AssignmentService'
import type { PreparedTaskStatus } from '../../team/taskStatusPrepared'
import type { SystemCaller } from '../../team/systemCaller'
import type { DecisionStore } from './decisionStore'
import { deciderName } from './decisionInputs'
import { fixPlanFacts, type FixFactReads } from './fixFacts'
import type { PlanStore } from '../planStore'
import type { IntegrationStore, PromotionRow } from '../landing/integration/integrationStore'
import { CORRECTED_OUTCOMES, CORRECTION_ACCEPTANCE, correctionDirection, correctionTitle } from './correctionText'
import { DecisionConflict } from './decisionStore'

const overrideCaller = (team: TeamIdentity, decisionId: string): SystemCaller => ({ kind: 'system', team, origin: { kind: 'override', decisionId } })
const promotionCaller = (team: TeamIdentity, promotionId: string): SystemCaller => ({ kind: 'system', team, origin: { kind: 'promotion', promotionId } })
/** The fix row's own origin: Kawai closes the task as the creator that made it. */
const sourceCaller = (team: TeamIdentity, fix: PlanFixTask): SystemCaller =>
  (fix.sourceKind === 'override' ? overrideCaller(team, fix.sourceId) : promotionCaller(team, fix.sourceId))

const QUESTION_CUT = 80
const OPEN = new Set(['open', 'active', 'blocked'])

export const FIX_ACCEPTANCE = 'A change naming this task in `fixes` has landed and no change of the current approved revision naming it is unlanded, and Kawai then closes this task; or the owner accepted a no-change result.'

export interface FixDeps {
  db: Database
  decisions: DecisionStore
  tasks: TaskService
  taskStore: TaskStore
  assignments: AssignmentService
}

export interface OverrideFixInput {
  team: TeamIdentity
  plan: Plan
  approved: PlanRevision | null
  card: DecisionCard
  superseded: PlanDecision
  /** The override's decision as it will be inserted (id, choice, rationale). */
  override: Pick<PlanDecision, 'id' | 'choice' | 'rationale'>
}

export function fixTitle(question: string, planTitle: string): string {
  const cut = question.length > QUESTION_CUT ? `${question.slice(0, QUESTION_CUT - 1)}…` : question
  return `Forward fix: ${cut.replace(/\s+/g, ' ')} — ${planTitle}`
}

/** Each affected task with its change, its results' commits, and its change's landing since the superseded decision. */
function affectedLines(deps: FixDeps, input: OverrideFixInput): string[] {
  return input.superseded.affected.map(taskId => {
    const task = deps.taskStore.get(taskId)
    const commits = (deps.db.prepare(`SELECT commit_ref FROM team_task_results WHERE task_id = ? AND team_id = ? AND commit_ref IS NOT NULL
      ORDER BY created_at, rowid`).all(taskId, input.team.teamId) as Array<{ commit_ref: string }>).map(row => row.commit_ref)
    const landing = task?.planChange
      ? deps.db.prepare('SELECT merge_sha FROM plan_change_landings WHERE plan_id = ? AND change = ? AND team_id = ? AND landed_at >= ?')
        .get(input.plan.id, task.planChange, input.team.teamId, input.superseded.createdAt) as { merge_sha: string } | null
      : null
    const parts = [`- ${taskId}${task ? ` "${task.title}"` : ''}${task?.planChange ? ` (change ${task.planChange})` : ''}`]
    parts.push(commits.length ? `results at ${commits.join(', ')}` : 'no result commits')
    if (landing) parts.push(`landed as ${landing.merge_sha} since the superseded decision`)
    return parts.join('; ')
  })
}

/** D7's direction; the instruction names `fixes: ["<taskId>"]` once the id is known. */
export function fixDirection(deps: FixDeps, input: OverrideFixInput, taskId: string): string {
  const { card, superseded, override } = input
  const affected = affectedLines(deps, input)
  return [
    `The owner overrode decision card ${card.id} on plan "${input.plan.title}" (${input.plan.id}).`,
    '',
    `Question: ${card.question}`,
    `Superseded decision ${superseded.id} by ${deciderName(superseded)}: ${superseded.choice}${superseded.rationale ? ` — ${superseded.rationale}` : ''}`,
    `Override ${override.id} by the owner: ${override.choice} — ${override.rationale ?? ''}`,
    '',
    'Affected tasks:',
    ...(affected.length ? affected : ['- none recorded']),
    '',
    'Write an OpenSpec change for the fix and land its proposal on the base branch, as `changes-on-base` requires. '
      + `Add it to the plan's next revision with \`fixes: ["${taskId}"]\` and \`dependsOn\` the affected changes still in the revision, then call plan_submit_for_review. `
      + 'The owner approves and starts it, and Kawai gates and lands it like any change. If no change is needed, submit a result explaining why, and the owner accepts it.',
  ].join('\n')
}

/** The open fix tasks of this card's earlier overrides. */
function earlierOpenFixes(deps: FixDeps, input: OverrideFixInput): string[] {
  const overrides = new Set(deps.decisions.decisionsOfCard(input.team.teamId, input.card.id).filter(d => d.kind === 'override').map(d => d.id))
  return deps.decisions.fixTasksOfPlan(input.team.teamId, input.plan.id)
    .filter(fix => fix.sourceKind === 'override' && overrides.has(fix.sourceId))
    .filter(fix => OPEN.has(deps.taskStore.get(fix.taskId)?.status ?? 'done'))
    .map(fix => fix.taskId)
}

/** D6 steps 5–6 prepared: cancel the earlier open fix, then create and dispatch the new one, inside the caller's transaction. */
export async function prepareOverrideFix(deps: FixDeps, input: OverrideFixInput): Promise<{ commit(): { taskId: string; dispatched: boolean } }> {
  const caller = overrideCaller(input.team, input.override.id)
  const cancels: PreparedTaskStatus[] = []
  for (const taskId of earlierOpenFixes(deps, input)) {
    cancels.push(await deps.tasks.prepareStatus(caller, taskId, 'cancelled', `Superseded by override ${input.override.id} of card ${input.card.id}.`))
  }
  const lead = input.approved?.content.leadGroup ?? null
  const role = lead ? input.approved!.content.roles.find(entry => entry.group === lead) : undefined
  return {
    commit: () => {
      for (const cancel of cancels) cancel.commit()
      const id = `task-${crypto.randomUUID()}`
      const direction = fixDirection(deps, input, id)
      const task = deps.tasks.createFixTask(caller, { id, title: fixTitle(input.card.question, input.plan.title), direction, acceptance: FIX_ACCEPTANCE }, created => {
        deps.decisions.insertFixTask({ taskId: created.id, teamId: input.team.teamId, planId: input.plan.id, sourceKind: 'override', sourceId: input.override.id })
      })
      if (!lead) return { taskId: task.id, dispatched: false }
      deps.assignments.dispatchWithin(caller, {
        taskId: task.id, target: { kind: 'group', id: lead }, instruction: direction, requestKey: `fix:${input.override.id}`,
        allowedProfiles: role?.profiles.length ? role.profiles : undefined, tags: ['plan-fix'],
      })
      return { taskId: task.id, dispatched: true }
    },
  }
}

export interface FixCompletionDeps extends FixFactReads {
  decisions: Pick<DecisionStore, 'fixTasksOfTeam'>
  tasks: Pick<TaskService, 'setStatus'>
  taskStore: Pick<TaskStore, 'get'>
  plans: Pick<PlanStore, 'revisions' | 'forTeam'>
  /** The promotions a correction is judged by; without it only the landing rule closes one. */
  promotions?: Pick<IntegrationStore, 'promotion' | 'promotionsOf'>
}

/** A later promotion of the correction's plan that merged, if any (D8). */
function mergedAfter(deps: FixCompletionDeps, fix: PlanFixTask): PromotionRow | null {
  if (fix.sourceKind !== 'promotion' || !deps.promotions) return null
  const failed = deps.promotions.promotion(fix.sourceId)
  if (failed === null) return null
  return deps.promotions.promotionsOf(fix.planId).find(row => row.number > failed.number && row.outcome === 'merged') ?? null
}

/**
 * D8 completion over the team's open fix and correction tasks: each closes
 * in its own transaction (`setStatus`), so a repeat sweep finds it done and
 * writes nothing. Returns the closed task ids.
 */
export async function completeFixTasks(deps: FixCompletionDeps, team: TeamIdentity): Promise<Array<{ taskId: string; planId: string }>> {
  const closed: Array<{ taskId: string; planId: string }> = []
  for (const fix of deps.decisions.fixTasksOfTeam(team.teamId)) {
    const task = deps.taskStore.get(fix.taskId)
    if (task === null || !OPEN.has(task.status)) continue
    const plan = deps.plans.forTeam(team.teamId, fix.planId)
    if (plan === null) continue
    const { landings, outstanding } = fixLandings(fix.taskId, fixPlanFacts(deps, team.teamId, plan))
    const kind = fix.sourceKind === 'override' ? 'fix' : 'correction'
    let note: string
    if (landings.length > 0 && outstanding.length === 0) {
      const landed = landings.map(landing => `${landing.change} (merge ${landing.mergeSha})`).join(', ')
      note = `Kawai closes this ${kind} task: ${landed} landed naming it in \`fixes\`, and no change of the current approved revision naming it is unlanded.`
    } else {
      const merged = mergedAfter(deps, fix)
      if (merged === null) continue
      note = `Kawai closes this correction task: promotion ${merged.number} (${merged.id}) of the plan merged${merged.mergeSha ? ` as ${merged.mergeSha}` : ''}.`
    }
    await deps.tasks.setStatus(sourceCaller(team, fix), fix.taskId, 'done', note)
    closed.push({ taskId: fix.taskId, planId: fix.planId })
  }
  return closed
}

export interface CorrectionDeps {
  db: Database
  decisions: Pick<DecisionStore, 'insertFixTask'>
  tasks: Pick<TaskService, 'createFixTask'>
  assignments: Pick<AssignmentService, 'dispatchWithin'>
  plans: Pick<PlanStore, 'forTeam' | 'approvedRevision'>
  promotions: Pick<IntegrationStore, 'promotion'>
}

/** Finished promotions whose outcome gets a correction and that have none yet; `?` stands for each of CORRECTED_OUTCOMES. */
export const UNCORRECTED_PROMOTIONS = `FROM plan_promotions p WHERE p.state = 'finished' AND p.outcome IN (${CORRECTED_OUTCOMES.map(() => '?').join(', ')})
  AND NOT EXISTS (SELECT 1 FROM plan_fix_tasks f WHERE f.source_kind = 'promotion' AND f.source_id = p.id)`

/** The team's promotions still owed a correction, oldest first. */
export function uncorrectedPromotionIds(db: Database, teamId: string): string[] {
  return (db.prepare(`SELECT p.id ${UNCORRECTED_PROMOTIONS} AND p.team_id = ? ORDER BY p.finished_at, p.rowid`)
    .all(...CORRECTED_OUTCOMES, teamId) as Array<{ id: string }>).map(row => row.id)
}

/**
 * D8 correction creation: for each uncorrected promotion, one transaction
 * creates the task (origin `promotion`), its `plan_fix_tasks` row, and —
 * with a Lead role — its dispatch under `correct:<promotionId>`, tagged
 * `plan-fix`; without one it stays unassigned for the owner. A source
 * another writer took first rolls back and is skipped. Returns the created tasks.
 */
export function createCorrectionTasks(deps: CorrectionDeps, team: TeamIdentity): Array<{ taskId: string; planId: string }> {
  const created: Array<{ taskId: string; planId: string }> = []
  for (const promotionId of uncorrectedPromotionIds(deps.db, team.teamId)) {
    const promotion = deps.promotions.promotion(promotionId)
    if (promotion === null || !CORRECTED_OUTCOMES.includes(promotion.outcome!)) continue
    const plan = deps.plans.forTeam(team.teamId, promotion.planId)
    if (plan === null) continue
    const content = deps.plans.approvedRevision(plan.id)?.content
    const lead = content?.leadGroup ?? null
    const role = lead ? content!.roles.find(entry => entry.group === lead) : undefined
    const caller = promotionCaller(team, promotion.id)
    try {
      const taskId = deps.db.transaction(() => {
        const id = `task-${crypto.randomUUID()}`
        const direction = correctionDirection(plan, promotion, id)
        const task = deps.tasks.createFixTask(caller, { id, title: correctionTitle(promotion, plan.title), direction, acceptance: CORRECTION_ACCEPTANCE }, made => {
          deps.decisions.insertFixTask({ taskId: made.id, teamId: team.teamId, planId: plan.id, sourceKind: 'promotion', sourceId: promotion.id })
        })
        if (lead) {
          deps.assignments.dispatchWithin(caller, {
            taskId: task.id, target: { kind: 'group', id: lead }, instruction: direction, requestKey: `correct:${promotion.id}`,
            allowedProfiles: role?.profiles.length ? role.profiles : undefined, tags: ['plan-fix'],
          })
        }
        return task.id
      })()
      created.push({ taskId, planId: plan.id })
    } catch (error) {
      if (error instanceof DecisionConflict && error.kind === 'fix-source-taken') continue
      throw error
    }
  }
  return created
}

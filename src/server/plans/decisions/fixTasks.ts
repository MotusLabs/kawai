// Fix tasks (plan-supervision design D7): an owner's override creates one
// task, with no worktree, change, parent, or plan link, its `plan_fix_tasks`
// row in the same transaction, and dispatches it to the plan's Lead role.
// This file is the only one that mints the decision-origin system callers,
// through functions it does not export, so Kawai acting for a decision can
// do only what `systemCaller.ts` grants those origins: create the fix,
// dispatch it, and close its earlier fix as creator. `prepareOverrideFix`
// runs the asynchronous parts first; its `commit` runs inside the
// override's transaction.
import type { Database } from 'bun:sqlite'
import type { DecisionCard, PlanDecision } from '../../../shared/planDecisions'
import type { Plan, PlanRevision } from '../../../shared/plans'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskService } from '../../team/TaskService'
import type { TaskStore } from '../../team/taskStore'
import type { AssignmentService } from '../../team/AssignmentService'
import type { PreparedTaskStatus } from '../../team/taskStatusPrepared'
import type { SystemCaller } from '../../team/systemCaller'
import type { DecisionStore } from './decisionStore'
import { deciderName } from './decisionInputs'

const overrideCaller = (team: TeamIdentity, decisionId: string): SystemCaller => ({ kind: 'system', team, origin: { kind: 'override', decisionId } })

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

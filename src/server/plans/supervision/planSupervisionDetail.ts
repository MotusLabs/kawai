// The plan's supervision detail (plan-supervision design D15, D16): what
// `team-plan-detail` and `plan_get` add to a plan — the decision cards with
// their history, fix status, and derived commits; each change's supervision
// with the "what stopped and why" report; and the plan's token usage. Derived
// at read time from the stores (the loader in `supervisionRead.ts`, the
// decision store, results, and `readPlanUsage`); nothing is stored.
import { cardState, currentDecision, fixStatus, type PlanDecisionCardView } from '../../../shared/planDecisions'
import { fixPlanFacts } from '../decisions/fixFacts'
import { planReport, type PlanSupervisionDetail } from '../../../shared/planReport'
import type { PlanImpact } from '../../../shared/strategyImpact'
import type { TeamTask } from '../../../shared/teamTasks'
import { TaskResultStore } from '../../team/taskResultStore'
import type { PlanStore } from '../planStore'
import { readPlanSupervision, supervisedRevision, type SupervisionReads } from './supervisionRead'
import { readPlanUsage } from './planUsageRead'

export interface SupervisionDetailReads extends SupervisionReads {
  plans: Pick<PlanStore, 'forTeam' | 'revision' | 'approvedRevision' | 'revisions'>
  tasks: { get: (id: string) => Pick<TeamTask, 'status'> | null }
  /** The plan's strategy impact, for the report's disposition line (C-I3). */
  impact?: (teamId: string, planId: string) => PlanImpact | null
}

/** Every card of the plan, oldest first, with its decisions, fixes, and the affected tasks' commits since the current decision. */
export function decisionCardViews(reads: SupervisionDetailReads, teamId: string, planId: string): PlanDecisionCardView[] {
  const plan = reads.plans.forTeam(teamId, planId)
  if (plan === null) return []
  const facts = fixPlanFacts(reads, teamId, plan)
  const results = new TaskResultStore(reads.db)
  return reads.decisions.cardsOfPlan(teamId, planId).map(card => {
    const decisions = reads.decisions.decisionsOfCard(teamId, card.id)
    const current = currentDecision(decisions)
    const overrides = decisions.filter(decision => decision.kind === 'override')
    const fixes = overrides.flatMap(override => {
      const fix = reads.decisions.fixTaskBySource(teamId, 'override', override.id)
      if (fix === null) return []
      const status = reads.tasks.get(fix.taskId)?.status ?? 'open'
      const superseded = overrides.some(later => later.seq > override.seq)
      return [{ decisionId: override.id, taskId: fix.taskId, status: fixStatus({ taskId: fix.taskId, status, superseded }, facts) }]
    })
    const commits = current === null ? [] : current.affected
      .map(taskId => ({
        taskId,
        commits: results.listByTask(taskId).filter(result => result.createdAt > current.createdAt && result.commit !== null).map(result => result.commit!),
      }))
      .filter(entry => entry.commits.length > 0)
    return { card, state: cardState(decisions), decisions, current, fixes, commits }
  })
}

/** The detail's three supervision fields; null for another team's or an unknown plan. */
export function readPlanSupervisionDetail(reads: SupervisionDetailReads, teamId: string, planId: string, now: Date): PlanSupervisionDetail | null {
  if (reads.plans.forTeam(teamId, planId) === null) return null
  const decisions = decisionCardViews(reads, teamId, planId)
  const changes = readPlanSupervision(reads, teamId, planId, now)
  const { execution, revision } = supervisedRevision(reads, teamId, planId)
  const content = revision?.content ?? { changes: [], successCriteria: [] }
  const candidates = execution === null ? [] : reads.integration?.candidates(teamId, execution.baseBranch).filter(row => row.executionId === execution.id) ?? []
  const impact = reads.impact?.(teamId, planId) ?? null
  const gate = impact?.gate ?? null
  const disposition = gate !== null && (gate.state === 'continue' || gate.state === 'adapt' || gate.state === 'reconsider') ? gate.state : null
  const report = planReport({
    supervision: changes,
    content,
    decisions,
    candidates,
    impact: impact !== null && impact.reviewId !== null && impact.reviewRevision !== null
      ? { disposition, reviewId: impact.reviewId, strategyRevision: impact.reviewRevision } : null,
  })
  return {
    decisions,
    supervision: { changes, report, computedAt: now.toISOString() },
    usage: readPlanUsage(reads.db, teamId, planId, content.changes.map(change => change.change)),
  }
}

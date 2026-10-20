// The plan attention sources (plan-supervision design D13): one source per
// kind over the team's plan facts — a stopped change, a stall, an open
// decision card, an open fix or correction task, an acceptance condition,
// and a failed promotion. `planAttentionFacts` gathers each open plan's
// facts once per snapshot over the same stores and supervision loader the
// monitor reads; the six sources are pure over them, so the queue is a
// projection like every other attention source. Every item links to its
// plan (and change, when it has one) and clears when its cause clears —
// derived at read time, nothing stored.
import { attentionItemId, type SummaryItem } from '../../shared/teamWorkspace'
import { FIX_PHASE_LABELS, cardState, fixStatus, type DecisionCard, type FixStatus, type PlanFixTask } from '../../shared/planDecisions'
import { stopReasonLabel, type ChangeSupervision } from '../../shared/planSupervision'
import { taskImpact } from './attentionAcceptance'
import type { AttentionInput, AttentionSource } from './workspaceRead'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import type { SupervisionDetailReads } from '../plans/supervision/planSupervisionDetail'
import { fixPlanFacts } from '../plans/decisions/fixFacts'
import type { DecisionStore } from '../plans/decisions/decisionStore'
import type { ExecutionStore } from '../plans/execution/executionStore'
import type { IntegrationStore } from '../plans/landing/integration/integrationStore'
import type { PlanStore } from '../plans/planStore'
import type { StallAlertStore } from '../plans/supervision/stallAlertStore'

/** One change of the plan's newest execution, with the facts its items read. */
export interface PlanChangeFact {
  /** The change row's task; null before provisioning assigns one. */
  taskId: string | null
  /** The row's generation: a re-stop after a retry is a new item identity. */
  generation: number
  supervision: ChangeSupervision
}

/** One open fix or correction task with its derived status (D13). */
export interface PlanFixFact {
  taskId: string
  title: string | null
  status: FixStatus
}

/** One open plan's attention facts, gathered by `planAttentionFacts`. */
export interface PlanAttentionFact {
  teamId: string
  planId: string
  planTitle: string
  /** The plan's Lead role group; null without one (fixes stay unassigned). */
  leadGroup: string | null
  /** The newest execution's id; null when the plan never started one. */
  executionId: string | null
  changes: PlanChangeFact[]
  /** Open decision cards: no decision recorded yet. */
  openCards: DecisionCard[]
  fixes: PlanFixFact[]
  /**
   * The newest failed promotion while no later promotion has started
   * (it is the newest overall); null when the newest promotion did not fail.
   */
  failedPromotion: { id: string; targetBranch: string; reason: string | null } | null
  /** Whether that promotion's correction task is open. */
  correctionOpen: boolean
}

/** What the gatherer reads: the supervision detail's reads plus the promotion listing. */
export interface PlanAttentionReads extends SupervisionDetailReads {
  promotions?: Pick<IntegrationStore, 'promotionsOf'>
}

const OPEN_TASK = new Set(['open', 'active', 'blocked'])

/** Whether a fix task is superseded: a later override of its card exists (D6). */
function superseded(reads: PlanAttentionReads, teamId: string, fix: PlanFixTask): boolean {
  if (fix.sourceKind !== 'override') return false
  const decision = reads.decisions.decision(teamId, fix.sourceId)
  if (decision === null) return false
  return reads.decisions.decisionsOfCard(teamId, decision.cardId)
    .some(later => later.kind === 'override' && later.seq > decision.seq)
}

/** Every open plan's facts, in the store's order. Another team's plans never enter. */
export function planAttentionFacts(reads: PlanAttentionReads, teamId: string, now: Date): PlanAttentionFact[] {
  return reads.plans.openPlans(teamId).map(plan => {
    const derived = derivePlanSupervision(reads, teamId, plan.id, now)
    const revision = derived?.revision ?? plan.currentApprovedRevision
    const executionId = derived?.executionId ?? null
    const rows = executionId === null ? [] : reads.executions.changes(executionId)
    const byChange = new Map(rows.map(row => [row.change, row]))
    const facts = fixPlanFacts(reads, teamId, plan)
    const fixes = reads.decisions.fixTasksOfPlan(teamId, plan.id)
      .filter(fix => {
        const status = reads.tasks.get(fix.taskId)?.status
        return status !== undefined && OPEN_TASK.has(status)
      })
      .map(fix => ({
        taskId: fix.taskId,
        title: reads.tasks.get(fix.taskId)?.title ?? null,
        status: fixStatus({ taskId: fix.taskId, status: reads.tasks.get(fix.taskId)?.status ?? 'open', superseded: superseded(reads, teamId, fix) }, facts),
      }))
    // The newest promotion (the store orders by number): its failure is the
    // item's cause, and it stays the cause only while nothing started later.
    const newest = reads.promotions?.promotionsOf(plan.id).at(-1) ?? null
    const outcome = newest?.outcome ?? null
    const failed = outcome !== null && outcome.startsWith('failed:')
      ? { id: newest!.id, targetBranch: newest!.targetBranch, reason: outcome.slice('failed:'.length) }
      : null
    const correction = failed === null ? null : reads.decisions.fixTaskBySource(teamId, 'promotion', failed.id)
    const correctionOpen = correction !== null && OPEN_TASK.has(reads.tasks.get(correction.taskId)?.status ?? 'done')
    return {
      teamId, planId: plan.id, planTitle: plan.title,
      leadGroup: revision === null ? null : reads.plans.revision(plan.id, revision)?.content.leadGroup ?? null,
      executionId,
      changes: (derived?.changes ?? []).map(supervision => ({
        taskId: byChange.get(supervision.change)?.taskId ?? null,
        generation: byChange.get(supervision.change)?.generation ?? 0,
        supervision,
      })),
      openCards: reads.decisions.cardsOfPlan(teamId, plan.id)
        .filter(card => cardState(reads.decisions.decisionsOfCard(teamId, card.id)) === 'open'),
      fixes,
      failedPromotion: failed,
      correctionOpen,
    }
  })
}

const humanOwner = { kind: 'human' as const, id: null, label: 'Human' }
const groupOwner = (groupId: string) => ({ kind: 'group' as const, id: groupId, label: groupId })
const planLink = (fact: PlanAttentionFact, change?: string) =>
  ({ kind: 'plan', id: fact.planId, planId: fact.planId, ...(change === undefined ? {} : { change }) }) as const

/** A stopped change: the human retries or stops the execution (D13). */
export const planStopItems: AttentionSource = ({ plans, taskTitle }: AttentionInput) =>
  (plans ?? []).flatMap(fact => fact.changes
    .filter(change => change.supervision.outcome === 'stopped')
    .map(change => {
      const cause = change.supervision.cause
      const reason = cause.kind === 'stopped' ? cause.reason : 'unknown'
      return {
        id: attentionItemId('plan-stop', `${fact.executionId}:${change.supervision.change}:${change.generation}`),
        kind: 'plan-stop' as const,
        cause: `Change ${change.supervision.change} of plan "${fact.planTitle}" stopped: ${stopReasonLabel(reason)}`,
        owner: humanOwner,
        impact: taskImpact(change.taskId, taskTitle),
        nextAction: 'Retry or stop execution',
        link: planLink(fact, change.supervision.change),
        requiresHuman: true,
      }
    }))

/** A stall: the plan's Lead role unblocks the holder, else the human (D13). */
export const planStallItems: AttentionSource = ({ plans, taskTitle }: AttentionInput) =>
  (plans ?? []).flatMap(fact => fact.changes
    .filter(change => change.supervision.outcome === 'stalled' && change.supervision.stall !== null)
    .map(change => ({
      id: attentionItemId('plan-stall', `${fact.executionId}:${change.supervision.change}:${change.supervision.stall!.episodeKey}`),
      kind: 'plan-stall' as const,
      cause: `Change ${change.supervision.change} of plan "${fact.planTitle}" is stalled: ` +
        (change.supervision.stall!.kind === 'no-progress' ? 'no progress' : 'repeating failure'),
      owner: fact.leadGroup === null ? humanOwner : groupOwner(fact.leadGroup),
      impact: taskImpact(change.taskId, taskTitle),
      nextAction: 'Unblock the holder',
      link: planLink(fact, change.supervision.change),
      requiresHuman: fact.leadGroup === null,
    })))

/** An open decision card: its addressed group answers, else the human (D13). */
export const decisionQuestionItems: AttentionSource = ({ plans, taskTitle }: AttentionInput) =>
  (plans ?? []).flatMap(fact => fact.openCards.map(card => {
    const owner = card.addressedTo === 'lead' && card.addressedGroup !== null ? groupOwner(card.addressedGroup) : humanOwner
    return {
      id: attentionItemId('decision-question', card.id),
      kind: 'decision-question' as const,
      cause: `Decision card asks: ${card.question}`,
      owner,
      impact: taskImpact(card.taskId, taskTitle),
      nextAction: 'Answer the question',
      link: { kind: 'card', id: card.id, planId: fact.planId },
      requiresHuman: owner.kind === 'human',
    }
  }))

/**
 * An open fix or correction task (D13): the Lead role plans it, the human
 * assigns, approves, or starts it, and the four fixStatus phases decide
 * which. An open task whose changes landed raises nothing — its cause has
 * cleared, and the monitor closes the task.
 */
export const planFixItems: AttentionSource = ({ plans, taskTitle }: AttentionInput) =>
  (plans ?? []).flatMap(fact => fact.fixes
    .filter(fix => ['planning', 'in-review', 'approved', 'running'].includes(fix.status.phase))
    .map(fix => {
      const lead = fact.leadGroup === null ? null : groupOwner(fact.leadGroup)
      const phase = fix.status.phase
      const owner = phase === 'in-review' || phase === 'approved' ? humanOwner
        : lead ?? humanOwner
      const nextAction = phase === 'planning' ? (lead === null ? 'Assign' : 'Plan the fix')
        : phase === 'in-review' ? `Approve revision ${fix.status.revision ?? ''}`.replace(/\s+$/, '')
        : phase === 'approved' ? 'Start execution'
        : 'Wait for the fix to land'
      return {
        id: attentionItemId('plan-fix', fix.taskId),
        kind: 'plan-fix' as const,
        cause: `Fix task "${fix.title ?? fix.taskId}" of plan "${fact.planTitle}" is ${FIX_PHASE_LABELS[phase].toLowerCase()}`,
        owner,
        impact: taskImpact(fix.taskId, taskTitle),
        nextAction,
        link: planLink(fact),
        // While the fix runs it is a wait, never a Needs-you: both the Lead
        // role and the human wait until it lands (plan-supervision D13).
        requiresHuman: phase !== 'running' && owner.kind === 'human',
      }
    }))

/** An acceptance condition holding a change: the human resolves it (D13). One item per condition target. */
export const planConditionItems: AttentionSource = ({ plans, taskTitle }: AttentionInput) =>
  (plans ?? []).flatMap(fact => fact.changes.flatMap(change => {
    const targets = new Set([change.supervision.cause, ...change.supervision.alsoApplying]
      .flatMap(wait => (wait.kind === 'condition' ? wait.conditions : [])))
    return [...targets].map(target => ({
      id: attentionItemId('plan-condition', `${fact.executionId}:${change.supervision.change}:${target}`),
      kind: 'plan-condition' as const,
      cause: `Change ${change.supervision.change} of plan "${fact.planTitle}" waits on acceptance condition: ${target}`,
      owner: humanOwner,
      impact: taskImpact(change.taskId, taskTitle),
      nextAction: 'Resolve condition',
      link: planLink(fact, change.supervision.change),
      requiresHuman: true,
    }))
  }))

/**
 * The plan's newest failed promotion (D13): raised while no later promotion
 * has started (it is the newest overall) and no correction task for it is
 * open — so it returns when the correction closes and never sits beside one.
 */
export const planPromotionItems: AttentionSource = ({ plans }: AttentionInput) =>
  (plans ?? []).flatMap(fact => {
    if (fact.failedPromotion === null || fact.correctionOpen) return []
    return [{
      id: attentionItemId('plan-promotion', fact.failedPromotion.id),
      kind: 'plan-promotion' as const,
      cause: `Promotion of plan "${fact.planTitle}" to ${fact.failedPromotion.targetBranch} failed` +
        (fact.failedPromotion.reason ? `: ${fact.failedPromotion.reason}` : ''),
      owner: humanOwner,
      impact: {},
      nextAction: 'Promote again',
      link: planLink(fact),
      requiresHuman: true,
    }]
  })

/** One durable plan row of the summary window, with its plan's title (D13). */
export interface PlanSummaryRow {
  planId: string
  planTitle: string | null
}

export interface PlanSummaryRows {
  /** Landing facts by landed_at. */
  landings: Array<PlanSummaryRow & { change: string; landedAt: string }>
  /** Change rows stopped, by updated_at. */
  stops: Array<PlanSummaryRow & { change: string; stoppedAt: string; reason: string | null }>
  /** Stall-alert rows by raised_at. */
  stallAlerts: Array<PlanSummaryRow & { id: string; change: string; kind: string; raisedAt: string }>
  /** Decisions of kind answer or own-call, by created_at. */
  decisions: Array<PlanSummaryRow & { decisionId: string; createdAt: string }>
  /** Decisions of kind override, by created_at. */
  overrides: Array<PlanSummaryRow & { decisionId: string; createdAt: string }>
}

/** What the summary's plan rows read: the durable stores' window queries. */
export interface PlanSummaryRowReads {
  plans: Pick<PlanStore, 'get'>
  executions: Pick<ExecutionStore, 'landingsSince' | 'stoppedChangesSince'>
  decisions: Pick<DecisionStore, 'decisionsSince'>
  alerts: Pick<StallAlertStore, 'raisedSince'>
}

/** The window's plan rows for one team, from durable records only. */
export function planSummaryRows(reads: PlanSummaryRowReads, teamId: string, since: string): PlanSummaryRows {
  const titled = (planId: string): PlanSummaryRow => ({ planId, planTitle: reads.plans.get(planId)?.title ?? null })
  // One window query, partitioned by kind (D13): answers and own-calls are
  // decisions, overrides their own bucket. The edge is inclusive.
  const windowed = reads.decisions.decisionsSince(teamId, since)
  return {
    landings: reads.executions.landingsSince(teamId, since).map(row => ({
      ...titled(row.planId), change: row.change, landedAt: row.landedAt,
    })),
    stops: reads.executions.stoppedChangesSince(teamId, since).map(row => ({
      ...titled(row.planId), change: row.change, stoppedAt: row.updatedAt, reason: row.stopReason,
    })),
    stallAlerts: reads.alerts.raisedSince(teamId, since).map(row => ({
      ...titled(row.planId), id: row.id, change: row.change, kind: row.kind, raisedAt: row.raisedAt,
    })),
    decisions: windowed
      .filter(decision => decision.kind === 'answer' || decision.kind === 'own-call')
      .map(decision => ({ ...titled(decision.planId), decisionId: decision.id, createdAt: decision.createdAt })),
    overrides: windowed
      .filter(decision => decision.kind === 'override')
      .map(decision => ({ ...titled(decision.planId), decisionId: decision.id, createdAt: decision.createdAt })),
  }
}

/** The summary's plan items (plan-supervision D13): every row links to its plan. */
export function planSummaryItems(rows: PlanSummaryRows): Record<'landings' | 'stops' | 'stallAlerts' | 'decisions' | 'overrides', SummaryItem[]> {
  const planItem = (id: string, label: string, planId: string, change?: string): SummaryItem =>
    ({ id, label, link: { kind: 'plan', id: planId, planId, ...(change === undefined ? {} : { change }) } })
  return {
    landings: rows.landings.map(row =>
      planItem(`landing:${row.planId}:${row.change}:${row.landedAt}`, `Change ${row.change} of plan "${row.planTitle ?? row.planId}" landed`, row.planId, row.change)),
    stops: rows.stops.map(row =>
      planItem(`stop:${row.planId}:${row.change}:${row.stoppedAt}`,
        `Change ${row.change} of plan "${row.planTitle ?? row.planId}" stopped${row.reason ? `: ${stopReasonLabel(row.reason)}` : ''}`,
        row.planId, row.change)),
    stallAlerts: rows.stallAlerts.map(row =>
      planItem(`stall-alert:${row.id}`, `Stall alert (${row.kind}) on change ${row.change} of plan "${row.planTitle ?? row.planId}"`, row.planId, row.change)),
    decisions: rows.decisions.map(row =>
      planItem(`decision:${row.decisionId}`, `Decision recorded on plan "${row.planTitle ?? row.planId}"`, row.planId)),
    overrides: rows.overrides.map(row =>
      planItem(`override:${row.decisionId}`, `Decision overridden on plan "${row.planTitle ?? row.planId}"`, row.planId)),
  }
}

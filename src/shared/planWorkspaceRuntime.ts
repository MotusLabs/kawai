// The workspace's runtime projection (plan-workspace 3.1, design D2/D3),
// SDK-free like planSupervision.ts, derived when read and never stored. It
// overlays each displayed change's authoritative execution outcome — keyed by
// change identity across revisions (LC1) — with the linked work's holders and
// history, and keeps work outside the displayed version discoverable
// separately. Checkbox totals and execution states stay distinct facts
// beside each other; a holder never selects a state row, and a former holder
// is history, never current ownership.
import type { PlanContent } from './plans'
import { planChangeModified } from './plans'
import type { ChangeSupervision } from './planSupervision'
import { causeLabel } from './planSupervision'
import { teamTaskStage } from './teamTaskStage'
import type { TeamTaskStage } from './teamWorkspace'
import type { TaskStatus } from './teamTasks'

/**
 * How a displayed change relates to the selected execution's entry for the
 * same name (LC1): overlay only by change identity, labelled with the
 * execution revision; a modified proposed definition never renders as the
 * definition executing.
 */
export type WorkspaceExecutionRelation = 'no-execution' | 'overlay' | 'overlay-modified' | 'new-in-version'

/** One current holder of a change's linked work (spec: assignments at change level). */
export interface WorkspaceHolderView {
  taskId: string
  /**
   * A claimed session, a requested group nobody has claimed, or a requested
   * session nobody has claimed — never an invented agent.
   */
  holder:
    | { kind: 'session'; sessionId: string; name: string | null }
    | { kind: 'group-unclaimed'; groupId: string }
    | { kind: 'session-unclaimed'; sessionId: string; name: string | null }
  stage: TeamTaskStage | null
  /** The instruction's mailbox waiting reason (e.g. the group's blocker), when staffing holds the work. */
  waitingReason: string | null
}

/** Previous participation (D3): identity and stage, never current ownership, never readings. */
export interface WorkspaceHolderHistory {
  sessionId: string
  name: string | null
  stage: TeamTaskStage | null
  source: 'former-claimant' | 'result-submitter'
}

/** The authoritative displayed state of one change (CP1 rev 2's ladder, as amended). */
export type WorkspaceRuntimeState =
  | { kind: 'no-execution' }
  | { kind: 'not-overlaid' }
  | { kind: 'landed'; landedAt: string | null; treeVerified: boolean }
  | { kind: 'stopped'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'not-started' }
  | { kind: 'stalled'; stall: 'no-progress' | 'repeating-failure' }
  | { kind: 'in-review'; reviewer: string | null }
  | { kind: 'ready-for-qa' }
  | { kind: 'fixes-requested' }
  | { kind: 'waiting'; cause: string }
  | { kind: 'implementing'; stage: string | null }

/** One displayed change's runtime row: state, holders, history, checklist totals beside it. */
export interface WorkspaceRuntimeChange {
  change: string
  relation: WorkspaceExecutionRelation
  /** E, the revision the overlaid state is attributed to; null with no selected execution. */
  executionRevision: number | null
  /** The displayed definition differs from the executing one (LC1 2b). */
  modifiedSinceExecution: boolean
  state: WorkspaceRuntimeState
  holders: WorkspaceHolderView[]
  history: WorkspaceHolderHistory[]
  /** The checklist projection's totals beside the state — a separate fact, never row-selecting. */
  checklist: { total: number; checked: number } | null
}

/** Work outside the displayed version, kept discoverable separately (spec: planning during execution). */
export interface WorkspaceRuntimeOutside {
  /** Changes of the selected execution absent from the displayed version (LC1 2d), with their states. */
  changes: Array<{ change: string; executionRevision: number; state: WorkspaceRuntimeState }>
  /** Linked tasks whose plan_change the displayed version no longer lists (plans.ts outsideRevision). */
  tasks: Array<{ taskId: string; title: string; planChange: string; holders: WorkspaceHolderView[] }>
}

export interface WorkspaceRuntimeView {
  /** The selected execution and the revision it runs; null while none is selected. */
  execution: { executionId: string; revision: number } | null
  changes: WorkspaceRuntimeChange[]
  outside: WorkspaceRuntimeOutside
}

/** The linked-task facts one holder/history row is shaped from (the composer reads the stores). */
export interface WorkspaceLinkedTaskInput {
  id: string
  title: string
  status: TaskStatus
  planChange: string
  /** The task's outstanding assignment (newest not superseded and not failed); null when unassigned. */
  assignment: {
    targetKind: 'group' | 'session'
    targetId: string
    claimedBy: string | null
    handoffKind: 'review' | 'qa' | 'fix' | null
    /** The derived dispatch state (queued, claimed, delivered, …) the stage ladder reads. */
    state: 'queued' | 'claimed' | 'delivered' | 'parked' | 'forwarded' | 'uncertain'
  } | null
  /** The outstanding result's facts; null when none was submitted. */
  result: { submitter: string; accepted: boolean; reviewVerdict: 'pass' | 'fail' | null } | null
  /** Claimants of superseded and failed assignments, oldest first (history). */
  priorClaimants: Array<{ sessionId: string; handoffKind: 'review' | 'qa' | 'fix' | null }>
  /** The unclaimed instruction's mailbox waiting reason; null when claimed or nothing is waiting. */
  waitingReason: string | null
}

/** The stage a handoff kind held (identity and stage for history rows). */
function handoffStage(handoffKind: 'review' | 'qa' | 'fix' | null): TeamTaskStage {
  if (handoffKind === 'review') return 'in-review'
  if (handoffKind === 'qa') return 'ready-for-qa'
  if (handoffKind === 'fix') return 'fixes-requested'
  return 'implementing'
}

/** The stage a result submitter's participation is read at: their findings, not the task's current stage. */
function submitterStage(result: NonNullable<WorkspaceLinkedTaskInput['result']>): TeamTaskStage {
  return result.reviewVerdict === 'fail' ? 'fixes-requested' : 'awaiting-acceptance'
}

/** One task's holders and history (LC3's fixed classes; the composer fills names). */
export function workspaceTaskHolders(task: WorkspaceLinkedTaskInput): {
  holder: WorkspaceHolderView | null
  history: WorkspaceHolderHistory[]
} {
  const history: WorkspaceHolderHistory[] = []
  const seen = new Set<string>()
  for (const prior of task.priorClaimants) {
    if (prior.sessionId === null || seen.has(prior.sessionId)) continue
    seen.add(prior.sessionId)
    history.push({ sessionId: prior.sessionId, name: null, stage: handoffStage(prior.handoffKind), source: 'former-claimant' })
  }
  // The submitter is a second historical fact even when they also claimed
  // before: identity and stage from the task records, never readings.
  if (task.result) {
    history.push({ sessionId: task.result.submitter, name: null, stage: submitterStage(task.result), source: 'result-submitter' })
  }
  const assignment = task.assignment
  if (assignment === null) return { holder: null, history }
  const waiting = task.waitingReason
  // The holder's stage is the task's own workflow stage (the real ladder):
  // a queued dispatch is unstarted, not implementing.
  const stage = teamTaskStage({ status: task.status }, assignment, task.result)
  const holder: WorkspaceHolderView = assignment.claimedBy !== null
    ? { taskId: task.id, holder: { kind: 'session', sessionId: assignment.claimedBy, name: null }, stage, waitingReason: null }
    : assignment.targetKind === 'group'
      ? { taskId: task.id, holder: { kind: 'group-unclaimed', groupId: assignment.targetId }, stage, waitingReason: waiting }
      : { taskId: task.id, holder: { kind: 'session-unclaimed', sessionId: assignment.targetId, name: null }, stage, waitingReason: waiting }
  return { holder, history }
}

/** The facts one state row is derived from (the ladder's inputs beside the supervision itself). */
export interface WorkspaceStateFacts {
  supervision: ChangeSupervision | null
  /** The linked work's outstanding handoff kind, when one stands (rows 10–12). */
  handoff: 'review' | 'qa' | 'fix' | null
  /** The outstanding review handoff's claimant; row 10 names them when it keys on the handoff. */
  reviewClaimant: string | null
  /** The outstanding result's newest findings fail (row 12). */
  failingFindings: boolean
}

/**
 * The state ladder, first match wins (CP1 rev 2 as amended; one row per
 * change). Holders never select a row: rows 10–12 key on the outstanding
 * handoff or failing findings, and 'reviewing' is not an outcome — "In
 * review" keys on the review stage or handoff.
 */
export function workspaceChangeState(facts: WorkspaceStateFacts): WorkspaceRuntimeState {
  const s = facts.supervision
  if (s === null) return { kind: 'not-overlaid' }
  const outcome = s.outcome
  if (outcome === 'landed') {
    return { kind: 'landed', landedAt: s.landing?.landedAt ?? null, treeVerified: s.landing?.treeVerified ?? false }
  }
  if (outcome === 'stopped') {
    return { kind: 'stopped', reason: s.cause.kind === 'stopped' ? s.cause.reason : '' }
  }
  if (outcome === 'cancelled') return { kind: 'cancelled' }
  if (outcome === 'not-started') return { kind: 'not-started' }
  if (outcome === 'stalled') {
    return { kind: 'stalled', stall: s.stall?.kind ?? 'no-progress' }
  }
  // Rows 10–12 key on the stage or the outstanding handoff, never a holder.
  // A handoff-keyed In review names the review claimant (B1), not the
  // instruction holder the supervision still carries.
  if (facts.handoff === 'review') return { kind: 'in-review', reviewer: facts.reviewClaimant }
  if (s.stage === 'review') return { kind: 'in-review', reviewer: s.holder?.session ?? null }
  if (facts.handoff === 'qa') return { kind: 'ready-for-qa' }
  if (facts.handoff === 'fix' || facts.failingFindings) return { kind: 'fixes-requested' }
  if (outcome === 'waiting') return { kind: 'waiting', cause: causeLabel(s.cause) }
  return { kind: 'implementing', stage: s.stage }
}

/** LC1's relation of one displayed change to the selected execution's entry for the same name. */
export function workspaceExecutionRelation(
  displayed: PlanContent,
  execution: PlanContent | null,
  change: string,
): WorkspaceExecutionRelation {
  if (execution === null) return 'no-execution'
  const inDisplayed = displayed.changes.some(entry => entry.change === change)
  const inExecution = execution.changes.some(entry => entry.change === change)
  if (!inDisplayed) return 'new-in-version'
  if (!inExecution) return 'new-in-version'
  return planChangeModified(execution, displayed, change) ? 'overlay-modified' : 'overlay'
}

export interface WorkspaceRuntimeInputs {
  displayed: PlanContent
  /** The selected execution and the revision it runs; null while none is selected. */
  execution: { executionId: string; revision: number; content: PlanContent } | null
  /** Each change of the selected execution, derived by the supervision loader. */
  supervision: ReadonlyMap<string, ChangeSupervision>
  tasks: readonly WorkspaceLinkedTaskInput[]
  /** Checklist totals beside each state, when the projection has them. */
  checklistTotals?: (change: string) => { total: number; checked: number } | null
}

/** The whole runtime projection for one displayed version (3.1), derived, never stored. */
export function workspaceRuntime(inputs: WorkspaceRuntimeInputs): WorkspaceRuntimeView {
  const displayedNames = new Set(inputs.displayed.changes.map(entry => entry.change))
  const execution = inputs.execution
  const byTask = new Map<string, { holder: WorkspaceHolderView | null; history: WorkspaceHolderHistory[] }>()
  for (const task of inputs.tasks) byTask.set(task.id, workspaceTaskHolders(task))
  const holdersOf = (change: string): WorkspaceHolderView[] =>
    inputs.tasks.filter(task => task.planChange === change)
      .map(task => byTask.get(task.id)!.holder)
      .filter((holder): holder is WorkspaceHolderView => holder !== null)
  const historyOf = (change: string): WorkspaceHolderHistory[] =>
    inputs.tasks.filter(task => task.planChange === change).flatMap(task => byTask.get(task.id)!.history)
  const factsOf = (change: string): WorkspaceStateFacts => {
    const tasks = inputs.tasks.filter(task => task.planChange === change)
    const withHandoff = tasks.find(task => task.assignment?.handoffKind != null) ?? null
    const failingFindings = tasks.some(task => task.result !== null && !task.result.accepted && task.result.reviewVerdict === 'fail')
    return {
      supervision: inputs.supervision.get(change) ?? null,
      handoff: withHandoff?.assignment?.handoffKind ?? null,
      reviewClaimant: withHandoff?.assignment?.claimedBy ?? null,
      failingFindings,
    }
  }
  const rowOf = (change: string, relation: WorkspaceExecutionRelation): WorkspaceRuntimeChange => ({
    change,
    relation,
    executionRevision: execution?.revision ?? null,
    modifiedSinceExecution: relation === 'overlay-modified',
    state: relation === 'no-execution' ? { kind: 'no-execution' } : relation === 'new-in-version' ? { kind: 'not-overlaid' } : workspaceChangeState(factsOf(change)),
    holders: holdersOf(change),
    history: historyOf(change),
    checklist: inputs.checklistTotals?.(change) ?? null,
  })
  return {
    execution: execution ? { executionId: execution.executionId, revision: execution.revision } : null,
    changes: inputs.displayed.changes.map(entry =>
      rowOf(entry.change, workspaceExecutionRelation(inputs.displayed, execution?.content ?? null, entry.change))),
    outside: {
      changes: execution === null ? [] : execution.content.changes
        .filter(entry => !displayedNames.has(entry.change))
        .map(entry => ({ change: entry.change, executionRevision: execution.revision, state: workspaceChangeState(factsOf(entry.change)) })),
      tasks: inputs.tasks.filter(task => !displayedNames.has(task.planChange))
        .map(task => ({ taskId: task.id, title: task.title, planChange: task.planChange, holders: holdersOf(task.planChange) })),
    },
  }
}

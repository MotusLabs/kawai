// SDK-free decision records and their pure derivations (plan-supervision
// design D2, D3, D12, D13, D15; contracts S1 and S4), shared by the server,
// `plan_get`, and the Plans view. It names:
// - `DecisionCard` and `PlanDecision`: one `plan_decision_cards` row and one
//   `plan_decisions` row; a card's state is derived, never stored;
// - `PlanFixTask`: one `plan_fix_tasks` row tying a fix or correction task to
//   its plan and source;
// - `FixStatus`: a fix task's derived phase;
// - `PlanDecisionCardView`: what the detail and `plan_get` show per card.
// The functions own every rule, so readers agree without a database:
// `currentDecision`, `cardState`, `fixLandings`, `fixStatus`,
// `overrideCounts` (M2), `fixDurations` (M4), and `fixesFieldErrors`.
import type { ExecutionState } from './planExecution'
import type { PlanContent, PlanRevisionStatus } from './plans'
import type { TaskStatus } from './teamTasks'

export type CardAddressee = 'lead' | 'owner'
export type DecisionKind = 'answer' | 'own-call' | 'override'
export type CardState = 'open' | 'decided' | 'overridden'

/** Who asked or decided: the session, group, and profile at the time; all null for the human. */
export interface DecisionParty {
  kind: 'agent' | 'human'
  session: string | null
  group: string | null
  profile: string | null
}

/** One `plan_decision_cards` row (D3). */
export interface DecisionCard {
  id: string
  teamId: string
  planId: string
  /** The revision the asker works from; null for a Lead card naming the plan. */
  revision: number | null
  change: string | null
  taskId: string | null
  question: string
  options: string[]
  context: string | null
  askedBy: { session: string; group: string | null; profile: string | null }
  addressedTo: CardAddressee
  /** Set when addressed to `lead`. */
  addressedGroup: string | null
  /** The question mail, when one was sent. */
  messageId: string | null
  createdAt: string
}

/** One `plan_decisions` row (D3): `seq` 1 is the first decision, each override adds one. */
export interface PlanDecision {
  id: string
  cardId: string
  planId: string
  teamId: string
  seq: number
  kind: DecisionKind
  choice: string
  /** 1-based, when the choice is one of the card's options. */
  optionIndex: number | null
  rationale: string | null
  decidedBy: DecisionParty
  /** Task ids. */
  affected: string[]
  /** Human commands only. */
  commandId: string | null
  replyMessageId: string | null
  createdAt: string
}

export type FixSourceKind = 'override' | 'promotion'

/** One `plan_fix_tasks` row (D7, D8). */
export interface PlanFixTask {
  taskId: string
  teamId: string
  planId: string
  sourceKind: FixSourceKind
  /** The override decision id, or the promotion id. */
  sourceId: string
  createdAt: string
}

/** A landing fact of a change that named the fix task in the revision it landed under (D8). */
export interface FixLanding {
  change: string
  executionId: string
  mergeSha: string
  landedAt: string
  treeVerified: boolean
}

export type FixPhase = 'planning' | 'in-review' | 'approved' | 'running' | 'landed' | 'no-change' | 'superseded' | 'cancelled'

/** A fix task's derived status (D2, D13; contract S4). */
export interface FixStatus {
  phase: FixPhase
  /** `in-review`/`approved`: the revision naming the task. */
  revision: number | null
  /** `running`: the execution landing it; `approved`: another running execution it waits for. */
  executionId: string | null
  /** Landed changes so far, by the revision each landed under. */
  landings: FixLanding[]
  /** Changes of the current approved revision naming the task that have not landed. */
  outstanding: string[]
}

export const FIX_PHASE_LABELS: Record<FixPhase, string> = {
  planning: 'Planning',
  'in-review': 'In review',
  approved: 'Approved',
  running: 'Running',
  landed: 'Landed',
  'no-change': 'No change',
  superseded: 'Superseded',
  cancelled: 'Cancelled',
}

/** One card as the detail and `plan_get` show it (D15): history oldest first. */
export interface PlanDecisionCardView {
  card: DecisionCard
  state: CardState
  decisions: PlanDecision[]
  current: PlanDecision | null
  /** Per override, its fix task and status. */
  fixes: Array<{ decisionId: string; taskId: string; status: FixStatus }>
  /** The affected tasks' result commits since the current decision. */
  commits: Array<{ taskId: string; commits: string[] }>
}

/** The current decision: the highest `seq` (D3); null while open. */
export function currentDecision(decisions: readonly PlanDecision[]): PlanDecision | null {
  let current: PlanDecision | null = null
  for (const decision of decisions) if (current === null || decision.seq > current.seq) current = decision
  return current
}

/** D3: open with no decision, decided under an answer or own call, overridden under an override. */
export function cardState(decisions: readonly PlanDecision[]): CardState {
  const current = currentDecision(decisions)
  if (current === null) return 'open'
  return current.kind === 'override' ? 'overridden' : 'decided'
}

const TASK_ID = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** D2: a change's `fixes` entries must be task ids, none empty and none repeated; every violation is named. */
export function fixesFieldErrors(change: string, fixes: readonly string[] | undefined): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const entry of fixes ?? []) {
    if (!entry.trim()) errors.push(`Change "${change}" lists an empty fixes entry; name a fix or correction task id (task-<uuid>).`)
    else if (!TASK_ID.test(entry)) errors.push(`Change "${change}" fixes entry "${entry}" is not a task id (task-<uuid>).`)
    if (seen.has(entry)) repeated.add(entry)
    seen.add(entry)
  }
  for (const entry of repeated) if (entry.trim()) errors.push(`Change "${change}" lists fixes entry "${entry}" more than once.`)
  return errors
}

/**
 * D2's read-time reference check: each `fixes` entry of the given revisions'
 * changes that names none of the plan's fix or correction tasks becomes one
 * warning, once per id, in content order. A warning never refuses anything.
 */
export function fixesReferenceWarnings(contents: ReadonlyArray<Pick<PlanContent, 'changes'>>, planFixTaskIds: ReadonlySet<string>): string[] {
  const missing = new Set<string>()
  for (const content of contents) {
    for (const change of content.changes) for (const entry of change.fixes ?? []) if (entry.trim() && !planFixTaskIds.has(entry)) missing.add(entry)
  }
  return [...missing].map(id => `fixes names no fix or correction task of this plan: ${id}`)
}

/** The plan revisions, executions, and landing facts a fix reads (D8). */
export interface FixPlanFacts {
  revisions: ReadonlyArray<{ revision: number; status: PlanRevisionStatus; content: Pick<PlanContent, 'changes'> }>
  currentApprovedRevision: number | null
  executions: ReadonlyArray<{ id: string; revision: number; state: ExecutionState }>
  /** Every landing fact of the plan (one per change). */
  landings: ReadonlyArray<FixLanding>
}

const namingChanges = (content: Pick<PlanContent, 'changes'>, taskId: string): string[] =>
  content.changes.filter(change => change.fixes?.includes(taskId)).map(change => change.change)

/**
 * D8's completion facts: the changes that landed naming the task in the
 * revision of the execution that landed them, and the changes of the current
 * approved revision naming it with no landing fact. A later revision that drops
 * a landed change therefore never strands the fix.
 */
export function fixLandings(taskId: string, facts: FixPlanFacts): { landings: FixLanding[]; outstanding: string[] } {
  const revisions = new Map(facts.revisions.map(revision => [revision.revision, revision]))
  const executions = new Map(facts.executions.map(execution => [execution.id, execution]))
  const landings = facts.landings.filter(landing => {
    const execution = executions.get(landing.executionId)
    const revision = execution === undefined ? undefined : revisions.get(execution.revision)
    return revision !== undefined && namingChanges(revision.content, taskId).includes(landing.change)
  })
  const current = facts.currentApprovedRevision === null ? undefined : revisions.get(facts.currentApprovedRevision)
  const landed = new Set(landings.map(landing => landing.change))
  const outstanding = current === undefined ? [] : namingChanges(current.content, taskId).filter(change => !landed.has(change))
  return { landings, outstanding }
}

/** A fix task as `fixStatus` reads it; `superseded` = a newer override of its card exists. */
export interface FixTaskFacts {
  taskId: string
  status: TaskStatus
  superseded: boolean
}

/**
 * The derived phase (D2, D13): superseded or cancelled when the task was;
 * landed once a naming change landed and none is outstanding; no change when
 * the owner closed it without a landing; running while an execution of a
 * revision naming it runs; approved (naming another running execution it waits
 * for) while the current approved revision names it; in review while a revision
 * in review names it; planning otherwise.
 */
export function fixStatus(task: FixTaskFacts, facts: FixPlanFacts): FixStatus {
  const { landings, outstanding } = fixLandings(task.taskId, facts)
  const status = (phase: FixPhase, revision: number | null = null, executionId: string | null = null): FixStatus =>
    ({ phase, revision, executionId, landings, outstanding })
  if (task.status === 'cancelled') return status(task.superseded ? 'superseded' : 'cancelled')
  if (landings.length > 0 && outstanding.length === 0) return status('landed')
  if (task.status === 'done') return status(landings.length > 0 ? 'landed' : 'no-change')
  const names = (revision: number) => {
    const found = facts.revisions.find(entry => entry.revision === revision)
    return found !== undefined && namingChanges(found.content, task.taskId).length > 0
  }
  const running = facts.executions.filter(execution => execution.state === 'running')
  const landing = running.find(execution => names(execution.revision))
  if (landing !== undefined) return status('running', landing.revision, landing.id)
  if (facts.currentApprovedRevision !== null && names(facts.currentApprovedRevision)) {
    return status('approved', facts.currentApprovedRevision, running[0]?.id ?? null)
  }
  const inReview = facts.revisions.filter(entry => entry.status === 'in_review' && names(entry.revision)).at(-1)
  if (inReview !== undefined) return status('in-review', inReview.revision)
  return status('planning')
}

/**
 * M2 (D12): `n` counts the `answer` and `own-call` decisions an agent of the
 * card's addressed group made; `k` counts those a later override superseded.
 */
export function overrideCounts(cards: ReadonlyArray<{ card: Pick<DecisionCard, 'addressedGroup'>; decisions: readonly PlanDecision[] }>): { overridden: number; total: number } {
  let total = 0
  let overridden = 0
  for (const { card, decisions } of cards) {
    for (const decision of decisions) {
      if (decision.kind === 'override' || decision.decidedBy.kind !== 'agent') continue
      if (card.addressedGroup === null || decision.decidedBy.group !== card.addressedGroup) continue
      total += 1
      if (decisions.some(later => later.kind === 'override' && later.seq > decision.seq)) overridden += 1
    }
  }
  return { overridden, total }
}

/** One landed forward fix's M4 duration (D12). */
export interface FixDuration {
  decisionId: string
  overriddenAt: string
  landedAt: string
  durationMs: number
  /** A landing among them was not tree-verified. */
  unverified: boolean
}

/** M4 (D12): per landed fix, override to the newest naming landing, flagged when any landing is unverified. */
export function fixDurations(fixes: ReadonlyArray<{ decisionId: string; overriddenAt: string; status: FixStatus }>): FixDuration[] {
  const durations: FixDuration[] = []
  for (const fix of fixes) {
    if (fix.status.phase !== 'landed' || fix.status.landings.length === 0) continue
    const landedAt = fix.status.landings.map(landing => landing.landedAt).sort().at(-1)!
    durations.push({
      decisionId: fix.decisionId,
      overriddenAt: fix.overriddenAt,
      landedAt,
      durationMs: Date.parse(landedAt) - Date.parse(fix.overriddenAt),
      unverified: fix.status.landings.some(landing => !landing.treeVerified),
    })
  }
  return durations
}

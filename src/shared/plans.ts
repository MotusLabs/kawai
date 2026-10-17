// SDK-free durable plan records (durable-plans design D2/D4/D8/D10) shared
// by server and client. A revision's content is the structured template:
// intent, a claimed strategy alignment, the ordered OpenSpec changes with
// their dependencies, groups, and checks, plan-wide acceptance and extra
// checks, the landing mode, and the roles that execute the plan. The check
// floor is Kawai's fixed policy (`PLAN_CHECK_FLOOR`), never content: no field
// can remove it, and normalization drops anything that is not template.
// Canonical serialization reuses `canonicalJson`; the SHA-256 digest is
// server-side (`src/server/plans/planHash.ts`), as for strategies, because
// the browser bundle never computes a hash. Structural checks live in
// `planChecks.ts`; progress, display state, and the diff summary are the
// pure read-time derivations below.
import { canonicalJson } from './productStrategy'

/** The mandatory check floor (D4, contract C7). Reserved names: no extra check may reuse one. */
export const PLAN_CHECK_FLOOR = ['lint', 'typecheck', 'unit-tests', 'ci-e2e', 'review'] as const
export type PlanFloorCheck = (typeof PLAN_CHECK_FLOOR)[number]

export const PLAN_FLOOR_LABELS: Record<PlanFloorCheck, string> = {
  lint: 'Lint',
  typecheck: 'Typecheck',
  'unit-tests': 'Unit tests',
  'ci-e2e': 'CI end-to-end',
  review: 'Clean reviewer verdict',
}

export type PlanLifecycle = 'open' | 'completed' | 'cancelled'
export const PLAN_LIFECYCLES: readonly PlanLifecycle[] = ['open', 'completed', 'cancelled']

export type PlanRevisionStatus = 'in_review' | 'approved' | 'superseded' | 'withdrawn'
export const PLAN_REVISION_STATUSES: readonly PlanRevisionStatus[] = ['in_review', 'approved', 'superseded', 'withdrawn']

/** Displayed state (D8), derived at read time — never stored. */
export type PlanDisplayState = 'draft' | 'ready' | 'in-progress' | 'completed' | 'cancelled'

/** Who authored or acted: the human (the owner, through the UI) or an agent session. */
export type PlanActor = { kind: 'human'; sessionId: null } | { kind: 'agent'; sessionId: string }

export interface PlanCheck {
  name: string
  description: string
  /** The command that runs it, where one exists. */
  command: string | null
}

export interface PlanChange {
  /** OpenSpec change name, kebab-case. */
  change: string
  /** Other changes of this plan. */
  dependsOn: string[]
  /** Implementing group. */
  group: string | null
  /** Overrides the plan's review group. */
  reviewGroup: string | null
  acceptance: string[]
  extraChecks: PlanCheck[]
  /** Pins for the implementer. */
  guidance: string
}

export type PlanLanding = { mode: 'direct' } | { mode: 'integration-branch'; branch: string }

export interface PlanRole {
  group: string
  /** Provider profiles in preference order; [] = the group's own routing. */
  profiles: string[]
}

/** Contract C1: the plan template every later Wave C change reads. */
export interface PlanContent {
  goal: string
  successCriteria: string[]
  nonGoals: string[]
  approach: string
  /** The claimed contribution; refs into the pinned strategy (claimed, not assessed). */
  alignment: { statement: string; refs: string[] }
  /** Ordered; order = preference, dependencies are the hard constraint. */
  changes: PlanChange[]
  /** Plan-wide, beyond each change's own OpenSpec acceptance. */
  acceptanceRules: string[]
  /** Plan-wide, above the floor. */
  extraChecks: PlanCheck[]
  landing: PlanLanding
  roles: PlanRole[]
  /** Gives the floor's reviewer verdict unless a change overrides it. */
  reviewGroup: string | null
}

/** Contract C2: the strategy a revision was submitted against; null = Alignment unassessed. */
export interface PlanStrategyPin {
  strategyId: string
  revision: number
  hash: string
}

export interface Plan {
  id: string
  teamId: string
  title: string
  lifecycle: PlanLifecycle
  currentApprovedRevision: number | null
  creator: PlanActor
  createdAt: string
  updatedAt: string
}

export interface PlanRevision {
  revision: number
  status: PlanRevisionStatus
  content: PlanContent
  /** SHA-256 over canonical `{content, pin}`. */
  contentHash: string
  pin: PlanStrategyPin | null
  author: PlanActor
  createdAt: string
}

export interface PlanDraft {
  draftId: string
  /** The approved revision current when the draft was first saved; null = none. */
  baseRevision: number | null
  author: PlanActor
  content: PlanContent
  /** SHA-256 over canonical content only. */
  contentHash: string
  updatedAt: string
}

/** Contract C6: append-only; later changes add kinds and never redefine these. */
export type PlanEventKind =
  | 'created' | 'submitted' | 'approved' | 'withdrawn' | 'draft-discarded' | 'completed' | 'cancelled' | 'reopened'
  | 'execution-started' | 'execution-stopped' | 'change-retried'

export interface PlanEvent {
  id: string
  kind: PlanEventKind | string
  revision: number | null
  contentHash: string | null
  actor: PlanActor | { kind: 'system'; sessionId: null }
  reason: string | null
  commandId: string | null
  /** The draft a discard removed. */
  draftId: string | null
  createdAt: string
}

/** A task linked to a plan change, as progress reads it (D10). */
export interface PlanLinkedTask {
  id: string
  title: string
  status: 'open' | 'active' | 'blocked' | 'done' | 'cancelled'
  planChange: string
}

export type PlanChangeStatus = 'not-started' | 'in-progress' | 'done' | 'cancelled'

export interface PlanChangeProgress {
  change: string
  status: PlanChangeStatus
  tasks: PlanLinkedTask[]
  /** Dependencies that are not `done` (a cancelled one keeps waiting). */
  waitsOn: string[]
}

export interface PlanProgress {
  changes: PlanChangeProgress[]
  /** Linked tasks whose change the current revision no longer lists. */
  outsideRevision: PlanLinkedTask[]
}

export interface PlanSummary extends Plan {
  state: PlanDisplayState
  /** The approved revision's pin; null when unpinned or not yet approved. */
  pin: PlanStrategyPin | null
  linkedTaskCount: number
}

/** One execution of a plan, as `plan_get` shows it (plan-execution D18): state, outcome, and per-change state. */
export interface PlanExecutionSummary {
  id: string
  revision: number
  state: 'running' | 'finished'
  outcome: 'completed' | 'stopped' | null
  stopReason: string | null
  startedAt: string
  finishedAt: string | null
  changes: Array<{ change: string; state: string; step: string | null; stopReason: string | null; fixRounds: number }>
}

export interface PlanDetail {
  plan: PlanSummary
  /** Oldest first. */
  revisions: PlanRevision[]
  /** Oldest first by update time. */
  drafts: PlanDraft[]
  /** Oldest first. */
  events: PlanEvent[]
  /** Every task linked to the plan, oldest first. */
  linkedTasks: PlanLinkedTask[]
  /** The plan's executions, newest first (plan-execution D18); absent when the plans module runs without executions. */
  executions?: PlanExecutionSummary[]
  /** Progress over the current approved revision; null without one. */
  progress: PlanProgress | null
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const name = (value: unknown): string => str(value).trim()
const optName = (value: unknown): string | null => name(value) || null
const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean) : []
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) : []
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

function normalizeChecks(value: unknown): PlanCheck[] {
  return records(value).map(entry => ({
    name: name(entry.name),
    description: str(entry.description),
    command: optName(entry.command),
  }))
}

/**
 * Fill raw input into the full template (D2): unknown fields are dropped and
 * missing ones defaulted, so a field meant to switch the floor off can never
 * survive a save. A new draft lands as direct landing with empty sections.
 */
export function normalizePlanContent(input: unknown): PlanContent {
  const source = record(input)
  const alignment = record(source.alignment)
  const landing = record(source.landing)
  return {
    goal: str(source.goal),
    successCriteria: strList(source.successCriteria),
    nonGoals: strList(source.nonGoals),
    approach: str(source.approach),
    alignment: { statement: str(alignment.statement), refs: strList(alignment.refs) },
    changes: records(source.changes).map(entry => ({
      change: name(entry.change),
      dependsOn: strList(entry.dependsOn),
      group: optName(entry.group),
      reviewGroup: optName(entry.reviewGroup),
      acceptance: strList(entry.acceptance),
      extraChecks: normalizeChecks(entry.extraChecks),
      guidance: str(entry.guidance),
    })),
    acceptanceRules: strList(source.acceptanceRules),
    extraChecks: normalizeChecks(source.extraChecks),
    landing: landing.mode === 'integration-branch' ? { mode: 'integration-branch', branch: name(landing.branch) } : { mode: 'direct' },
    roles: records(source.roles).map(entry => ({ group: name(entry.group), profiles: strList(entry.profiles) })),
    reviewGroup: optName(source.reviewGroup),
  }
}

/** The canonical draft-hash input (D2): content only. */
export function planDraftHashInput(content: PlanContent): string {
  return canonicalJson(content)
}

/** The canonical revision-hash input (D2): content and pin, so approving a hash binds the pin too. */
export function planRevisionHashInput(content: PlanContent, pin: PlanStrategyPin | null): string {
  return canonicalJson({ content, pin })
}

/** Whether two pins are the same strategy revision and hash; both empty counts as equal (D7). */
export function samePin(a: PlanStrategyPin | null, b: PlanStrategyPin | null): boolean {
  if (!a || !b) return a === b
  return a.strategyId === b.strategyId && a.revision === b.revision && a.hash === b.hash
}

/** The change's effective review group: its own, else the plan's. */
export function effectiveReviewGroup(content: PlanContent, change: PlanChange): string | null {
  return change.reviewGroup ?? content.reviewGroup
}

/** D8: Draft, Ready, In progress while open; otherwise the closed lifecycle. */
export function planDisplayState(plan: Pick<Plan, 'lifecycle' | 'currentApprovedRevision'>, linkedTaskCount: number): PlanDisplayState {
  if (plan.lifecycle !== 'open') return plan.lifecycle
  if (plan.currentApprovedRevision === null) return 'draft'
  return linkedTaskCount > 0 ? 'in-progress' : 'ready'
}

export const PLAN_STATE_LABELS: Record<PlanDisplayState, string> = {
  draft: 'Draft',
  ready: 'Ready',
  'in-progress': 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

function changeStatus(tasks: PlanLinkedTask[]): PlanChangeStatus {
  if (tasks.length === 0) return 'not-started'
  if (tasks.some(task => task.status === 'open' || task.status === 'active' || task.status === 'blocked')) return 'in-progress'
  return tasks.some(task => task.status === 'done') ? 'done' : 'cancelled'
}

/**
 * Per-change progress (D10, contract C5), pure and never stored: each change
 * of `content` in order with its linked tasks, status, and the dependencies
 * that are not done. Tasks naming a change the content no longer lists are
 * returned as `outsideRevision`, links unchanged.
 */
export function planProgress(content: PlanContent, linkedTasks: readonly PlanLinkedTask[]): PlanProgress {
  const names = new Set(content.changes.map(change => change.change))
  const statuses = new Map<string, PlanChangeStatus>()
  const changes = content.changes.map(change => {
    const tasks = linkedTasks.filter(task => task.planChange === change.change)
    const status = changeStatus(tasks)
    statuses.set(change.change, status)
    return { change: change.change, status, tasks, waitsOn: [] as string[] }
  })
  content.changes.forEach((change, index) => {
    changes[index]!.waitsOn = change.dependsOn.filter(dependency => statuses.get(dependency) !== 'done')
  })
  return { changes, outsideRevision: linkedTasks.filter(task => !names.has(task.planChange)) }
}

export interface PlanDiffSummary {
  /** Labels of the template sections whose content differs. */
  sections: string[]
  addedChanges: string[]
  removedChanges: string[]
  /** Whether the changes both revisions share appear in a different order. */
  reordered: boolean
  /** Whether the strategy pin differs. */
  pinChanged: boolean
}

export const PLAN_SECTION_LABELS: Record<keyof PlanContent, string> = {
  goal: 'Goal',
  successCriteria: 'Success criteria',
  nonGoals: 'Non-goals',
  approach: 'Approach',
  alignment: 'Alignment',
  changes: 'Changes',
  acceptanceRules: 'Acceptance rules',
  extraChecks: 'Extra checks',
  landing: 'Landing',
  roles: 'Roles',
  reviewGroup: 'Review group',
}

/** D12's diff summary of a revision against the approved one (null base = everything is new). */
export function planDiffSummary(
  base: { content: PlanContent; pin: PlanStrategyPin | null } | null,
  next: { content: PlanContent; pin: PlanStrategyPin | null },
): PlanDiffSummary {
  const baseContent = base?.content ?? normalizePlanContent({})
  const sections = (Object.keys(PLAN_SECTION_LABELS) as Array<keyof PlanContent>)
    .filter(key => canonicalJson(baseContent[key]) !== canonicalJson(next.content[key]))
    .map(key => PLAN_SECTION_LABELS[key])
  const before = baseContent.changes.map(change => change.change)
  const after = next.content.changes.map(change => change.change)
  const shared = (list: string[], other: string[]) => list.filter(entry => other.includes(entry))
  return {
    sections,
    addedChanges: after.filter(entry => !before.includes(entry)),
    removedChanges: before.filter(entry => !after.includes(entry)),
    reordered: shared(before, after).join('\0') !== shared(after, before).join('\0'),
    pinChanged: base !== null && !samePin(base.pin, next.pin),
  }
}

// Apply's precondition context (plan-revision-apply D3): built from the
// prepare phase's reads (the validation standing, the role facts, the
// changes-on-base blob diffs) plus fresh rows — the plan, the execution,
// both revisions, the delta, live merges, and claimed changes — so the same
// builder serves the preview and, inside the transaction, the Apply itself.
// The delta's landed set is the plan's landing facts plus the execution's
// landed change rows; a change is provisioned when its row has a task (D2).
import type { TeamIdentity } from '../../team/teamIdentity'
import type { PlanContent, PlanRevision } from '../../../shared/plans'
import type { ImpactGate } from '../../../shared/strategyImpact'
import type { RevisionDelta } from '../../../shared/planRevisionControl'
import type { ValidationStanding } from '../validation/validationStanding'
import type { ExecutionStore } from '../execution/executionStore'
import type { ExecutionRow } from '../execution/executionRows'
import type { PlanStore } from '../planStore'
import type { StartRoleFact } from '../execution/startPreconditions'
import { implementTaskText } from '../execution/taskText'
import { revisionDelta } from './revisionDelta'
import { deltaOf, neededChoices, type ApplyCheckContext, type ApplyRequest } from './applyPreconditions'

export interface ApplyContextDeps {
  store: ExecutionStore
  plansStore: PlanStore
  validation: { standing: (prepared: unknown) => unknown }
  impact: { gate: (planId: string, revision: number) => ImpactGate | null }
}

/** The prepare phase's reads (D3), async and writing nothing. */
export interface ApplyReads {
  /** `ValidationService.prepareStanding`'s result, or null when no validation is wired. */
  prepared: unknown
  /** The role facts of every target change (Start's read). */
  roles: StartRoleFact[]
  /** The blob diffs of the compared changes (added, adapted, restarted). */
  baseDiffs: Array<{ change: string; files: string[] }>
}

/** The changes the delta treats as landed: the plan's landing facts and the execution's landed rows. */
export function landedOf(store: ExecutionStore, execution: ExecutionRow): Set<string> {
  const landed = new Set(store.landings(execution.planId).map(landing => landing.change))
  for (const row of store.changes(execution.id)) if (row.state === 'landed') landed.add(row.change)
  return landed
}

/** The changes with a task (D2: a changed one needs a choice). */
export function provisionedOf(store: ExecutionStore, execution: ExecutionRow): Set<string> {
  return new Set(store.changes(execution.id).filter(row => row.taskId !== null).map(row => row.change))
}

/** The execution's current revision content and its delta to the target; null when either is missing. */
export function deltaFor(deps: ApplyContextDeps, execution: ExecutionRow, target: PlanRevision | null): { running: PlanContent | null; delta: RevisionDelta | null } {
  const running = deps.plansStore.revision(execution.planId, execution.revision)?.content ?? null
  if (running === null || target === null) return { running, delta: null }
  return { running, delta: revisionDelta(running, target.content, landedOf(deps.store, execution), provisionedOf(deps.store, execution)) }
}

/** The generated Adapt text of each needed change (D5): the task text under the target revision. */
export function generatedAdaptations(target: PlanRevision | null, delta: RevisionDelta | null): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const change of neededChoices(delta)) {
    const entry = target?.content.changes.find(candidate => candidate.change === change)
    if (entry && target) texts[change] = implementTaskText(entry, target.content).direction
  }
  return texts
}

/** The precondition context over fresh rows and the prepare phase's reads. */
export function applyContext(deps: ApplyContextDeps, team: TeamIdentity, execution: ExecutionRow, request: ApplyRequest, reads: ApplyReads): ApplyCheckContext {
  const plan = deps.plansStore.get(execution.planId)!
  const target = deps.plansStore.revision(execution.planId, request.revision)
  const { running, delta } = deltaFor(deps, execution, target)
  const prepared = reads.prepared
  const standing = (prepared !== null && prepared !== undefined ? deps.validation.standing(prepared) : null) as ValidationStanding | null
  const touched = new Set([...deltaOf(delta, 'changed'), ...deltaOf(delta, 'removed')].map(change => change.change))
  const liveMerges = [...new Set(deps.store.effectsOf(execution.id)
    .filter(effect => effect.change !== null && touched.has(effect.change))
    .filter(effect => (effect.kind === 'merge' || effect.kind === 'fast-forward') && (effect.state === 'pending' || effect.state === 'running' || effect.state === 'unknown'))
    .map(effect => effect.change!))].sort()
  const added = new Set(deltaOf(delta, 'added').map(change => change.change))
  const landed = landedOf(deps.store, execution)
  const unlanded = new Set((target?.content.changes ?? []).map(entry => entry.change).filter(change => !landed.has(change)))
  return {
    plan, execution, request, target, running, delta,
    validation: standing,
    impactGate: target === null ? null : deps.impact.gate(execution.planId, request.revision),
    liveMerges,
    claimedChanges: deps.store.ownedChanges(team.teamId)
      .filter(row => row.executionId !== execution.id && added.has(row.change))
      .map(row => ({ change: row.change, executionId: row.executionId })),
    baseDiffs: reads.baseDiffs,
    roles: reads.roles.filter(role => unlanded.has(role.change)),
  }
}

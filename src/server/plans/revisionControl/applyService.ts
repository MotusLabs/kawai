// ApplyService (plan-revision-apply D1, D3, D5): the human applies the plan's
// newer approved revision to its running execution. It refuses a non-human
// caller before any read (AK1). `preview` runs the prepare phase's reads and
// the precondition list over fresh rows and writes nothing; it takes no
// command id, so a stale preview can only be refused by the Apply, which
// recomputes everything (D5).
import type { TeamIdentity } from '../../team/teamIdentity'
import type { ApplyPreview } from '../../../shared/planRevisionControl'
import type { PlanRevision } from '../../../shared/plans'
import type { ExecutionCaller } from '../execution/ExecutionService'
import type { ExecutionRow } from '../execution/executionRows'
import { gatherStart, type StartGatherDeps } from '../execution/startGather'
import { applyContext, deltaFor, generatedAdaptations, type ApplyContextDeps, type ApplyReads } from './applyContext'
import { applyStanding, baseComparedChanges, neededChoices } from './applyPreconditions'

export interface ApplyServiceDeps extends ApplyContextDeps, StartGatherDeps {
  validation: ApplyContextDeps['validation'] & {
    prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
  }
}

export type ApplyPreviewOutcome =
  | { ok: true; preview: ApplyPreview }
  | { ok: false; reason: 'forbidden' | 'not-found'; message: string }

export class ApplyService {
  constructor(readonly deps: ApplyServiceDeps) {}

  /** The execution of the caller's team, or null (another team's id reads as not found). */
  protected executionFor(team: TeamIdentity, executionId: string): ExecutionRow | null {
    const execution = this.deps.store.execution(executionId)
    return execution !== null && execution.teamId === team.teamId ? execution : null
  }

  /** The prepare phase (D3): validation standing, the target's role facts, and the compared changes' blob diffs. */
  protected async prepareReads(team: TeamIdentity, execution: ExecutionRow, target: PlanRevision | null, choices: Record<string, string>): Promise<ApplyReads> {
    const { delta } = deltaFor(this.deps, execution, target)
    const gather = await gatherStart(this.deps, team, execution.planId, target, baseComparedChanges(delta, choices))
    const prepared = target === null ? null : await this.deps.validation.prepareStanding(execution.planId, target.revision)
    return { prepared, roles: gather.roles, baseDiffs: gather.baseDiffs }
  }

  /** The Apply dialog's reads (D5): the delta, the needed choices, the generated Adapt texts, and every entry's standing. */
  async preview(caller: ExecutionCaller, input: { executionId: string; revision: number; choices?: Record<string, string> }): Promise<ApplyPreviewOutcome> {
    if (caller.kind !== 'human') {
      return { ok: false, reason: 'forbidden', message: 'Only the human can apply a revision, from the Plans view. No agent tool can.' }
    }
    const execution = this.executionFor(caller.team, input.executionId)
    if (execution === null) return { ok: false, reason: 'not-found', message: `Execution not found in this team: ${input.executionId}` }
    const target = this.deps.plansStore.revision(execution.planId, input.revision)
    const choices = input.choices ?? {}
    const reads = await this.prepareReads(caller.team, execution, target, choices)
    const fresh = this.deps.store.execution(execution.id) ?? execution
    const ctx = applyContext(this.deps, caller.team, fresh, {
      executionId: fresh.id, expectedRevision: fresh.revision, revision: input.revision,
      contentHash: target?.contentHash ?? '', choices, rationale: '',
    }, reads)
    return {
      ok: true,
      preview: {
        executionId: fresh.id, fromRevision: fresh.revision, revision: input.revision,
        contentHash: target?.contentHash ?? null, delta: ctx.delta,
        needed: neededChoices(ctx.delta), adaptations: generatedAdaptations(target, ctx.delta),
        standing: applyStanding(ctx),
      },
    }
  }
}

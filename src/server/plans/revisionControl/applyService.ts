// ApplyService (plan-revision-apply D1, D3, D5): the human applies the plan's
// newer approved revision to its running execution. Both commands refuse a
// non-human caller before any read (AK1). `preview` runs the prepare phase's
// reads and the precondition list over fresh rows and writes nothing; it
// takes no command id, so a stale preview can only be refused by the Apply,
// which recomputes everything (D5). `apply`:
// 1. replays first (DC3): a recorded `revision-applied` event under the
//    command id returns its result, rebuilt from the history row recorded
//    under that id, before any read — or refuses a differing payload (AK3);
// 2. the prepare phase, async and writing nothing: standing, group files,
//    the base comparison, the removed changes' prepared task cancels, and
//    the re-issued changes' branch heads;
// 3. one synchronous transaction through `recordRevisionControlEvent`: the
//    preconditions over fresh rows, the per-change writes, the history row,
//    the advanced revision columns, and the event last;
// 4. after a real commit, the executor wake (the plan's announce re-pushes
//    its detail). A prepared cancel gone stale rolls everything back and
//    prepares again, at most three times as Stop does (AK6).
import type { TeamIdentity } from '../../team/teamIdentity'
import type { PreparedTaskStatus } from '../../team/taskStatusPrepared'
import { StaleTaskStatus } from '../../team/taskStatusPrepared'
import type { ApplyPreview, ExecutionRevisionView, RevisionDelta } from '../../../shared/planRevisionControl'
import type { PlanRevision } from '../../../shared/plans'
import type { ExecutionCaller } from '../execution/ExecutionService'
import type { ExecutionRow } from '../execution/executionRows'
import { gatherStart, type StartGatherDeps } from '../execution/startGather'
import { advanceExecutionRevision } from '../execution/executionApplyStore'
import type { ValidationStanding } from '../validation/validationStanding'
import { PlanRefusal, payloadDifference, type PlanRefusalReason } from '../planCommands'
import type { PreconditionFailure } from '../planPreconditions'
import type { PlanService } from '../PlanService'
import { applyContext, deltaFor, generatedAdaptations, type ApplyContextDeps, type ApplyReads } from './applyContext'
import { applyStanding, baseComparedChanges, deltaOf, evaluateApplyPreconditions, neededChoices, type ApplyRequest } from './applyPreconditions'
import { applyWrites, type ApplyWritesDeps } from './applyWrites'
import { revisionControlCommandPayload, type RevisionControlEventInput } from './events'
import { ExecutionRevisionConflict, type ExecutionRevisionStore } from './executionRevisionStore'
import type { AdaptHeadFacts } from './pauseResolve'

export interface ApplyServiceDeps extends ApplyContextDeps, StartGatherDeps {
  validation: ApplyContextDeps['validation'] & {
    prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
  }
  plans: PlanService
  executionRevisions: ExecutionRevisionStore
  /** The team services Apply writes through; without them Apply refuses (preview still reads). */
  writes?: ApplyWritesDeps
  /** origin's branch head of a re-issued change, read before the transaction; null when unknown. */
  adaptHead?: (executionId: string, change: string) => Promise<AdaptHeadFacts | null>
  /** Woken after an Apply commits (the executor); never on a replay or refusal. */
  wake?: (teamId: string) => void
}

export interface ApplyInput extends ApplyRequest {
  commandId: string
}

export type ApplyPreviewOutcome =
  | { ok: true; preview: ApplyPreview }
  | { ok: false; reason: 'forbidden' | 'not-found'; message: string }

export type ApplyOutcome =
  | { ok: true; replayed: boolean; executionId: string; applied: ExecutionRevisionView }
  | { ok: false; reason: PlanRefusalReason; message: string; failures?: PreconditionFailure[] }

/** D3 "Stale preparation": at most this many prepares, as Stop (`STOP_ATTEMPTS`). */
const APPLY_ATTEMPTS = 3

const FORBIDDEN = 'Only the human can apply a revision, from the Plans view. No agent tool can.'

export class ApplyService {
  constructor(readonly deps: ApplyServiceDeps) {}

  /** The execution of the caller's team, or null (another team's id reads as not found). */
  protected executionFor(team: TeamIdentity, executionId: string): ExecutionRow | null {
    const execution = this.deps.store.execution(executionId)
    return execution !== null && execution.teamId === team.teamId ? execution : null
  }

  /** The prepare phase's reads (D3): validation standing, the target's role facts, and the compared changes' blob diffs. */
  protected async prepareReads(team: TeamIdentity, execution: ExecutionRow, target: PlanRevision | null, choices: Record<string, string>): Promise<ApplyReads> {
    const { delta } = deltaFor(this.deps, execution, target)
    const gather = await gatherStart(this.deps, team, execution.planId, target, baseComparedChanges(delta, choices))
    const prepared = target === null ? null : await this.deps.validation.prepareStanding(execution.planId, target.revision)
    return { prepared, roles: gather.roles, baseDiffs: gather.baseDiffs }
  }

  /** The Apply dialog's reads (D5): the delta, the needed choices, the generated Adapt texts, and every entry's standing. */
  async preview(caller: ExecutionCaller, input: { executionId: string; revision: number; choices?: Record<string, string> }): Promise<ApplyPreviewOutcome> {
    if (caller.kind !== 'human') return { ok: false, reason: 'forbidden', message: FORBIDDEN }
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

  /** Apply the plan's current approved revision to the running execution (D3). */
  async apply(caller: ExecutionCaller, input: ApplyInput): Promise<ApplyOutcome> {
    if (caller.kind !== 'human') return { ok: false, reason: 'forbidden', message: FORBIDDEN }
    const execution = this.executionFor(caller.team, input.executionId)
    if (execution === null) return { ok: false, reason: 'not-found', message: `Execution not found in this team: ${input.executionId}` }
    const commandId = typeof input.commandId === 'string' ? input.commandId.trim() : ''
    if (!commandId) return { ok: false, reason: 'invalid', message: 'Apply needs a stable command id so a resend replays instead of repeating.' }
    if (typeof input.rationale !== 'string' || input.rationale.trim() === '') {
      return { ok: false, reason: 'invalid', message: 'Apply needs a rationale: the developers of adapted changes read it with the new revision.' }
    }
    const event: RevisionControlEventInput = {
      kind: 'revision-applied', commandId, executionId: execution.id, expectedRevision: input.expectedRevision,
      revision: input.revision, contentHash: input.contentHash, choices: input.choices ?? {},
      adaptations: input.adaptations ?? {}, rationale: input.rationale,
    }
    const replay = this.replay(execution, commandId, event)
    if (replay !== null) return replay
    if (this.deps.writes === undefined) return { ok: false, reason: 'state', message: 'Apply is not available on this server: its team services are not composed.' }
    let stale: string | null = null
    for (let attempt = 1; attempt <= APPLY_ATTEMPTS; attempt++) {
      const target = this.deps.plansStore.revision(execution.planId, input.revision)
      const reads = await this.prepareReads(caller.team, execution, target, event.choices)
      const current = this.deps.store.execution(execution.id) ?? execution
      const { delta } = deltaFor(this.deps, current, target)
      const cancels = await this.prepareCancels(caller.team, current, delta, input)
      if (!cancels.ok) return cancels
      const heads = await this.readHeads(current, delta, event.choices)
      try {
        const outcome = this.deps.plans.recordRevisionControlEvent(execution.planId, event,
          () => this.commit(caller.team, execution.id, { ...input, choices: event.choices }, commandId, event, reads, cancels.prepared, heads))
        if (!outcome.ok) return { ok: false, reason: outcome.reason, message: outcome.message, ...(outcome.failures ? { failures: outcome.failures } : {}) }
        // AK5: a concurrent twin committed first; its row answers this one.
        if (outcome.replayed) return this.replay(execution, commandId, event) ?? { ok: false, reason: 'state', message: `The recorded Apply ${commandId} left no revision row.` }
        this.deps.wake?.(caller.team.teamId)
        return { ok: true, replayed: false, executionId: execution.id, applied: this.view(execution.id, outcome.result!.seq) }
      } catch (error) {
        if (!(error instanceof StaleTaskStatus)) throw error
        stale = error.taskId
      }
    }
    return { ok: false, reason: 'state', message: `Task ${stale} kept changing status while Apply prepared its cancel (${APPLY_ATTEMPTS} attempts); nothing was applied. Apply again.` }
  }

  /** DC3: the result recorded under this command id, or a payload refusal; null when the id is new. */
  private replay(execution: ExecutionRow, commandId: string, event: RevisionControlEventInput): ApplyOutcome | null {
    const recorded = this.deps.plansStore.eventByCommand(execution.planId, commandId)
    if (recorded === null) return null
    const field = payloadDifference(recorded.payload, revisionControlCommandPayload(event))
    if (field !== null) {
      return { ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different ${field}; the recorded ${recorded.event.kind} event stands and nothing was written.` }
    }
    const row = this.deps.executionRevisions.byCommand(execution.id, commandId)
    if (row === null) return { ok: false, reason: 'state', message: `The recorded Apply ${commandId} left no revision row.` }
    return { ok: true, replayed: true, executionId: execution.id, applied: this.view(execution.id, row.seq) }
  }

  /** One history row with its publication rows. */
  private view(executionId: string, seq: number): ExecutionRevisionView {
    const row = this.deps.executionRevisions.revision(executionId, seq)!
    return { seq: row.seq, revision: row.revision, contentHash: row.contentHash, rationale: row.rationale, appliedAt: row.appliedAt, changes: this.deps.executionRevisions.publications(executionId, seq) }
  }

  /** The removed, unlanded changes' open tasks, each prepared for Kawai's cancel (D3, as Stop). */
  private async prepareCancels(team: TeamIdentity, execution: ExecutionRow, delta: RevisionDelta | null, input: ApplyInput): Promise<
    { ok: true; prepared: Map<string, PreparedTaskStatus> } | { ok: false; reason: 'state'; message: string }
  > {
    const prepared = new Map<string, PreparedTaskStatus>()
    const tasks = this.deps.writes!.tasks
    const system = { kind: 'system' as const, team, origin: { kind: 'execution' as const, executionId: execution.id } }
    for (const entry of deltaOf(delta, 'removed')) {
      const row = this.deps.store.change(execution.id, entry.change)
      if (row === null || row.taskId === null || row.state === 'landed' || row.state === 'cancelled') continue
      const status = tasks.store.get(row.taskId)?.status
      if (status === undefined || status === 'done' || status === 'cancelled') continue
      try {
        prepared.set(row.taskId, await tasks.prepareStatus(system, row.taskId, 'cancelled', `Removed from the plan by revision ${input.revision}: ${input.rationale.trim()}`))
      } catch (error) {
        return { ok: false, reason: 'state', message: `The task ${row.taskId} of ${entry.change} cannot be cancelled: ${String(error instanceof Error ? error.message : error)}` }
      }
    }
    return { ok: true, prepared }
  }

  /** origin's branch head of each change chosen adapt or restart, read before the transaction. */
  private async readHeads(execution: ExecutionRow, delta: RevisionDelta | null, choices: Record<string, string>): Promise<Map<string, AdaptHeadFacts | null>> {
    const heads = new Map<string, AdaptHeadFacts | null>()
    if (this.deps.adaptHead === undefined) return heads
    for (const entry of deltaOf(delta, 'changed')) {
      if (choices[entry.change] === 'adapt' || choices[entry.change] === 'restart') heads.set(entry.change, await this.deps.adaptHead(execution.id, entry.change))
    }
    return heads
  }

  /** The transaction body: the preconditions over fresh rows, the writes, the history row, and the advanced revision. */
  private commit(team: TeamIdentity, executionId: string, input: ApplyInput, commandId: string, event: RevisionControlEventInput, reads: ApplyReads,
    prepared: Map<string, PreparedTaskStatus>, heads: Map<string, AdaptHeadFacts | null>): { seq: number } {
    const execution = this.deps.store.execution(executionId)!
    const ctx = applyContext(this.deps, team, execution, input, reads)
    const failures = evaluateApplyPreconditions(ctx)
    if (failures.length > 0) {
      throw new PlanRefusal('precondition', `Apply refused: ${failures.map(failure => `${failure.name}: ${failure.message}`).join(' ')}`, failures)
    }
    const target = ctx.target!
    const standing = ctx.validation as ValidationStanding | null
    const report = standing !== null && 'report' in standing ? standing.report : null
    const next = { revision: target.revision, contentHash: target.contentHash, reportId: report?.id ?? execution.reportId, inputHash: report?.inputHash ?? execution.inputHash }
    const generated = generatedAdaptations(target, ctx.delta)
    const adaptations = Object.fromEntries(Object.entries(input.choices).filter(([, choice]) => choice === 'adapt')
      .map(([change]) => [change, input.adaptations?.[change]?.trim() || generated[change]!]))
    const publications = applyWrites(this.deps.writes!, {
      team, execution, target, delta: ctx.delta!, commandId, choices: input.choices, adaptations,
      rationale: input.rationale.trim(), next, heads, prepared,
    })
    const seq = (this.deps.executionRevisions.newest(executionId)?.seq ?? 0) + 1
    try {
      this.deps.executionRevisions.recordAt(seq, {
        executionId, revision: next.revision, contentHash: next.contentHash, reportId: next.reportId, inputHash: next.inputHash,
        rationale: input.rationale.trim(), commandId, payload: revisionControlCommandPayload(event), appliedAt: new Date().toISOString(),
      }, publications)
    } catch (error) {
      if (!(error instanceof ExecutionRevisionConflict)) throw error
      throw new PlanRefusal('precondition', error.message, [{ name: 'execution-revision-unchanged', message: error.message }])
    }
    if (!advanceExecutionRevision(this.deps.store.db, executionId, execution.revision, next)) {
      const message = `The execution's revision moved from ${execution.revision} while Apply ran; reload and apply again.`
      throw new PlanRefusal('precondition', message, [{ name: 'execution-revision-unchanged', message }])
    }
    return { seq }
  }
}

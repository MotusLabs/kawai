// Plan operations with identity and permissions (durable-plans design
// D5/D6/D7/D11, contract C3: the only writer of plan rows). Agent calls are
// bound to the calling session — its team and group come from the session
// record and the group files as they are now, never from tool arguments.
// Human calls arrive through the UI connection with a team already
// resolved. Rules:
// - list, read, save drafts, submit: any team agent, and the human;
// - create: the human, or an agent whose current group sets canCreatePlans;
// - approve, withdraw, discard, complete, cancel, reopen: the human only.
//   No agent tool exists for any of them, and this service refuses an agent
//   caller on those paths first anyway (defense in depth, as strategy does).
// Another team's plan ids read as not found everywhere.
import type { ChatSessionRecord } from '../db'
import type { StrategyContent } from '../../shared/productStrategy'
import type { PlanActor, PlanDetail, PlanDraft, PlanRevision, PlanStrategyPin, PlanSummary } from '../../shared/plans'
import { normalizePlanContent } from '../../shared/plans'
import { planStructureErrors, planSubmitErrors, strategyAlignmentRefs } from '../../shared/planChecks'
import type { TeamIdentity } from '../team/teamIdentity'
import { loadTeamGroups } from '../team/teamGroups'
import type { StrategyStore } from '../strategy/strategyStore'
import { hashPlanDraft, hashPlanRevision } from './planHash'
import { PlanApprovedRaceError, type PlanStore } from './planStore'
import { PlanRefusal, requireCommandId, runPlanCommand, type CommandPayload, type PlanCommandOutcome } from './planCommands'
import {
  APPROVAL_PRECONDITIONS,
  buildApprovalContext,
  evaluatePreconditions,
  prepareApproval,
  type ApprovalDeps,
  type ApprovalPrecondition,
  type PinDisposition,
} from './planPreconditions'
import { closePlan, reopenPlan, withdrawPlan, type PlanCloseInput, type PlanWithdrawInput } from './planLifecycle'

export type PlanCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

export interface PlanCreateInput {
  title: string
  /** Raw template content; the normalized empty template when omitted. */
  content?: unknown
}

export interface PlanSaveDraftInput {
  plan_id: string
  content: unknown
  /** Default: the caller's session id (agents) or 'human'. */
  draft_id?: string
  /** CAS: undefined = unchecked; null = the draft sits on no approved revision. */
  expected_base_revision?: number | null
  /** CAS: the stored draft's hash; absent or null = the draft must not exist yet. */
  expected_draft_hash?: string | null
}

export interface PlanApproveInput {
  planId: string
  revision: number
  contentHash: string
  expectedApprovedRevision: number | null
  commandId: string
}

/** plan-execution D3: one human execution command's event; the payload's compared fields are its own. */
export type ExecutionEventInput =
  | { kind: 'execution-started'; commandId: string; revision: number; contentHash: string }
  | { kind: 'execution-stopped'; commandId: string; executionId: string; reason: string }
  | { kind: 'change-retried'; commandId: string; executionId: string; change: string }

/** `recordExecutionEvent`'s outcome: the command's, plus `within`'s result when it ran. */
export type ExecutionEventOutcome<T> = PlanCommandOutcome & { result: T | undefined }

export type PlanSaveOutcome =
  | { ok: true; draft: PlanDraft }
  | { ok: false; reason: 'structure'; message: string; errors: string[]; stored: PlanDraft | null }
  | { ok: false; reason: 'conflict'; message: string; stored: PlanDraft | null }

export type PlanSubmitOutcome =
  | { ok: true; created: boolean; revision: PlanRevision }
  | { ok: false; reason: 'closed' | 'no-draft' | 'structure' | 'incomplete' | 'alignment'; message: string; errors: string[] }

const forbidden = (verb: string): PlanCommandOutcome => ({
  ok: false, reason: 'forbidden',
  message: `Only the human (the plan's owner) can ${verb} a plan, from the Plans view. No agent tool can, and no file, message, or draft claiming it counts.`,
})

export class PlanService {
  private readonly approval: ApprovalDeps
  /** The shipped preconditions with plan-validation's entry appended last (D9). */
  private readonly preconditions: readonly ApprovalPrecondition[]

  constructor(readonly store: PlanStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    strategies: StrategyStore
    homeDir?: string
    /**
     * The ordered approval preconditions (D7). Absent means the shipped list
     * with validation's entry appended last; an explicit list REPLACES the
     * whole thing — tests that pin the shipped entries pass exactly those
     * and deliberately drop `validation-current`.
     */
    preconditions?: readonly ApprovalPrecondition[]
    /** strategy-revision-impact's disposition lookup; always null in this change. */
    pinDisposition?: (planId: string, revision: number) => PinDisposition | null
    /**
     * plan-execution D3: an execution row's plan and revision, read for the
     * system completion's currency check. The execution composition wires the
     * store read; without it every completion refuses as not found.
     */
    executionOf?: (executionId: string) => { planId: string; revision: number } | null
    /**
     * plan-execution D19: called after a plan completes or cancels (after
     * commit), so the execution module stops the plan's running executions.
     */
    onPlanClosed?: (planId: string, outcome: 'completed' | 'cancelled') => void
    /**
     * plan-execution D18: the plan's executions for `plan_get` (and the
     * Plans view's detail pushes); absent when no execution module is wired.
     */
    executionsOf?: (planId: string) => import('../../shared/planExecution').PlanExecutionView[]
    /** plan-validation D9: approval's pre-transaction gather and in-transaction standing, and its appended precondition. */
    validation?: {
      prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
      standing: (prepared: unknown) => unknown
      precondition: ApprovalPrecondition
    }
  }) {
    this.approval = {
      store,
      currentStrategyPin: teamId => this.strategyPin(teamId)?.pin ?? null,
      pinDisposition: options.pinDisposition ?? (() => null),
      ...(options.validation ? {
        prepareStanding: (planId: string, revision: number) => options.validation!.prepareStanding(planId, revision),
        standing: (prepared: unknown) => options.validation!.standing(prepared),
      } : {}),
    }
    this.preconditions = options.preconditions
      ?? [...APPROVAL_PRECONDITIONS, ...(options.validation ? [options.validation.precondition] : [])]
  }

  async list(caller: PlanCaller, status?: string): Promise<PlanSummary[]> {
    const { team } = await this.context(caller)
    return this.store.list(team.teamId).filter(plan => !status || plan.lifecycle === status || plan.state === status)
  }

  async get(caller: PlanCaller, planId: string): Promise<PlanDetail> {
    const { team } = await this.context(caller)
    return this.detailWithExecutions(this.teamPlan(team, planId).id)
  }

  /** D18: the stored detail plus the plan's executions, when the module is wired. */
  detailWithExecutions(planId: string): PlanDetail {
    const detail = this.store.detail(planId)!
    const executions = this.options.executionsOf?.(planId)
    return executions === undefined ? detail : { ...detail, executions }
  }

  /** D5: the plan, its creator's draft, and a `created` event in one transaction. */
  async create(caller: PlanCaller, input: PlanCreateInput): Promise<{ plan: PlanSummary; draft: PlanDraft }> {
    const { team, actor, canCreate } = await this.context(caller)
    if (!canCreate) {
      throw new Error('Your group cannot create plans (its group file does not set canCreatePlans: true). Ask the human to grant it, or ask a lead whose group can.')
    }
    const title = input.title.trim()
    if (!title) throw new Error('A plan needs a title')
    const content = normalizePlanContent(input.content ?? {})
    const errors = planStructureErrors(content)
    if (errors.length > 0) throw new Error(`The plan content is refused: ${errors.join(' ')}`)
    const draftId = defaultDraftId(actor)
    const id = this.store.atomically(() => {
      const planId = this.store.insertPlan({ teamId: team.teamId, title, creator: actor })
      this.store.writeDraft(planId, { draftId, author: actor, content, contentHash: hashPlanDraft(content), expectedDraftHash: null })
      this.store.insertEvent(planId, { kind: 'created', actor, payload: { draftId } })
      return planId
    })
    this.store.announce(id)
    return { plan: this.store.summary(this.store.get(id)!), draft: this.store.getDraft(id, draftId)! }
  }

  /** D5: CAS-guarded, structure-checked; a refusal writes nothing and returns the stored draft. */
  async saveDraft(caller: PlanCaller, input: PlanSaveDraftInput): Promise<PlanSaveOutcome> {
    const { team, actor } = await this.context(caller)
    const plan = this.teamPlan(team, input.plan_id)
    const draftId = input.draft_id?.trim() || defaultDraftId(actor)
    const content = normalizePlanContent(input.content)
    const errors = planStructureErrors(content)
    if (errors.length > 0) {
      return { ok: false, reason: 'structure', message: errors.join(' '), errors, stored: this.store.getDraft(plan.id, draftId) }
    }
    const outcome = this.store.atomically(() => this.store.writeDraft(plan.id, {
      draftId, author: actor, content, contentHash: hashPlanDraft(content),
      expectedDraftHash: input.expected_draft_hash ?? null,
      ...(input.expected_base_revision !== undefined ? { expectedBaseRevision: input.expected_base_revision } : {}),
    }))
    if (outcome.ok) this.store.announce(plan.id)
    return outcome
  }

  /** D6: one transaction from the open check to the `submitted` event; the draft stays as it was. */
  async submit(caller: PlanCaller, input: { plan_id: string; draft_id?: string }): Promise<PlanSubmitOutcome> {
    const { team, actor } = await this.context(caller)
    const plan = this.teamPlan(team, input.plan_id)
    const draftId = input.draft_id?.trim() || defaultDraftId(actor)
    let created = false
    const outcome = this.store.atomically((): PlanSubmitOutcome => {
      const current = this.store.get(plan.id)!
      if (current.lifecycle !== 'open') {
        return { ok: false, reason: 'closed', message: `The plan is ${current.lifecycle}; the human must reopen it before a revision can be submitted.`, errors: [] }
      }
      const draft = this.store.getDraft(plan.id, draftId)
      if (!draft) return { ok: false, reason: 'no-draft', message: `No draft "${draftId}" on this plan. Save one first with plan_save_draft.`, errors: [] }
      const content = normalizePlanContent(draft.content)
      const structure = planStructureErrors(content)
      if (structure.length > 0) return { ok: false, reason: 'structure', message: structure.join(' '), errors: structure }
      const gaps = planSubmitErrors(content)
      if (gaps.length > 0) return { ok: false, reason: 'incomplete', message: `The draft is incomplete: ${gaps.join(' ')}`, errors: gaps }
      const strategy = this.strategyPin(current.teamId)
      const pin = strategy?.pin ?? null
      const defined = strategy ? strategyAlignmentRefs(strategy.content) : new Set<string>()
      const unknownRefs = content.alignment.refs.filter(ref => !defined.has(ref))
      if (unknownRefs.length > 0) {
        const errors = unknownRefs.map(ref => pin
          ? `Alignment reference "${ref}" is not defined by strategy revision ${pin.revision} (cite its use-case, principle, success-measure, or decision refs).`
          : `Alignment reference "${ref}" cannot be checked: the team has no approved strategy revision, so the alignment refs must be empty.`)
        return { ok: false, reason: 'alignment', message: errors.join(' '), errors }
      }
      const hash = hashPlanRevision(content, pin)
      const standing = this.store.standingRevisionWithHash(plan.id, hash)
      if (standing) return { ok: true, created: false, revision: standing }
      const revision = this.store.insertRevision(plan.id, { content, contentHash: hash, pin, author: actor })
      this.store.insertEvent(plan.id, { kind: 'submitted', revision, contentHash: hash, actor, payload: { draftId } })
      created = true
      return { ok: true, created: true, revision: this.store.revision(plan.id, revision)! }
    })
    if (created) this.store.announce(plan.id)
    return outcome
  }

  /**
   * D7 approval: an agent caller is refused first; then the pre-transaction
   * gather step (pin 2 seam; empty here) is awaited, and one synchronous
   * transaction replays by command id, evaluates every precondition, and
   * commits supersede, approve, current revision, and the event. A second
   * approved row refused by the partial index rolls back and reads as
   * `approved-revision-unchanged`. Nothing outside the plan tables is written.
   */
  async approve(caller: PlanCaller, input: PlanApproveInput): Promise<PlanCommandOutcome> {
    if (caller.kind !== 'human') return forbidden('approve')
    const commandId = requireCommandId(input.commandId)
    if (typeof commandId !== 'string') return commandId
    const plan = this.store.forTeam(caller.team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const request = { planId: plan.id, revision: input.revision, contentHash: input.contentHash, expectedApprovedRevision: input.expectedApprovedRevision, commandId }
    const prepared = await prepareApproval(this.approval, plan, request)
    const payload = { command: 'approve' as const, revision: input.revision, contentHash: input.contentHash, expectedApprovedRevision: input.expectedApprovedRevision }
    return runPlanCommand(this.store, plan.id, commandId, payload, () => {
      const ctx = buildApprovalContext(this.approval, prepared, this.store.get(plan.id)!, request)
      const failures = evaluatePreconditions(this.preconditions, ctx)
      if (failures.length > 0) {
        throw new PlanRefusal('precondition', `Approval refused: ${failures.map(failure => `${failure.name}: ${failure.message}`).join(' ')}`, failures)
      }
      const previous = ctx.plan.currentApprovedRevision
      try {
        if (previous !== null) this.store.setRevisionStatus(plan.id, previous, 'superseded')
        this.store.setRevisionStatus(plan.id, input.revision, 'approved')
      } catch (error) {
        if (!(error instanceof PlanApprovedRaceError)) throw error
        const failure = { name: 'approved-revision-unchanged', message: 'Another revision of this plan was approved first; this approval is refused as stale. Reload and review the current state.' }
        throw new PlanRefusal('precondition', `Approval refused: ${failure.name}: ${failure.message}`, [failure])
      }
      this.store.setCurrentApproved(plan.id, input.revision)
      return this.store.insertEvent(plan.id, {
        kind: 'approved', revision: input.revision, contentHash: input.contentHash, actor: HUMAN, commandId, payload,
      })
    })
  }

  /** Withdraw an in-review revision or discard a draft (human only). */
  async withdraw(caller: PlanCaller, input: PlanWithdrawInput): Promise<PlanCommandOutcome> {
    if (caller.kind !== 'human') return forbidden('withdraw a revision of')
    return withdrawPlan(this.store, caller.team.teamId, input)
  }

  /** Complete or cancel (human only, D8). */
  async close(caller: PlanCaller, input: PlanCloseInput): Promise<PlanCommandOutcome> {
    if (caller.kind !== 'human') return forbidden(input.outcome === 'cancelled' ? 'cancel' : 'complete')
    const outcome = await closePlan(this.store, caller.team.teamId, input)
    if (outcome.ok && !('replayed' in outcome && outcome.replayed)) this.options.onPlanClosed?.(input.planId, input.outcome)
    return outcome
  }

  /** Reopen a completed or cancelled plan (human only, D8). */
  async reopen(caller: PlanCaller, input: { planId: string; commandId: string }): Promise<PlanCommandOutcome> {
    if (caller.kind !== 'human') return forbidden('reopen')
    return reopenPlan(this.store, caller.team.teamId, input)
  }

  /**
   * plan-execution D3: append one of the human execution kinds together with
   * the execution's own writes (`within`), as one transaction that replays by
   * `(plan_id, command_id)` over the compared payload — Start `revision` and
   * `contentHash`, Stop the trimmed `reason`, Retry `change`. A replay
   * returns the prior outcome without writing and never runs `within`, so
   * its result reads undefined. PlanService stays the only writer of
   * `plan_events` (C3): ExecutionService composes this and never writes that
   * table itself. The actor is the human — Start, Stop, and Retry are the
   * human commands, and the plan-close hook's stop follows the human's close.
   */
  recordExecutionEvent<T>(planId: string, event: ExecutionEventInput, within: () => T): ExecutionEventOutcome<T> {
    const commandId = event.commandId.trim()
    if (!commandId) {
      return { ok: false, reason: 'invalid', result: undefined, message: 'An execution command needs a stable command id so a resend replays instead of repeating.' }
    }
    const payload = executionCommandPayload(event)
    let result: T | undefined
    let ran = false
    const outcome = runPlanCommand(this.store, planId, commandId, payload, () => {
      result = within()
      ran = true
      return this.store.insertEvent(planId, {
        kind: event.kind, actor: HUMAN, commandId, payload,
        ...(event.kind === 'execution-started' ? { revision: event.revision, contentHash: event.contentHash } : {}),
        ...(event.kind === 'execution-stopped' ? { reason: event.reason.trim() || null } : {}),
      })
    })
    return { ...outcome, result: ran ? result : undefined }
  }

  /**
   * plan-execution D19: Kawai completes the plan when an execution's last
   * change landed and its revision is still the plan's current approved one.
   * The deterministic command id makes a completion retried after a restart
   * replay instead of writing twice. Any other state refuses and the plan
   * stays open; finishing the execution itself is the execution store's
   * write, never this one's.
   */
  completeBySystem(planId: string, executionId: string): PlanCommandOutcome {
    const commandId = `exec:${executionId}:complete`
    const payload = { command: 'complete-by-system' as const, executionId }
    return runPlanCommand(this.store, planId, commandId, payload, () => {
      const plan = this.store.get(planId)
      if (!plan) throw new PlanRefusal('not-found', `Plan not found in this team: ${planId}`)
      if (plan.lifecycle !== 'open') throw new PlanRefusal('state', `The plan is ${plan.lifecycle}; the system completes only an open plan.`)
      const execution = this.options.executionOf?.(executionId) ?? null
      if (!execution || execution.planId !== planId) throw new PlanRefusal('not-found', `Execution not found on this plan: ${executionId}`)
      if (execution.revision !== plan.currentApprovedRevision) {
        throw new PlanRefusal('state', `The execution ran revision ${execution.revision}, not the current approved revision ${plan.currentApprovedRevision ?? 'none'}; the plan stays open.`)
      }
      this.store.setLifecycle(planId, 'completed')
      return this.store.insertEvent(planId, { kind: 'completed', actor: { kind: 'system', sessionId: null }, commandId, payload })
    })
  }

  /** The caller's team, bound actor, and current creation right (read at call time). */
  async context(caller: PlanCaller): Promise<{ team: TeamIdentity; actor: PlanActor; canCreate: boolean }> {
    if (caller.kind === 'human') return { team: caller.team, actor: HUMAN, canCreate: true }
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    const { team, catalog } = await loadTeamGroups(session.projectPath, this.options.homeDir)
    const group = session.groupId ? catalog.groups.get(session.groupId)?.group : undefined
    return { team, actor: { kind: 'agent', sessionId: session.sessionId }, canCreate: group?.canCreatePlans === true }
  }

  /** The plan, if it belongs to the team; otherwise an error that leaks nothing. */
  teamPlan(team: TeamIdentity, planId: string) {
    const plan = this.store.forTeam(team.teamId, planId)
    if (!plan) throw new Error(`Plan not found in this team: ${planId}`)
    return plan
  }

  /** The team's current approved strategy revision as a pin, with its content (D6 step 3). */
  private strategyPin(teamId: string): { pin: PlanStrategyPin; content: StrategyContent } | null {
    const strategy = this.options.strategies.forTeam(teamId)
    if (!strategy || strategy.currentApprovedRevision === null) return null
    const revision = this.options.strategies.revision(strategy.id, strategy.currentApprovedRevision)
    if (!revision) return null
    return { pin: { strategyId: strategy.id, revision: revision.revision, hash: revision.contentHash }, content: revision.content }
  }
}

const HUMAN: PlanActor = { kind: 'human', sessionId: null }

/** The compared payload of one execution kind (plan-execution D3): the command name plus its own fields. */
function executionCommandPayload(event: ExecutionEventInput): CommandPayload {
  switch (event.kind) {
    case 'execution-started':
      return { command: 'execution-start', revision: event.revision, contentHash: event.contentHash }
    case 'execution-stopped':
      return { command: 'execution-stop', executionId: event.executionId, reason: event.reason.trim() }
    case 'change-retried':
      return { command: 'change-retry', executionId: event.executionId, change: event.change }
  }
}

function defaultDraftId(actor: PlanActor): string {
  return actor.kind === 'agent' ? actor.sessionId : 'human'
}

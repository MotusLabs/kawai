// Hold service (revision-control design D4, D3): the owner's hold commands —
// place, release (whole, by changes, and a plan hold narrowed with
// `retain`), and extend. Every command is the human's: a non-human caller is
// refused before anything else. Each follows D3's command shape: reads that
// write nothing, then one transaction — the replay by `(plan_id, command_id)`
// through `PlanService.recordRevisionControlEvent` (the only `plan_events`
// writer, C3), the named checks refusing with every failure and writing
// nothing, the hold-store writes, and the D3 event — and after that
// transaction commits, the executor wake. `runPlanCommand` sends the
// plan-detail push itself after a committed, non-replayed command; the wake
// fires beside it, and neither fires on a replay or a refusal. The change
// names a hold may cover are read inside the command's transaction from the
// plan's current approved revision and its running execution, so a racing
// approval cannot slip between the check and the write. A plan hold released
// with `retain` is released and a changes-scoped hold over `retain` takes
// its place — same rationale, cites, and deadline, id
// `hold-<commandId>-narrowed` — so the narrowing replays (D4).
import type { PlanHold } from '../../../shared/planRevisionControl'
import type { ImpactStore } from '../../strategy/impactStore'
import type { StrategyStore } from '../../strategy/strategyStore'
import { PlanRefusal, type PlanCommandOutcome } from '../planCommands'
import type { PlanStore } from '../planStore'
import type { DecisionStore } from '../decisions/decisionStore'
import type { ExecutionStore } from '../execution/executionStore'
import type { ExecutionEventOutcome, PlanCaller, PlanService } from '../PlanService'
import { HoldStore } from './holdStore'

/** The review deadline is at most this many days away (D4; the design's Open Questions keep the bound a constant). */
export const HOLD_DEADLINE_MAX_DAYS = 30
const HOLD_DEADLINE_MAX_MS = HOLD_DEADLINE_MAX_DAYS * 24 * 60 * 60 * 1000

export interface HoldPlaceInput {
  planId: string
  scope: 'plan' | 'changes'
  /** Scope `changes` only; every name must be a change of the plan's current approved revision or of its running execution. */
  changes?: string[]
  rationale: string
  deadline: string
  cites?: PlanHold['cites']
  commandId: string
}

export interface HoldReleaseInput {
  planId: string
  holdId: string
  reason: string
  /** Free only these rows of a changes-scoped hold; the hold releases once none remain. */
  changes?: string[]
  /** Narrow a whole-plan hold to these changes (D4). */
  retain?: string[]
  commandId: string
}

export interface HoldExtendInput {
  planId: string
  holdId: string
  deadline: string
  reason?: string
  commandId: string
}

export interface HoldServiceDeps {
  holds: HoldStore
  plans: PlanStore
  planService: PlanService
  strategies: StrategyStore
  impact: ImpactStore
  decisions: DecisionStore
  executions: ExecutionStore
  /** The executor wake, called after a committed command only; absent where nothing runs executions. */
  wake?: (teamId: string) => unknown
  now?: () => Date
}

type Failure = { state?: boolean; text: string }

/** One committed hold command's result; `result` is undefined on a replay (D3: the prior outcome returns, nothing runs again). */
export type HoldOutcome<T> = ExecutionEventOutcome<T>

function forbidden(action: string): PlanCommandOutcome & { result: undefined } {
  return { ok: false, reason: 'forbidden', result: undefined, message: `Only the plan's owner may ${action}, from the Plans view; no agent tool can.` }
}

function notFound(message: string): PlanCommandOutcome & { result: undefined } {
  return { ok: false, reason: 'not-found', result: undefined, message }
}

export class HoldService {
  private readonly now: () => Date

  constructor(readonly deps: HoldServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** D4: place a hold on an open plan, whole or scoped to known changes, optionally citing a review or card. */
  place(caller: PlanCaller, input: HoldPlaceInput): HoldOutcome<{ hold: PlanHold }> {
    if (caller.kind !== 'human') return forbidden('place a hold')
    const plan = this.deps.plans.forTeam(caller.team.teamId, input.planId)
    if (!plan) return notFound(`Plan not found in this team: ${input.planId}`)
    const outcome = this.deps.planService.recordRevisionControlEvent(plan.id, {
      kind: 'hold-placed', commandId: input.commandId, scope: input.scope,
      changes: input.changes ?? [], rationale: input.rationale,
      deadline: input.deadline, cites: input.cites ?? null,
    }, () => this.placeWithin(caller.team.teamId, plan.id, input))
    if (outcome.ok && !outcome.replayed) this.deps.wake?.(plan.teamId)
    return outcome
  }

  private placeWithin(teamId: string, planId: string, input: HoldPlaceInput): { hold: PlanHold } {
    const plan = this.deps.plans.get(planId)
    if (!plan) throw new PlanRefusal('not-found', `Plan not found in this team: ${planId}`)
    const failures: Failure[] = []
    if (plan.lifecycle !== 'open') {
      failures.push({ state: true, text: `the plan is ${plan.lifecycle}; only an open plan takes a hold` })
    }
    // The compared-payload builder has already refused an unparsable deadline, written nowhere.
    const at = this.now().getTime()
    const deadline = new Date(input.deadline)
    if (deadline.getTime() <= at) failures.push({ text: `the review deadline ${deadline.toISOString()} is not in the future` })
    else if (deadline.getTime() > at + HOLD_DEADLINE_MAX_MS) failures.push({ text: `the review deadline ${deadline.toISOString()} is more than ${HOLD_DEADLINE_MAX_DAYS} days away` })
    if (!input.rationale.trim()) failures.push({ text: 'the rationale is empty' })
    if (input.scope === 'plan') {
      if ((input.changes ?? []).length > 0) failures.push({ text: 'a whole-plan hold takes no change names; scope it to the changes instead' })
    } else {
      const names = input.changes ?? []
      if (names.length === 0) failures.push({ text: 'a changes-scoped hold names no change' })
      const known = this.knownChanges(planId)
      const seen = new Set<string>()
      for (const name of names) {
        if (seen.has(name)) failures.push({ text: `the change ${name} is named twice` })
        else if (!known.has(name)) failures.push({ text: `unknown change: ${name}` })
        seen.add(name)
      }
    }
    if (input.cites) {
      const problem = this.citeProblem(teamId, planId, input.cites)
      if (problem) failures.push({ text: problem })
    }
    this.refuse(failures, 'The hold was refused')
    const hold = this.deps.holds.insert({
      teamId, planId, scope: input.scope, rationale: input.rationale.trim(),
      deadline: deadline.toISOString(), cites: input.cites ?? null,
      commandId: input.commandId.trim(), changes: input.scope === 'changes' ? input.changes ?? [] : [],
    })
    return { hold }
  }

  /** D4: release a hold wholly, free some of a changes hold's rows, or narrow a plan hold with `retain`. */
  release(caller: PlanCaller, input: HoldReleaseInput): HoldOutcome<{ released: PlanHold; narrowed: PlanHold | null }> {
    if (caller.kind !== 'human') return forbidden('release a hold')
    const plan = this.deps.plans.forTeam(caller.team.teamId, input.planId)
    if (!plan) return notFound(`Plan not found in this team: ${input.planId}`)
    const outcome = this.deps.planService.recordRevisionControlEvent(plan.id, {
      kind: 'hold-released', commandId: input.commandId, holdId: input.holdId,
      changes: input.changes ?? [], retain: input.retain ?? [], reason: input.reason,
    }, () => this.releaseWithin(caller.team.teamId, plan.id, input))
    if (outcome.ok && !outcome.replayed) this.deps.wake?.(plan.teamId)
    return outcome
  }

  private releaseWithin(teamId: string, planId: string, input: HoldReleaseInput): { released: PlanHold; narrowed: PlanHold | null } {
    const hold = this.deps.holds.get(teamId, input.holdId)
    if (!hold || hold.planId !== planId) throw new PlanRefusal('not-found', `Hold not found on this plan: ${input.holdId}`)
    const failures: Failure[] = []
    if (hold.releasedAt !== null) failures.push({ state: true, text: `the hold ${hold.id} is already released` })
    if (!input.reason.trim()) failures.push({ text: 'the release reason is empty' })
    const changes = input.changes ?? []
    const retain = input.retain ?? []
    let narrowed: PlanHold | null = null
    if (changes.length > 0 && retain.length > 0) {
      failures.push({ text: 'a release either names changes to free or retains them, not both' })
    } else if (retain.length > 0) {
      // Narrowing (D4): the plan hold is released and a changes-scoped hold
      // over `retain` takes its place, inside this one transaction. The
      // narrowed hold's id derives from the command, so a replay of the
      // command writes nothing — and the hold table's
      // UNIQUE (plan_id, command_id) refuses a second one outright.
      if (hold.scope !== 'plan') failures.push({ text: 'only a whole-plan hold narrows; free a changes-scoped hold by its changes' })
      this.namedOnce(retain, failures)
      // The narrowed hold's names must be changes the plan knows, checked
      // like place's — inside this transaction.
      const known = this.knownChanges(planId)
      for (const name of retain) {
        if (!known.has(name)) failures.push({ text: `unknown change: ${name}` })
      }
    } else if (changes.length > 0) {
      if (hold.scope !== 'changes') failures.push({ text: 'a whole-plan hold is released wholly, or narrowed with retain; it has no per-change rows' })
      for (const name of changes) {
        if (!hold.changes.includes(name)) failures.push({ text: `the hold does not cover ${name}` })
      }
      this.namedOnce(changes, failures)
    }
    this.refuse(failures, 'The release was refused')
    this.deps.holds.release({ teamId, holdId: hold.id, changes: retain.length > 0 ? [] : changes, reason: input.reason.trim(), commandId: input.commandId.trim() })
    if (retain.length > 0) {
      narrowed = this.deps.holds.insert({
        id: `hold-${input.commandId.trim()}-narrowed`, teamId, planId, scope: 'changes',
        rationale: hold.rationale, deadline: hold.deadline, cites: hold.cites,
        commandId: input.commandId.trim(), changes: retain,
      })
    }
    return { released: this.deps.holds.get(teamId, hold.id)!, narrowed }
  }

  /** D4: set a later review deadline on an active hold, at most 30 days away. */
  extend(caller: PlanCaller, input: HoldExtendInput): HoldOutcome<{ hold: PlanHold }> {
    if (caller.kind !== 'human') return forbidden('extend a hold')
    const plan = this.deps.plans.forTeam(caller.team.teamId, input.planId)
    if (!plan) return notFound(`Plan not found in this team: ${input.planId}`)
    const outcome = this.deps.planService.recordRevisionControlEvent(plan.id, {
      kind: 'hold-extended', commandId: input.commandId, holdId: input.holdId,
      deadline: input.deadline, reason: input.reason ?? '',
    }, () => this.extendWithin(caller.team.teamId, plan.id, input))
    if (outcome.ok && !outcome.replayed) this.deps.wake?.(plan.teamId)
    return outcome
  }

  private extendWithin(teamId: string, planId: string, input: HoldExtendInput): { hold: PlanHold } {
    const hold = this.deps.holds.get(teamId, input.holdId)
    if (!hold || hold.planId !== planId) throw new PlanRefusal('not-found', `Hold not found on this plan: ${input.holdId}`)
    const failures: Failure[] = []
    if (hold.releasedAt !== null) failures.push({ state: true, text: `the hold ${hold.id} is already released` })
    // The compared-payload builder has already refused an unparsable deadline.
    const deadline = new Date(input.deadline)
    const at = this.now().getTime()
    if (deadline.getTime() <= at) failures.push({ text: `the review deadline ${deadline.toISOString()} is not in the future` })
    else if (deadline.getTime() > at + HOLD_DEADLINE_MAX_MS) failures.push({ text: `the review deadline ${deadline.toISOString()} is more than ${HOLD_DEADLINE_MAX_DAYS} days away` })
    else if (deadline.getTime() <= new Date(hold.deadline).getTime()) failures.push({ text: `the review deadline ${deadline.toISOString()} is not later than the hold's current deadline ${hold.deadline}` })
    this.refuse(failures, 'The extension was refused')
    if (!this.deps.holds.extend({ teamId, holdId: hold.id, deadline: deadline.toISOString() })) {
      throw new PlanRefusal('state', `The hold ${hold.id} was released while the extension was written. Nothing was written.`)
    }
    return { hold: this.deps.holds.get(teamId, hold.id)! }
  }

  /**
   * The change names a hold may cover (D4), read inside the command's
   * transaction: the plan's current approved revision's, plus its running
   * execution's — so a racing approval cannot slip between the check and
   * the write.
   */
  private knownChanges(planId: string): Set<string> {
    const plan = this.deps.plans.get(planId)
    const approved = plan && plan.currentApprovedRevision !== null ? this.deps.plans.revision(planId, plan.currentApprovedRevision) : null
    const names = new Set<string>((approved?.content.changes ?? []).map(entry => entry.change))
    const running = this.deps.executions.running(planId)
    if (running) for (const row of this.deps.executions.changes(running.id)) names.add(row.change)
    return names
  }

  /**
   * Why the cite cannot stand (D4): a decision card of the plan; a strategy
   * impact review of the team's strategy that lists the plan — a proposal
   * or a decision of that review names it. Any review of the team's
   * strategy qualifies, superseded ones included.
   */
  private citeProblem(teamId: string, planId: string, cites: NonNullable<PlanHold['cites']>): string | null {
    if (cites.kind === 'decision-card') {
      const card = this.deps.decisions.card(teamId, cites.id)
      return card && card.planId === planId ? null : `the cited decision card ${cites.id} is not a card of this plan`
    }
    const strategy = this.deps.strategies.forTeam(teamId)
    if (!strategy) return `the team has no product strategy, so impact review ${cites.id} cannot be cited`
    if (!this.deps.strategies.impactReviews(strategy.id).some(review => review.id === cites.id)) {
      return `the cited impact review ${cites.id} does not belong to this team's strategy`
    }
    const lists = this.deps.impact.proposals(strategy.id).some(entry => entry.reviewId === cites.id && entry.planId === planId)
      || this.deps.impact.decisions(strategy.id).some(entry => entry.reviewId === cites.id && entry.planId === planId)
    return lists ? null : `the cited impact review ${cites.id} does not list this plan`
  }

  /** Refuse with every failure listed, nothing written (D3). */
  private refuse(failures: Failure[], what: string): void {
    if (failures.length === 0) return
    const reason = failures.some(failure => failure.state) ? 'state' : 'invalid'
    throw new PlanRefusal(reason, `${what}: ${failures.map(failure => failure.text).join('; ')}. Nothing was written.`)
  }

  private namedOnce(names: string[], failures: Failure[]): void {
    const seen = new Set<string>()
    for (const name of names) {
      if (seen.has(name)) failures.push({ text: `the change ${name} is named twice` })
      seen.add(name)
    }
  }
}

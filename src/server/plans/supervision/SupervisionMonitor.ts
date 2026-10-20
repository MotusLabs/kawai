// The supervision monitor (plan-supervision design D11): one loop per team,
// apart from the executor's tick, that only reads, alerts, and manages fix
// and correction tasks — it never writes an execution row. A sweep runs at
// startup, on the team's plan, execution, landing, promotion, task, and
// mailbox notifications (coalesced, `debounceMs`), and on a 60 s timer while
// the team has work: a running execution or promotion, or an open fix or
// correction task. Sweeps are single-flight per team: a notification during
// a sweep runs one more after it. A failing sweep is logged and the next
// trigger retries. Each sweep, per open plan: derives supervision over the
// newest execution, raises new stall alerts, then completes fix and
// correction tasks, then pushes the plan's detail when its derived view
// changed. The monitor also owns D11's in-memory `waitEndedAt`: the last
// time it saw a change in a named wait, set to the startup time for every
// running change, so a restart can delay a stall but never raise one early.
import type { ChangeSupervision } from '../../../shared/planSupervision'
import type { PlanSupervisionRead } from './supervisionRead'

export type DerivedPlan = PlanSupervisionRead & { changes: ChangeSupervision[] }

export interface SupervisionMonitorDeps {
  /** Teams that have work now (startup). */
  teamsWithWork: () => string[]
  /** Whether the team has a running execution or promotion, or an open fix or correction task. */
  hasWork: (teamId: string) => boolean
  /** Every change of the team's running executions (the startup `waitEndedAt` seed). */
  runningChanges: (teamId: string) => Array<{ executionId: string; change: string }>
  /** The team's open plans. */
  plansOf: (teamId: string) => string[]
  /** One plan's derivation, reading `waitEndedAt` from the monitor; null when the plan is gone. */
  derive: (teamId: string, planId: string, now: Date) => DerivedPlan | null
  /** Raise each new stall episode's alert (D11); returns how many were raised. */
  raiseStalls: (teamId: string, planId: string, derived: DerivedPlan) => number
  /** Create and complete the team's fix and correction tasks (D8). */
  manageFixes: (teamId: string) => Promise<void>
  /** The plan's derived view with read-time fields blanked; a change re-pushes the detail (8.6). */
  viewKey: (teamId: string, planId: string, now: Date) => string | null
  /** Push the plan's detail. */
  announce: (planId: string) => void
  /** Bind the team notifications; returns the unsubscribe. */
  subscribe: (notify: (teamId: string) => void) => () => void
  now?: () => Date
  timerMs?: number
  debounceMs?: number
  log?: (message: string, error: unknown) => void
}

interface TeamState {
  running: Promise<void> | null
  again: boolean
  pending: ReturnType<typeof setTimeout> | null
  timer: ReturnType<typeof setTimeout> | null
  /** The plan detail keys of the last sweep (8.6). */
  views: Map<string, string>
}

const TIMER_MS = 60_000
const DEBOUNCE_MS = 1_000
const waitKey = (executionId: string, change: string) => `${executionId}\u0000${change}`

/** A cause or an also-applying entry that is one of D10's named waits. */
const NAMED_WAITS = new Set(['dependency', 'parallel-limit', 'effect', 'uncertain-delivery', 'staffing', 'parked', 'request', 'decision-card', 'ci', 'member-release', 'condition', 'landing-slot'])
export const inNamedWait = (change: ChangeSupervision): boolean => NAMED_WAITS.has(change.cause.kind) || change.alsoApplying.length > 0

export class SupervisionMonitor {
  private readonly teams = new Map<string, TeamState>()
  private readonly waits = new Map<string, string>()
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private readonly now: () => Date

  constructor(private readonly deps: SupervisionMonitorDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** D11's in-memory wait observation, read by the loader. */
  waitEndedAt(executionId: string, change: string): string | null {
    return this.waits.get(waitKey(executionId, change)) ?? null
  }

  /** Startup: seed every running change's wait time, bind the notifications, and sweep each team with work. */
  start(): void {
    if (this.stopped || this.unsubscribe !== null) return
    const startedAt = this.now().toISOString()
    const teams = this.deps.teamsWithWork()
    for (const teamId of teams) {
      for (const entry of this.deps.runningChanges(teamId)) this.waits.set(waitKey(entry.executionId, entry.change), startedAt)
    }
    this.unsubscribe = this.deps.subscribe(teamId => this.notify(teamId))
    for (const teamId of teams) this.schedule(teamId, 0)
  }

  /** A team notification: sweep once the burst settles, when the team has work or was being watched. */
  notify(teamId: string): void {
    if (this.stopped) return
    if (!this.teams.has(teamId) && !this.safeHasWork(teamId)) return
    this.schedule(teamId, this.deps.debounceMs ?? DEBOUNCE_MS)
  }

  /** Resolves once no sweep is pending or running (tests and shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.teams.values()].filter(state => state.running !== null || state.pending !== null)
      if (busy.length === 0) return
      await Promise.all(busy.map(state => state.running ?? new Promise(resolve => setTimeout(resolve, 1))))
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const state of this.teams.values()) {
      if (state.pending) clearTimeout(state.pending)
      if (state.timer) clearTimeout(state.timer)
      state.pending = null
      state.timer = null
    }
  }

  /** Whether the team's 60 s timer is armed. */
  timerArmed(teamId: string): boolean {
    return this.teams.get(teamId)?.timer != null
  }

  private state(teamId: string): TeamState {
    let state = this.teams.get(teamId)
    if (state === undefined) {
      state = { running: null, again: false, pending: null, timer: null, views: new Map() }
      this.teams.set(teamId, state)
    }
    return state
  }

  private schedule(teamId: string, delayMs: number): void {
    const state = this.state(teamId)
    if (state.running !== null) {
      state.again = true
      return
    }
    if (state.pending !== null) return
    state.pending = setTimeout(() => {
      state.pending = null
      this.run(teamId, state)
    }, delayMs)
    ;(state.pending as { unref?: () => void }).unref?.()
  }

  private run(teamId: string, state: TeamState): void {
    if (this.stopped) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.running = this.sweep(teamId, state)
      .catch(error => (this.deps.log ?? defaultLog)(`supervision sweep failed for team ${teamId}`, error))
      .finally(() => {
        state.running = null
        if (this.stopped) return
        if (state.again) {
          state.again = false
          this.schedule(teamId, 0)
          return
        }
        if (this.safeHasWork(teamId)) {
          state.timer = setTimeout(() => this.run(teamId, state), this.deps.timerMs ?? TIMER_MS)
          ;(state.timer as { unref?: () => void }).unref?.()
        } else {
          // No work: the timer stops and the team is no longer watched.
          this.teams.delete(teamId)
        }
      })
  }

  private async sweep(teamId: string, state: TeamState): Promise<void> {
    const now = this.now()
    const plans = this.deps.plansOf(teamId)
    const alerted = new Set<string>()
    for (const planId of plans) {
      const derived = this.deps.derive(teamId, planId, now)
      if (derived === null) continue
      for (const change of derived.changes) {
        if (derived.executionId !== null && inNamedWait(change)) this.waits.set(waitKey(derived.executionId, change.change), now.toISOString())
      }
      if (this.deps.raiseStalls(teamId, planId, derived) > 0) alerted.add(planId)
    }
    await this.deps.manageFixes(teamId)
    const viewNow = this.now()
    for (const planId of plans) {
      const key = this.deps.viewKey(teamId, planId, viewNow)
      if (key === null) continue
      // An alert write is pushed (D15) even though the detail does not carry it.
      if (state.views.get(planId) === key && !alerted.has(planId)) continue
      state.views.set(planId, key)
      this.deps.announce(planId)
    }
  }

  private safeHasWork(teamId: string): boolean {
    try {
      return this.deps.hasWork(teamId)
    } catch (error) {
      ;(this.deps.log ?? defaultLog)(`supervision work check failed for team ${teamId}`, error)
      return false
    }
  }
}

function defaultLog(message: string, error: unknown): void {
  console.error(`[supervision] ${message}:`, error)
}

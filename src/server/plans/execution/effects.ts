// effects.ts - The effects runner (plan-execution D14): every external step
// is recorded as an effect row before it runs, and inspected before it is
// ever repeated. The runner works through one team's due effects one at a
// time: mark running, call the adapter with an explicit timeout, classify
// the outcome (D14's rule, `effectOutcome.ts`), and commit — success as
// `done` with its follow-on transition left to the caller, transient
// failures back to `pending` under the 30 s / 2 m / 10 m backoff and failed
// after three tries, permanent failures `failed` at once. Stop cancels the
// pending rows; a cancelled effect is never run.
import type { EffectRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import { classifyEffectFailure } from '../landing/effectOutcome'
import type { GitRemoteError } from '../landing/gitRemote'
import type { GithubError } from '../landing/github'

export type EffectCallResult = { ok: true; outcome: unknown } | { ok: false; error: GitRemoteError | GithubError }

export interface EffectAdapter {
  call(effect: EffectRow): Promise<EffectCallResult>
}

/** A failed effect's change stops as effect-failed (§13 wires the stop); the message is git's or GitHub's. */
export type EffectFailureNotice = (effect: EffectRow, error: { message: string; transient: boolean }) => void

/** A done effect's follow-on transition (D14), computed from the outcome by the stage that owns it. */
export type EffectDoneNotice = (effect: EffectRow, outcome: unknown) => void

export interface EffectRunnerDeps {
  store: ExecutionStore
  adapter: EffectAdapter
  /** One call's bound; the adapters' own timeouts still apply beneath it. */
  timeoutMs?: number
  /** D14's backoff after 1st, 2nd, 3rd transient failure. */
  backoffsMs?: readonly [number, number, number]
  onFailed?: EffectFailureNotice
  onDone?: EffectDoneNotice
  now?: () => Date
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_BACKOFFS_MS: readonly [number, number, number] = [30_000, 120_000, 600_000]

class EffectTimeout extends Error {}

export class EffectRunner {
  constructor(private readonly deps: EffectRunnerDeps) {}

  /** Run every due pending effect of the team, one at a time (D14). */
  /** Run the team's due effects; the count run, so a caller knows whether a step settled. */
  async runDue(teamId: string): Promise<number> {
    const due = this.deps.store.dueEffects(teamId, this.iso())
    for (const effect of due) {
      await this.runOne(effect)
    }
    return due.length
  }

  /** One effect's cycle: running → call → committed outcome. */
  async runOne(effect: EffectRow): Promise<void> {
    this.deps.store.markEffectRunning(effect.id)
    const result = await this.call(effect)
    if (result.ok) {
      this.deps.store.setEffectOutcome(effect.id, { state: 'done', outcome: result.outcome })
      this.deps.onDone?.(this.deps.store.effect(effect.id)!, result.outcome)
      return
    }
    const message = ('stderr' in result.error ? result.error.stderr : result.error.message).trim() || 'the effect failed'
    if (classifyEffectFailure(result.error) === 'transient') {
      const fresh = this.deps.store.effect(effect.id)!
      const backoffs = this.deps.backoffsMs ?? DEFAULT_BACKOFFS_MS
      if (fresh.tries < backoffs.length) {
        this.deps.store.scheduleEffectRetry(effect.id, new Date(this.now().getTime() + backoffs[fresh.tries]!).toISOString(), message)
        return
      }
    }
    this.deps.store.setEffectOutcome(effect.id, { state: 'failed', error: message })
    this.deps.onFailed?.(this.deps.store.effect(effect.id)!, { message, transient: false })
  }

  private async call(effect: EffectRow): Promise<EffectCallResult> {
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.deps.adapter.call(effect),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new EffectTimeout()), timeoutMs)
        }),
      ])
    } catch (error) {
      if (error instanceof EffectTimeout) {
        // No exit of its own, like a killed process: transient (D14).
        return { ok: false, error: { argv: ['timeout'], exitCode: null, stderr: `the effect timed out after ${timeoutMs} ms` } }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { argv: ['adapter'], exitCode: 1, stderr: message } }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private iso(): string {
    return this.now().toISOString()
  }
}

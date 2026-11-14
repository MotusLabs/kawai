// The Claude session's usage control calls (design §6, tasks 5.2/5.3), each
// an owned job that stop joins. A rejection is kept, unless it is exactly the
// stop's own cancellation of that generation's query (its AbortError, or for
// the context probe and the SDK usage pull the SDK cleanup error
// sdkControlCleanup.ts recognizes for that call), so stop reports it.
// None starts once stop has begun.
// - The context probe (`getContextUsage`) runs after each initialize, each
//   result, and an interrupt that settles an active turn (at once, not after
//   the result it owes; task-602c71e9 R6). Its report is applied only while
//   its generation is current.
// - The host-login quota pull (`usage_EXPERIMENTAL...`) runs once per driver
//   and only when the caller chose quotaSource `host-login`. It reads the
//   supplied home's login, which can be another account than a proxy
//   session's, so the report is labelled `host-login-pull` / `host-login`.
//   An absent method or a reply without plan windows reports nothing.
// - A caller's usage claim (R2, claimUsagePull) replaces the once-per-driver
//   rule: it is asked once per generation after initialize, as an owned job,
//   only while that generation is current and not stopping. After its await the generation must still be current and not stopping.
//   Only true under quotaSource host-login permits that generation's pull;
//   under none the claim runs (the caller's own work) but no SDK pull
//   follows. A rejecting claim is retained raw for the stop.
// - onQuotaNoData (R2) fires once for a permitted pull that was attempted and
//   found no method, no plan windows or a rejection. The rejection itself
//   stays retained; a stop's own cancellation is not no-data.
import type { DriverLifecycle } from '../lifecycle/lifecycle.js'
import type { ContextReportSlice } from '../usage/context.js'
import { parseUsagePull } from '../usage/quota.js'
import type { QuotaNoData } from '../options.js'
import type { QuotaReport } from '../usage/types.js'
import { cancelledByStop, type Generation } from './generations.js'
import { ControlInvocation } from './sdkControlCleanup.js'

export interface UsageControlsHost {
  lifecycle: DriverLifecycle
  quotaSource: 'none' | 'host-login'
  claimUsagePull?: () => boolean | Promise<boolean>
  noData(info: QuotaNoData): void
  stopToken(): object | null
  current(): Generation | null
  facts: { contextReport(report: ContextReportSlice): void; quotaReport(report: QuotaReport): void }
}

export class UsageControls {
  private pulled = false

  constructor(private readonly host: UsageControlsHost) {}

  /** A generation answered initialize: probe its context; claim or pull the host-login quota. */
  initialized(generation: Generation): void {
    this.probe(generation)
    const claim = this.host.claimUsagePull
    if (claim) {
      // Only the SDK pull's own rejection can be the stop's cleanup cancellation, never the claim's.
      const pull = new ControlInvocation(generation, 'quota-pull')
      this.run(generation, 'usage-claim', async () => {
        if (!this.eligible(generation)) return
        const permitted = (await claim()) === true
        if (!permitted || this.host.quotaSource !== 'host-login' || !this.eligible(generation)) return
        await this.pull(generation, pull)
      }, pull)
      return
    }
    if (this.host.quotaSource !== 'host-login' || this.pulled) return
    const pull = new ControlInvocation(generation, 'quota-pull')
    if (typeof pull.method() !== 'function') return
    this.pulled = true
    this.run(generation, 'quota-pull', () => this.pull(generation, pull), pull)
  }

  /** The permitted pull (one invocation): a report with windows, else one no-data observation. */
  private async pull(generation: Generation, pull: ControlInvocation): Promise<void> {
    if (typeof pull.method() !== 'function') return this.noData()
    let reply: unknown
    try {
      reply = await pull.call<unknown>({ skipBehaviors: true })
    } catch (error) {
      // A stop's own cancellation is not no-data: eligibility already excludes a stopping driver.
      if (this.eligible(generation)) this.noData()
      throw error
    }
    const quota = parseUsagePull(reply)
    if (quota && quota.windows.length > 0) this.host.facts.quotaReport(quota)
    else if (this.eligible(generation)) this.noData()
  }

  private noData(): void {
    this.host.noData({ source: 'host-login-pull', accountScope: 'host-login' })
  }

  private eligible(generation: Generation): boolean {
    const state = this.host.lifecycle.state
    return generation === this.host.current() && !generation.retired && state !== 'stopping' && state !== 'stopped'
  }

  /** Ask the CLI for its context report (after initialize, after each result, and at an active turn's interrupt). */
  probe(generation: Generation): void {
    const probe = new ControlInvocation(generation, 'context-probe')
    if (typeof probe.method() !== 'function') return
    this.run(generation, 'context-probe', async () => {
      const report = await probe.call<unknown>({ detail: 'summary' })
      if (report && typeof report === 'object' && generation === this.host.current() && !generation.retired) this.host.facts.contextReport(report as ContextReportSlice)
    }, probe)
  }

  /** An owned job; its rejection is excluded only as the stop's own cancellation of that generation (or of `control`'s call). */
  private run(generation: Generation, label: string, body: () => Promise<void>, control?: ControlInvocation): void {
    const state = this.host.lifecycle.state
    if (state === 'stopping' || state === 'stopped') return
    const expectedCancellation = (error: unknown) => cancelledByStop(generation, this.host.stopToken(), error) || (control?.cancelledByCleanup(this.host.stopToken(), error) ?? false)
    void this.host.lifecycle.jobs.run(`${label}:${generation.number}`, body, { expectedCancellation })
  }
}

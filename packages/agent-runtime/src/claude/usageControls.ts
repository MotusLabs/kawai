// The Claude session's usage control calls (design §6, tasks 5.2/5.3), each
// an owned job that stop joins. A rejection is kept, unless it is exactly the
// stop's own cancellation of that generation's query, so stop reports it.
// None starts once stop has begun.
// - The context probe (`getContextUsage`) runs after each initialize and each
//   result. Its report is applied only while its generation is current.
// - The host-login quota pull (`usage_EXPERIMENTAL...`) runs once per driver
//   and only when the caller chose quotaSource `host-login`. It reads the
//   supplied home's login, which can be another account than a proxy
//   session's, so the report is labelled `host-login-pull` / `host-login`.
//   An absent method or a reply without plan windows reports nothing.
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { DriverLifecycle } from '../lifecycle/lifecycle.js'
import type { ContextReportSlice } from '../usage/context.js'
import { parseUsagePull } from '../usage/quota.js'
import type { QuotaReport } from '../usage/types.js'
import { cancelledByStop, type Generation } from './generations.js'

export interface UsageControlsHost {
  lifecycle: DriverLifecycle
  quotaSource: 'none' | 'host-login'
  stopToken(): object | null
  current(): Generation | null
  facts: { contextReport(report: ContextReportSlice): void; quotaReport(report: QuotaReport): void }
}

type ControlQuery = Query & {
  getContextUsage?: (options: { detail: 'summary' }) => Promise<unknown>
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options: { skipBehaviors: boolean }) => Promise<unknown>
}

export class UsageControls {
  private pulled = false

  constructor(private readonly host: UsageControlsHost) {}

  /** A generation answered initialize: probe its context; pull the host-login quota once if chosen. */
  initialized(generation: Generation): void {
    this.probe(generation)
    if (this.host.quotaSource !== 'host-login' || this.pulled) return
    const query = generation.query as ControlQuery
    const pull = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof pull !== 'function') return
    this.pulled = true
    this.run(generation, 'quota-pull', async () => {
      const quota = parseUsagePull(await pull.call(query, { skipBehaviors: true }))
      if (quota && quota.windows.length > 0) this.host.facts.quotaReport(quota)
    })
  }

  /** Ask the CLI for its context report (after initialize and after each result). */
  probe(generation: Generation): void {
    const query = generation.query as ControlQuery
    const probe = query.getContextUsage
    if (typeof probe !== 'function') return
    this.run(generation, 'context-probe', async () => {
      const report = await probe.call(query, { detail: 'summary' })
      if (report && typeof report === 'object' && generation === this.host.current() && !generation.retired) this.host.facts.contextReport(report as ContextReportSlice)
    })
  }

  private run(generation: Generation, label: string, body: () => Promise<void>): void {
    const state = this.host.lifecycle.state
    if (state === 'stopping' || state === 'stopped') return
    void this.host.lifecycle.jobs.run(`${label}:${generation.number}`, body, { expectedCancellation: (error) => cancelledByStop(generation, this.host.stopToken(), error) })
  }
}

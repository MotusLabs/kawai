// Plan-usage state for chat sessions (usage bar design D2/D3):
// UsageLimitStore keeps the latest report (or a "no data" verdict) per
// provider (providers-and-workers 5.1: sibling models of one provider share
// the same plan, so its quota is held and pulled once). Claude's pushed
// rate_limit_event, /usage report and usage pull are parsed by
// @motuslabs/agent-runtime's public usage entry and reach the store through
// runtimeEvents.ts chatUsageReport; provider quota replies parse in
// zaiQuotaLimit.ts and openRouterUsage.ts.
import type { ChatUsageReport } from '../../shared/chat'

export { percentValue } from '@motuslabs/agent-runtime/usage'

/**
 * ISO reset time from an epoch-seconds number (rate_limit_event, e.g.
 * 1791723600) or ISO string; null when unusable.
 */
export function toIsoResetsAt(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) {
    return value
  }
  return null
}

// ----------------------------------------------------------------- per-provider store

/** Notified with the latest report (or null) whenever a provider's data changes. */
export type UsageLimitListener = (
  providerId: string,
  report: ChatUsageReport | null
) => void

interface UsageLimitState {
  /** Latest report; a windowless one still holds status and receipt time. */
  report: ChatUsageReport | null
  /** Set when a pull yielded nothing: later pulls are skipped, pushes land. */
  noDataAt: string | null
  /** True once this provider's one pull per store lifetime has been claimed. */
  pullClaimed: boolean
}

/**
 * Latest plan-usage report per provider, in memory only (usage bar design
 * D3, providers-and-workers 5.1): sibling models of one provider share the
 * same plan, so the key is the provider and one report serves all of its
 * profiles. Merging keeps held windows when a report carries none, older
 * data never overwrites newer, and a "no data" verdict suppresses the pull
 * fallback until any push replaces it.
 */
export class UsageLimitStore {
  private readonly providers = new Map<string, UsageLimitState>()
  private readonly listeners = new Set<UsageLimitListener>()

  /** Subscribe to provider data changes; returns an unsubscribe function. */
  subscribe(listener: UsageLimitListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The latest report for a provider, or null (also under a no-data verdict). */
  get(providerId: string): ChatUsageReport | null {
    return this.providers.get(providerId)?.report ?? null
  }

  /**
   * Claim this provider's one usage pull: true only when no pull has been
   * claimed and the provider holds neither a report nor a no-data verdict.
   * Design D1 — the pull is gap-filling, not a poll, and a provider that
   * reports nothing must not pay a control round-trip on every turn.
   */
  claimPull(providerId: string): boolean {
    const state = this.state(providerId)
    if (state.pullClaimed || state.report !== null || state.noDataAt !== null) {
      return false
    }
    state.pullClaimed = true
    return true
  }

  /**
   * Record a captured report (push or pull). A windowless report keeps the
   * windows already held (spec: a report without window data must not replace
   * it) and always clears a no-data verdict; an older report never overwrites
   * a newer one.
   */
  record(providerId: string, report: ChatUsageReport): void {
    const state = this.state(providerId)
    if (
      state.report &&
      Date.parse(state.report.receivedAt) > Date.parse(report.receivedAt)
    ) {
      return
    }
    const windows =
      report.windows.length > 0 ? report.windows : (state.report?.windows ?? [])
    const next = { ...report, windows }
    const changed = JSON.stringify(state.report) !== JSON.stringify(next)
    state.report = next
    state.noDataAt = null
    if (changed) this.notify(providerId)
  }

  /**
   * Record that no usage data could be obtained for a provider. Never
   * displaces a report that already landed (the pull raced a push).
   */
  recordNoData(providerId: string, at: string = new Date().toISOString()): void {
    const state = this.state(providerId)
    if (state.report !== null || state.noDataAt !== null) return
    state.noDataAt = at
    this.notify(providerId)
  }

  /**
   * Record the authoritative no-data verdict of a pull that succeeded but
   * carried no meters (an OpenRouter key whose cap was removed): the report
   * held is dropped, so stale meters do not outlive the key's limit, and the
   * verdict stands until a later record replaces it. With nothing held it
   * behaves exactly like recordNoData; an older pull never displaces newer
   * held data, mirroring record's ordering guard.
   */
  clearAndRecordNoData(providerId: string, at: string = new Date().toISOString()): void {
    const state = this.state(providerId)
    if (state.report && Date.parse(state.report.receivedAt) > Date.parse(at)) return
    // A verdict already standing over nothing held: recordNoData's no-op.
    if (state.report === null && state.noDataAt !== null) return
    state.report = null
    state.noDataAt = at
    this.notify(providerId)
  }

  private state(providerId: string): UsageLimitState {
    let state = this.providers.get(providerId)
    if (!state) {
      state = { report: null, noDataAt: null, pullClaimed: false }
      this.providers.set(providerId, state)
    }
    return state
  }

  private notify(providerId: string): void {
    const report = this.get(providerId)
    for (const listener of this.listeners) {
      listener(providerId, report)
    }
  }
}

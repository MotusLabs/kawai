// The incident advice service (process-quota-history-and-incident-advice
// D5/D6, tasks 4.2–4.4): records each incident episode once, then evaluates
// it off a coalescing queue — after the incident commits, after quota history
// for its team is written, and after a limit or reset update — publishing
// within the five-second target (one second of coalescing). The first
// assessment reads evidence at the incident cutoff; later ones read it at
// their evaluation time, so evidence that arrives after the incident makes a
// new version and never rewrites the first (E7, R3); a first assessment made
// after its cutoff enqueues that next version itself.
//
// Failures stay local: an evaluator error records a health gap and returns
// (R4) — managed work never waits on advice. At startup every unresolved
// recommendation and every one not yet assessed by this evaluator version is
// enqueued once (R5; recovery-matrix row), with no age cutoff. Nothing here
// routes, switches, approves or sends mail (X3): its only writes are its own
// tables, and `onChange` lets the Metrics snapshot republish.
import { logger } from '../../logger'
import type { ProcessAssessment } from '../../../shared/processRecommendations'
import type { HeadroomLimit } from '../observations/headroom'
import type { QuotaObservationStore } from '../observations/quotaObservations'
import { assessmentState, evaluateIncident } from './evaluator'
import type { NewRecommendation, RecommendationStore, StoredRecommendation } from './store'

export const ADVICE_COALESCE_MS = 1_000

export interface AdviceServiceDeps {
  store: RecommendationStore
  history: Pick<QuotaObservationStore, 'list'>
  /** Limit events of these providers (any window, final or not), oldest first. */
  limitsFor: (providerIds: string[]) => Array<HeadroomLimit & { id: string }>
  /** Whether the incident is still in force at `cutoff` (epoch ms). */
  isOpen: (rec: StoredRecommendation, cutoff: number) => boolean
  /** The team's observed comparisons (delivered limit handoffs) at or before `cutoffIso`. */
  comparisons: (teamId: string, cutoffIso: string) => number
  /** An assessment was written for the team. */
  onChange?: (teamId: string) => void
  now?: () => number
  coalesceMs?: number
  /** Test seam: the evaluator (production: `evaluateIncident`). */
  evaluate?: typeof evaluateIncident
}

export class ProcessAdviceService {
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly deps: AdviceServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Record an incident episode (once per team, kind and key) and enqueue its evaluation. */
  incident(input: NewRecommendation): StoredRecommendation | null {
    if (this.stopped) return null
    try {
      const { recommendation } = this.deps.store.create(input)
      this.enqueue(recommendation.id)
      return recommendation
    } catch (error) {
      this.deps.store.recordGap(input.teamId, input.episodeKey, errorKind(error))
      logger.warn('process_advice_incident_failed', { kind: input.kind, error: errorKind(error) })
      return null
    }
  }

  enqueue(recommendationId: string): void {
    if (this.stopped) return
    this.pending.add(recommendationId)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, this.deps.coalesceMs ?? ADVICE_COALESCE_MS)
    this.timer.unref?.()
  }

  /** Re-evaluate the team's unresolved recommendations (quota history or limits changed). */
  enqueueTeam(teamId: string): void {
    if (this.stopped) return
    try {
      for (const rec of this.deps.store.unresolved()) if (rec.teamId === teamId) this.enqueue(rec.id)
    } catch (error) {
      logger.warn('process_advice_enqueue_failed', { error: errorKind(error) })
    }
  }

  /** Startup reconciliation: every unresolved or unassessed recommendation, once (R5). */
  reconcile(): number {
    if (this.stopped) return 0
    const ids = new Set([...this.deps.store.unevaluated(), ...this.deps.store.unresolved()].map(rec => rec.id))
    for (const id of ids) this.enqueue(id)
    return ids.size
  }

  /** Evaluate everything pending now. */
  drain(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const ids = [...this.pending]
    this.pending.clear()
    for (const id of ids) this.evaluate(id)
  }

  /** One evaluation; never throws (R4). Returns the assessment written, or null. */
  evaluate(recommendationId: string): ProcessAssessment | null {
    if (this.stopped) return null
    const rec = this.deps.store.byId(recommendationId)
    if (!rec) return null
    try {
      const first = this.deps.store.latest(rec.id) === null
      const cutoff = first ? Date.parse(rec.cutoff) : Math.max(Date.parse(rec.cutoff), this.now())
      const cutoffIso = new Date(cutoff).toISOString()
      const providers = [...new Set([rec.snapshot.limited.providerId, ...rec.snapshot.candidates.map(candidate => candidate.providerId)])]
      const evaluation = (this.deps.evaluate ?? evaluateIncident)({
        kind: rec.kind,
        snapshot: rec.snapshot,
        cutoff,
        observations: this.deps.history.list(rec.teamId, { until: cutoffIso }),
        limits: this.deps.limitsFor(providers),
        open: this.deps.isOpen(rec, cutoff),
        comparisons: this.deps.comparisons(rec.teamId, cutoffIso),
      })
      const written = this.deps.store.append(rec.id, evaluation, cutoffIso, previous => assessmentState(previous, evaluation.advice))
      if (written) this.deps.onChange?.(rec.teamId)
      // A first assessment made late (a restart, the coalescing wait) froze the
      // incident-time facts; evidence that arrived since gets its own version
      // on the next pass instead of waiting for another trigger.
      if (written && first && cutoff < this.now()) this.enqueue(rec.id)
      return written
    } catch (error) {
      this.deps.store.recordGap(rec.teamId, rec.episodeKey, errorKind(error))
      logger.warn('process_advice_evaluation_failed', { recommendationId: rec.id, error: errorKind(error) })
      return null
    }
  }

  shutdown(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}

/** An error's class name only: messages may carry provider text (I2). */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown'
}

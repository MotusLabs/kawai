// Failure isolation and throttled collection health (process-observability
// D10). Every collection step runs through `safe`, so an operational callback
// (a turn, a mailbox settlement, an acceptance) never receives an error from
// recording. Health checkpoints are written at most once per second, and at
// once when a failure streak ends: the streak's failures are added to the
// durable count and its span is recorded as a `gap`.
import { logger } from '../../logger'
import type { ProcessObservation } from '../../../shared/processObservations'
import { ObservationStore } from './store'

export class ObservationRecorder {
  failures = 0
  private failedSince: string | null = null
  private pendingFailures = 0
  private healthWrittenAt: number | null = null

  constructor(readonly store: ObservationStore) {
    try {
      this.failures = Number(store.checkpoint('recording-failures') ?? 0)
    } catch {
      // Core operation survives collection storage failure.
    }
  }

  safe<T>(work: () => T): T | undefined {
    try {
      const result = work()
      const timestamp = this.store.now()
      const due =
        this.failedSince !== null ||
        this.healthWrittenAt === null ||
        timestamp < this.healthWrittenAt ||
        timestamp - this.healthWrittenAt >= 1000
      if (due) this.writeHealth(timestamp)
      return result
    } catch {
      this.failures++
      this.pendingFailures++
      this.failedSince ??= new Date(this.store.now()).toISOString()
      logger.warn('process_observation_record_failed', { failures: this.failures })
      return undefined
    }
  }

  record(input: ProcessObservation): void {
    this.safe(() => this.store.record(input))
  }

  get gapSince(): string | null {
    return this.failedSince
  }

  private writeHealth(timestamp: number): void {
    const now = new Date(timestamp).toISOString()
    const failures = this.pendingFailures
    const since = this.failedSince
    this.store.db.transaction(() => {
      if (failures) {
        const previous = Number(this.store.checkpoint('recording-failures') ?? 0)
        this.store.setCheckpoint('recording-failures', String(previous + failures))
      }
      if (since) {
        this.store.record({
          sourceKey: `gap:${crypto.randomUUID()}`,
          kind: 'gap',
          observedAt: now,
          data: { since, until: now, source: 'recorder' },
        })
      }
      if (!this.store.checkpoint('recording-start')) this.store.setCheckpoint('recording-start', now)
      this.store.setCheckpoint('last-success', now)
    })()
    this.pendingFailures -= failures
    this.failedSince = null
    this.healthWrittenAt = timestamp
  }
}

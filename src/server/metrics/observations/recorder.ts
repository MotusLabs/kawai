// Failure isolation and throttled collection health; operational callbacks never receive an error.
import { logger } from '../../logger';
import { ObservationStore } from './store';
import type { ProcessObservation } from '../../../shared/processObservations';
export class ObservationRecorder {
  failures = 0;
  private failedSince: string | null = null;
  private pendingFailures = 0;
  private healthWrittenAt: number | null = null;
  constructor(readonly store: ObservationStore) {
    try {
      this.failures = Number(store.checkpoint('recording-failures') ?? 0);
    }
    catch { /* Core operation survives collection storage failure. */ }
  }
  safe<T>(work: () => T): T | undefined {
    try {
      const result = work(), timestamp = this.store.now();
      if (this.failedSince || this.healthWrittenAt === null || timestamp < this.healthWrittenAt || timestamp - this.healthWrittenAt >= 1000) {
        const now = new Date(timestamp).toISOString(), failures = this.pendingFailures, since = this.failedSince;
        this.store.db.transaction(() => {
          if (failures) {
            const previous = Number(this.store.checkpoint('recording-failures') ?? 0);
            this.store.setCheckpoint('recording-failures', String(previous + failures));
          }
          if (since)
            this.store.record({ sourceKey: `gap:${crypto.randomUUID()}`, kind: 'gap', observedAt: now, data: { since, until: now, source: 'recorder' } });
          if (!this.store.checkpoint('recording-start'))
            this.store.setCheckpoint('recording-start', now);
          this.store.setCheckpoint('last-success', now);
        })();
        this.pendingFailures -= failures;
        this.failedSince = null;
        this.healthWrittenAt = timestamp;
      }
      return result;
    }
    catch {
      this.failures++;
      this.pendingFailures++;
      this.failedSince ??= new Date(this.store.now()).toISOString();
      logger.warn('process_observation_record_failed', { failures: this.failures });
      return undefined;
    }
  }
  record(input: ProcessObservation): void { this.safe(() => this.store.record(input)); }
  get gapSince(): string | null { return this.failedSince; }
}

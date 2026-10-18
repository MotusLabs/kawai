// Process observation collection lifecycle (process-observability D2/D10):
// owns the store, the failure-isolating recorder, the durable-source
// reconciler, and the managed-chat tracker. Post-commit subscriptions
// coalesce into one reconcile pass; a 30-second tick checkpoints live turns,
// reconciles, and prunes detail in bounded batches. No network or model call
// is ever made here.
import type { Database } from 'bun:sqlite'
import {
  SOURCE_NAMES,
  type MeasurementSource,
  type ObservationIdentity,
  type SourceState,
} from '../../../shared/processObservations'
import { ExportAccumulator } from '../export/accumulator'
import { ChatObservationTracker } from './chatTracker'
import { ObservationReconciler } from './reconcile'
import { ObservationRecorder } from './recorder'
import { ObservationStore } from './store'

const TICK_MS = 30000
const PRUNE_INTERVAL_MS = 3600000
const PRUNE_BATCH = 500

export class ProcessObservationService {
  readonly store: ObservationStore
  readonly recorder: ObservationRecorder
  readonly reconcile: ObservationReconciler
  readonly chat: ChatObservationTracker
  readonly sources: Record<MeasurementSource, SourceState> = {
    task: 'available',
    'managed-turn': 'available',
    'structured-context': 'available',
    'canonical-stage': 'awaiting-integration',
    'provider-quota': 'awaiting-integration',
    'canonical-incident': 'awaiting-integration',
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly releases: (() => void)[] = []
  private readonly tasks = new Set<string>()
  private queued = false
  private stopped = false

  constructor(db: Database, identity: (id: string) => ObservationIdentity, now: () => number = Date.now) {
    this.store = new ObservationStore(db, now)
    this.recorder = new ObservationRecorder(this.store)
    let accumulator: ExportAccumulator | undefined
    this.store.accumulate = row => {
      try {
        accumulator ??= new ExportAccumulator(db)
        accumulator.observe(row)
      } catch (error) {
        accumulator = undefined
        throw error
      }
    }
    this.reconcile = new ObservationReconciler(db, this.recorder)
    this.chat = new ChatObservationTracker(this.recorder, identity)
  }

  start(subscriptions: ((notify: (taskId?: string) => void) => () => void)[] = []): void {
    this.chat.recover()
    for (const subscribe of subscriptions) {
      this.releases.push(subscribe(taskId => this.notify(taskId)))
    }
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  notify(taskId?: string): void {
    if (this.stopped) return
    if (taskId) this.tasks.add(taskId)
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (this.stopped) return
      for (const id of this.tasks) this.reconcile.task(id)
      this.tasks.clear()
      this.reconcile.run()
    })
  }

  tick(): void {
    this.chat.checkpoint()
    this.reconcile.run()
    this.recorder.safe(() => {
      const previous = Number(this.store.checkpoint('last-prune') ?? 0)
      if (this.store.now() - previous < PRUNE_INTERVAL_MS) return
      const removed = this.store.prune()
      // Drain a backlog in bounded later ticks, without a synchronous loop.
      if (removed < PRUNE_BATCH) this.store.setCheckpoint('last-prune', String(this.store.now()))
    })
  }

  health() {
    return {
      sources: Object.fromEntries(SOURCE_NAMES.map(source => [source, this.sources[source]])),
      failures: this.recorder.failures,
      gapSince: this.recorder.gapSince,
      lastSuccess: this.store.checkpoint('last-success'),
      recordingStart: this.store.checkpoint('recording-start'),
      retainedSince: this.store.checkpoint('detail-retained-since'),
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const release of this.releases) release()
    this.releases.length = 0
    this.tasks.clear()
  }
}

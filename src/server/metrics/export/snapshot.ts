// Export snapshot (process-observability D9): one consistent read
// transaction renders the accumulated totals plus current gauges — source
// availability, collection health and horizons, open and blocked tasks,
// queued mail, series budget — cached for five seconds. Scraping never polls
// a provider or starts an agent.
import type { ProcessObservationService } from '../observations/service'
import { BoundedLabels } from './boundedLabels'
import { DEFINITION_VERSION } from './registry'
import { renderMetrics, type Sample } from './renderer'

const CACHE_MS = 5000

const TASKS_BY_TEAM = `SELECT team_id,
    sum(status NOT IN ('done','cancelled')) n,
    sum(status='blocked') blocked,
    min(CASE WHEN status NOT IN ('done','cancelled') THEN created_at END) oldest
  FROM team_tasks GROUP BY team_id`
const QUEUED_MAIL = `SELECT team_id,state,count(*) n FROM team_messages
  WHERE state IN ('queued','scheduled','awaiting-request','spawning') GROUP BY team_id,state`

type Values = Record<string, string | null | undefined>

export class MetricsSnapshot {
  private cached: { at: number; text: string } | null = null

  constructor(private readonly service: ProcessObservationService) {}

  read(): string {
    const { store } = this.service
    const now = store.now()
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.text
    const text = store.db.transaction(() => {
      const bounds = new BoundedLabels(store.db)
      const gauges = new Map<string, Sample>()
      const gauge = (family: string, values: Values, value: number, combine: 'sum' | 'max' = 'sum') => {
        if (!Number.isFinite(value)) return
        const labels = bounds.labels(family, values)
        const key = family + JSON.stringify(labels)
        const old = gauges.get(key)
        const combined = old ? (combine === 'sum' ? old.value + value : Math.max(old.value, value)) : value
        gauges.set(key, { family, labels, bucket: 'value', value: combined })
      }
      const health = this.service.health()
      for (const [source, state] of Object.entries(health.sources)) {
        gauge('measurement_source_available', { source }, state === 'available' ? 1 : 0)
        const observed = store.checkpoint(`observed:${source}`)
        if (observed) {
          gauge('measurement_source_last_observed_timestamp_seconds', { source }, Date.parse(observed) / 1000)
        }
      }
      gauge('measurement_definition_info', { version: String(DEFINITION_VERSION) }, 1)
      gauge('observation_gap', { collector: 'observations' }, health.gapSince ? 1 : 0)
      gauge('observation_errors_total', { collector: 'observations' }, health.failures)
      const horizons = [
        ['observation_recording_start_timestamp_seconds', health.recordingStart, {}],
        ['observation_detail_retained_since_timestamp_seconds', health.retainedSince, {}],
        ['observations_last_success_timestamp_seconds', health.lastSuccess, { collector: 'observations' }],
      ] as const
      for (const [family, date, values] of horizons) {
        if (date) gauge(family, values, Date.parse(date) / 1000)
      }
      const tasks = store.db.prepare(TASKS_BY_TEAM).all() as {
        team_id: string
        n: number
        blocked: number
        oldest: string | null
      }[]
      for (const row of tasks) {
        gauge('tasks_open', { team: row.team_id, stage: 'unknown' }, row.n)
        gauge('tasks_blocked', { team: row.team_id, reason: 'unknown' }, row.blocked)
        if (row.oldest) {
          const age = Math.max(0, (now - Date.parse(row.oldest)) / 1000)
          gauge('tasks_oldest_age_seconds', { team: row.team_id, stage: 'unknown' }, age, 'max')
        }
      }
      const mail = store.db.prepare(QUEUED_MAIL).all() as { team_id: string; state: string; n: number }[]
      for (const row of mail) gauge('mail_queued', { team: row.team_id, reason: row.state }, row.n)
      gauge('export_series', {}, bounds.expandedSeries())
      gauge('export_series_budget', {}, bounds.maxSeries)
      const totals = (
        store.db
          .prepare("SELECT family,labels,bucket,value FROM process_export_totals WHERE bucket!='admitted'")
          .all() as { family: string; labels: string; bucket: string; value: number }[]
      ).map(row => ({ ...row, labels: JSON.parse(row.labels) }))
      return renderMetrics([...totals, ...gauges.values()])
    })()
    this.cached = { at: now, text }
    return text
  }
}

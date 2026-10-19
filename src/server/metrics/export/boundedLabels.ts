// Bounded export labels (process-observability D8): open-ended dimensions
// (team, group, provider, model, account, window) map to persistent opaque
// aliases up to a per-dimension cap, enumerated labels outside their enum
// read `other`, and admission budgets count every admitted labelset —
// retired values and histogram expansion included — so a scrape never grows
// past its series limit. Every collapse is counted per family.
import type { Database } from 'bun:sqlite'
import { ENUMS, REGISTRY, seriesCost } from './registry'

const CAPS: Record<string, number> = { team: 32, group: 32, provider: 32, model: 64, account: 64, window: 16 }

export type Labels = Record<string, string>

export class BoundedLabels {
  constructor(
    private readonly db: Database,
    readonly maxSeries = 250000,
    private readonly maxFamily = 10000,
  ) {
    this.reserveOverflow()
  }

  expandedSeries(): number {
    const rows = this.db
      .prepare("SELECT family,count(*) n FROM process_export_totals WHERE bucket='admitted' GROUP BY family")
      .all() as { family: string; n: number }[]
    return rows.reduce((n, row) => n + row.n * seriesCost(REGISTRY[row.family]!), 0)
  }

  labels(family: string, values: Record<string, string | null | undefined>): Labels {
    this.reserveOverflow()
    const definition = REGISTRY[family]
    if (!definition) throw Error('Unknown metric family')
    let collapsed = false
    const labels: Labels = {}
    for (const key of definition.labels) {
      const value = values[key]
      if (!value) {
        labels[key] = 'unknown'
        continue
      }
      if (!CAPS[key]) {
        labels[key] = ENUMS[key]?.includes(value) ? value : 'other'
        collapsed ||= labels[key] === 'other'
        continue
      }
      const dimension =
        key === 'group'
          ? `group:${values.team ?? 'unknown'}`
          : key === 'window'
            ? `window:${values.account ?? 'unknown'}`
            : key
      const existing = this.db
        .prepare('SELECT alias FROM process_export_aliases WHERE dimension=? AND original=?')
        .get(dimension, value) as { alias: string } | null
      if (existing) {
        labels[key] = existing.alias
        continue
      }
      const { n: count } = this.db
        .prepare('SELECT count(*) n FROM process_export_aliases WHERE dimension=?')
        .get(dimension) as { n: number }
      // Do not allow unbounded per-team or per-account dimensions after those parents overflow.
      const parentOverflow =
        (key === 'group' && labels.team === 'other') || (key === 'window' && labels.account === 'other')
      if (count >= CAPS[key]! || parentOverflow) {
        labels[key] = 'other'
        collapsed = true
        continue
      }
      labels[key] = `${key}_${count + 1}`
      this.db.prepare('INSERT INTO process_export_aliases VALUES (?,?,?)').run(dimension, value, labels[key]!)
    }
    const encoded = JSON.stringify(labels)
    const admitted = this.db
      .prepare("SELECT 1 FROM process_export_totals WHERE family=? AND labels=? AND bucket='admitted'")
      .get(family, encoded)
    if (!admitted) {
      const { n: count } = this.db
        .prepare("SELECT count(*) n FROM process_export_totals WHERE family=? AND bucket='admitted'")
        .get(family) as { n: number }
      // The bounded diagnostic can add one labelset for each fixed registry family.
      const reserve = Object.keys(REGISTRY).length
      if (count >= this.maxFamily || this.expandedSeries() + seriesCost(definition) + reserve > this.maxSeries) {
        for (const key of definition.labels) labels[key] = 'other'
        collapsed = true
      } else {
        this.admit(family, labels)
      }
    }
    if (collapsed) this.overflow(family)
    return labels
  }

  private reserveOverflow(): void {
    const reserved = this.db
      .prepare(
        "SELECT 1 FROM process_export_totals WHERE family='task_results_total' AND labels=? AND bucket='admitted'",
      )
      .get(JSON.stringify({ team: 'other' }))
    if (reserved) return
    // Reserve one catch-all per family, so overflow never needs additional series.
    for (const [family, definition] of Object.entries(REGISTRY)) {
      this.admit(family, Object.fromEntries(definition.labels.map(key => [key, 'other'])))
    }
  }

  private admit(family: string, labels: Labels): void {
    this.db
      .prepare("INSERT OR IGNORE INTO process_export_totals VALUES (?,?,'admitted',0)")
      .run(family, JSON.stringify(labels))
  }

  private overflow(family: string): void {
    const labels = JSON.stringify({ family })
    this.admit('export_label_overflow_total', { family })
    this.db
      .prepare(
        "INSERT INTO process_export_totals VALUES ('export_label_overflow_total',?,'value',1) ON CONFLICT(family,labels,bucket) DO UPDATE SET value=value+1",
      )
      .run(labels)
  }
}

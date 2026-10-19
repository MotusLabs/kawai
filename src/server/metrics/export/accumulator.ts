// Export totals (process-observability D8): folds each stored observation
// into the bounded counter and histogram totals of the export registry. All
// writes run inside ObservationStore.record's transaction, so a fact and its
// totals commit together; detail pruning never alters totals. Also advances
// the newest observed time per measurement source.
import type { Database } from 'bun:sqlite'
import type { StoredObservation } from '../../../shared/processObservations'
import { BoundedLabels } from './boundedLabels'
import { REGISTRY } from './registry'

const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheCreation']
const CONTEXT_FAMILIES = [
  ['usedTokens', 'agent_context_tokens'],
  ['thresholdTokens', 'agent_context_threshold_tokens'],
] as const
const MANAGED_TURN_KINDS = [
  'turn_started',
  'turn_attribution',
  'turn_ended',
  'activity',
  'tool',
  'request',
  'usage',
  'settings',
]

export class ExportAccumulator {
  readonly bounds: BoundedLabels

  constructor(private readonly db: Database) {
    this.bounds = new BoundedLabels(db)
  }

  add(family: string, values: Record<string, string | null | undefined>, value: number): void {
    if (!Number.isFinite(value) || value < 0) return
    const definition = REGISTRY[family]!
    const labels = JSON.stringify(this.bounds.labels(family, values))
    const increment = (bucket: string, amount: number) =>
      this.db
        .prepare(
          'INSERT INTO process_export_totals VALUES (?,?,?,?) ON CONFLICT(family,labels,bucket) DO UPDATE SET value=value+excluded.value',
        )
        .run(family, labels, bucket, amount)
    if (definition.type === 'counter') {
      increment('value', value)
    } else if (definition.type === 'histogram') {
      increment('count', 1)
      increment('sum', value)
      for (const bucket of definition.buckets!) {
        if (value <= bucket) increment(String(bucket), 1)
      }
    }
  }

  observe(row: StoredObservation): void {
    const labels = { team: row.teamId, group: row.groupId, provider: row.providerId, model: row.model }
    const d = row.data
    switch (row.kind) {
      case 'acceptance':
        if (d.first === true && typeof d.durationSeconds === 'number') {
          this.add(
            'task_acceptance_duration_seconds',
            { team: row.teamId, mechanism: String(d.mechanism) },
            d.durationSeconds,
          )
        }
        break
      case 'turn_ended':
        if (d.partial !== true && typeof d.durationSeconds === 'number') {
          this.add('agent_turn_duration_seconds', { ...labels, outcome: String(d.outcome) }, d.durationSeconds)
        }
        break
      case 'usage':
        for (const kind of TOKEN_KINDS) {
          if (typeof d[kind] !== 'number') continue
          this.add('agent_tokens_total', { ...labels, kind }, d[kind] as number)
          this.add('agent_turn_tokens', { ...labels, kind }, d[kind] as number)
        }
        break
      case 'context':
        for (const [field, family] of CONTEXT_FAMILIES) {
          if (typeof d[field] === 'number') {
            this.add(family, { ...labels, approximate: String(d.approximate) }, d[field] as number)
          }
        }
        break
      case 'compaction': {
        const dims = { team: row.teamId, provider: row.providerId, model: row.model, trigger: String(d.trigger) }
        if (d.outcome === 'started') break
        this.add('agent_compactions_total', { ...dims, outcome: String(d.outcome) }, 1)
        if (typeof d.durationSeconds === 'number') {
          this.add('agent_compaction_duration_seconds', dims, d.durationSeconds)
        }
        break
      }
      case 'result':
        this.add('task_results_total', { team: row.teamId }, 1)
        break
      case 'finding':
        this.add('review_findings_total', { team: row.teamId, verdict: String(d.verdict) }, 1)
        break
      case 'status':
        if (d.from === 'done' && d.to !== 'done') this.add('task_reopens_total', { team: row.teamId }, 1)
        break
    }
    const source = this.source(row.kind)
    if (!source) return
    this.db
      .prepare(
        'INSERT INTO process_collection_checkpoints VALUES (?,?) ON CONFLICT(source) DO UPDATE SET value=max(value,excluded.value)',
      )
      .run(`observed:${source}`, row.observedAt)
  }

  private source(kind: string): string | null {
    if (kind === 'gap' || kind === 'limit') return null
    if (kind === 'context' || kind === 'compaction') return 'structured-context'
    if (MANAGED_TURN_KINDS.includes(kind)) return 'managed-turn'
    return 'task'
  }
}

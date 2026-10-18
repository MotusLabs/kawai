// Export metric registry (process-observability D8): version 1 definitions
// of every exported family — type, help, label set, histogram buckets — plus
// the enumerated label values and each definition's expanded series cost.
// Incompatible semantics require a new metric name, never a replay.
export const DEFINITION_VERSION = 1
export const DURATION_BUCKETS = [1, 5, 15, 60, 300, 900, 3600, 14400, 86400, 604800, Infinity]
export const TOKEN_BUCKETS = [1000, 4000, 16000, 64000, 128000, 256000, 1000000, Infinity]

export interface MetricDefinition {
  type: 'counter' | 'histogram' | 'gauge'
  help: string
  labels: readonly string[]
  buckets?: readonly number[]
}

const turn = ['team', 'group', 'provider', 'model']
const compaction = ['team', 'provider', 'model']
const quota = ['account', 'provider', 'window', 'model']

const histogram = (help: string, labels: string[], buckets = DURATION_BUCKETS): MetricDefinition => ({
  type: 'histogram',
  help,
  labels,
  buckets,
})
const gauge = (help: string, labels: string[] = []): MetricDefinition => ({ type: 'gauge', help, labels })
const counter = (help: string, labels: string[]): MetricDefinition => ({ type: 'counter', help, labels })

export const REGISTRY: Record<string, MetricDefinition> = {
  task_acceptance_duration_seconds: histogram('Creation to first recorded acceptance in seconds.', [
    'team',
    'mechanism',
  ]),
  task_stage_duration_seconds: histogram('Canonical task stage duration in seconds.', ['team', 'stage', 'state']),
  agent_turn_duration_seconds: histogram(
    'Observed managed turn duration in seconds; partial turns excluded.',
    [...turn, 'outcome'],
  ),
  agent_turn_tokens: histogram(
    'Completed main-loop turn tokens; missing and subagent usage excluded.',
    [...turn, 'kind'],
    TOKEN_BUCKETS,
  ),
  agent_tokens_total: counter('Completed main-loop tokens by token kind.', [...turn, 'kind']),
  agent_compactions_total: counter('Observed structured compaction boundaries.', [
    ...compaction,
    'trigger',
    'outcome',
  ]),
  agent_compaction_duration_seconds: histogram('Compaction duration only where start and end were observed.', [
    ...compaction,
    'trigger',
  ]),
  agent_context_tokens: histogram(
    'Sampled context tokens, at most once per minute plus exact boundaries.',
    [...turn, 'approximate'],
    TOKEN_BUCKETS,
  ),
  agent_context_threshold_tokens: histogram(
    'Observed context threshold tokens, including explicit approximate fallbacks.',
    [...turn, 'approximate'],
    TOKEN_BUCKETS,
  ),
  limit_incidents_total: counter('Canonical limit incidents; raw retry signals are not incidents.', [
    ...compaction,
    'kind',
  ]),
  task_results_total: counter('Submitted task results.', ['team']),
  review_findings_total: counter('Review findings by recorded verdict.', ['team', 'verdict']),
  task_reopens_total: counter('Task transitions out of done.', ['team']),
  tasks_open: gauge('Current unfinished task count; canonical stage unknown until adapter installed.', [
    'team',
    'stage',
  ]),
  tasks_oldest_age_seconds: gauge('Age of oldest unfinished task in seconds.', ['team', 'stage']),
  tasks_blocked: gauge('Current blocked tasks; blocker unknown without canonical adapter.', ['team', 'reason']),
  mail_queued: gauge('Current queued or scheduled mail by stored queue state.', ['team', 'reason']),
  provider_quota_used_ratio: gauge('Observed account quota used ratio.', quota),
  provider_quota_observed_timestamp_seconds: gauge('Original quota observation timestamp.', quota),
  provider_quota_reset_timestamp_seconds: gauge('Observed quota reset timestamp.', quota),
  provider_quota_fresh: gauge('Whether account quota evidence is fresh.', quota),
  observation_errors_total: counter('Collection errors; counting resumes after storage recovery.', ['collector']),
  observations_last_success_timestamp_seconds: gauge('Last successful collection timestamp.', ['collector']),
  measurement_source_available: gauge('Installed usable source capability, independent of whether data exists.', [
    'source',
  ]),
  measurement_source_last_observed_timestamp_seconds: gauge('Latest actually observed fact for a source.', [
    'source',
  ]),
  measurement_definition_info: gauge('Installed observation and metric definition version.', ['version']),
  observation_recording_start_timestamp_seconds: gauge('Start of this database collection horizon.'),
  observation_detail_retained_since_timestamp_seconds: gauge('Conservative detailed observation retention horizon.'),
  observation_gap: gauge('Whether a recording failure is currently unresolved.', ['collector']),
  export_label_overflow_total: counter('Collapsed label dimensions or family labelsets.', ['family']),
  export_series: gauge('Admitted expanded series, including reserved overflow labelsets.'),
  export_series_budget: gauge('Hard budget for expanded exported series.'),
}

export const ENUMS: Record<string, readonly string[]> = {
  mechanism: ['integration-landing', 'direct-landing', 'manual', 'creator', 'unknown-legacy'],
  outcome: ['success', 'failed', 'interrupted', 'process-ended', 'completed', 'unavailable'],
  trigger: ['auto', 'manual', 'unknown'],
  kind: ['input', 'output', 'cacheRead', 'cacheCreation', 'quota', 'context'],
  approximate: ['true', 'false'],
  verdict: ['pass', 'fail', 'approve', 'request-changes', 'comment'],
  reason: ['unknown', 'queued', 'scheduled', 'awaiting-request', 'spawning'],
  stage: ['unknown'],
  state: ['unknown'],
  collector: ['observations'],
  source: [
    'task',
    'managed-turn',
    'structured-context',
    'canonical-stage',
    'provider-quota',
    'canonical-incident',
  ],
  version: [String(DEFINITION_VERSION)],
  family: Object.keys(REGISTRY),
}

export const seriesCost = (definition: MetricDefinition) =>
  definition.type === 'histogram' ? definition.buckets!.length + 2 : 1

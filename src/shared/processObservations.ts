// The SDK-free process observation contract (process-observability D2): the
// kinds of fact Kawai records, the scalar fields each kind may carry, and the
// identity columns that attribute it. Raw conversation, tool, and provider
// payloads never enter this model — `validateObservation` refuses any field a
// kind does not declare, non-scalar values, invalid numbers, and long text.
export const OBSERVATION_VERSION = 1
/** Fact observations (task, acceptance, usage, turn outcome, …) and completed usage. */
export const OBSERVATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** Intra-turn interval detail: the bulk of the volume, read only for recent turns. */
export const OBSERVATION_INTERVAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

export const OBSERVATION_FIELDS = {
  task: ['revision'],
  status: ['from', 'to', 'actorKind'],
  assignment: ['handoffKind', 'targetKind'],
  result: ['revision'],
  finding: ['verdict', 'reviewKind'],
  acceptance: ['revision', 'actorKind', 'mechanism', 'durationSeconds', 'first'],
  mail: ['transition', 'actorKind'],
  limit: ['final', 'status'],
  usage: ['input', 'output', 'cacheRead', 'cacheCreation', 'steps', 'outcome', 'scope'],
  turn_started: [],
  turn_attribution: [],
  turn_ended: ['outcome', 'durationSeconds', 'partial', 'usageAvailable'],
  activity: ['phase', 'startedAt', 'durationSeconds', 'partial'],
  tool: ['category', 'startedAt', 'durationSeconds', 'outcome', 'partial'],
  request: ['requestKind', 'startedAt', 'durationSeconds', 'outcome', 'partial'],
  context: ['usedTokens', 'thresholdTokens', 'approximate', 'boundary', 'thresholdSource'],
  compaction: ['trigger', 'preTokens', 'postTokens', 'startedAt', 'endedAt', 'durationSeconds', 'outcome'],
  settings: ['effort', 'contextWindow', 'driverVersion', 'thresholdSource'],
  gap: ['since', 'until', 'source'],
} as const

export type ObservationKind = keyof typeof OBSERVATION_FIELDS

/** Kinds pruned after `OBSERVATION_INTERVAL_RETENTION_MS`; every other kind keeps `OBSERVATION_RETENTION_MS`. */
export const INTERVAL_OBSERVATION_KINDS: readonly ObservationKind[] = [
  'activity',
  'tool',
  'request',
  'context',
  'turn_started',
  'turn_attribution',
]
export const FACT_OBSERVATION_KINDS: readonly ObservationKind[] = (
  Object.keys(OBSERVATION_FIELDS) as ObservationKind[]
).filter(kind => !INTERVAL_OBSERVATION_KINDS.includes(kind))
export type Measurement = Record<string, string | number | boolean | null>

export interface ObservationIdentity {
  teamId?: string | null
  taskId?: string | null
  taskRevision?: number | null
  assignmentId?: string | null
  resultId?: string | null
  sessionId?: string | null
  turnId?: string | null
  startId?: string | null
  groupId?: string | null
  profileId?: string | null
  providerId?: string | null
  model?: string | null
  accountRevision?: string | null
  actorSession?: string | null
  toolCallId?: string | null
  requestId?: string | null
}

export interface ProcessObservation extends ObservationIdentity {
  sourceKey: string
  kind: ObservationKind
  observedAt: string
  data: Measurement
}

export interface StoredObservation extends ProcessObservation {
  seq: number
  recordedAt: string
  version: number
}

export const SOURCE_NAMES = [
  'task',
  'managed-turn',
  'structured-context',
  'canonical-stage',
  'provider-quota',
  'canonical-incident',
] as const
export type MeasurementSource = (typeof SOURCE_NAMES)[number]
export type SourceState = 'available' | 'unsupported' | 'awaiting-integration'

/** A fact refused at the boundary; a reconciler skips its source row instead of stalling on it. */
export class InvalidObservationError extends Error {}

/** Reject accidental payload copies, invalid numbers and unreasonable field sizes at the boundary. */
export function validateObservation(row: ProcessObservation): void {
  if (!row.sourceKey || row.sourceKey.length > 1024 || !Number.isFinite(Date.parse(row.observedAt))) {
    throw new InvalidObservationError('Invalid observation identity/time')
  }
  const fields: readonly string[] | undefined = OBSERVATION_FIELDS[row.kind]
  if (!fields) throw new InvalidObservationError('Unknown observation kind')
  for (const [key, value] of Object.entries(row.data)) {
    if (!fields.includes(key)) {
      throw new InvalidObservationError(`Unsupported measurement field: ${key}`)
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new InvalidObservationError('Non-scalar measurement')
    }
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new InvalidObservationError('Invalid measurement number')
    }
    if (typeof value === 'string' && value.length > 128) {
      throw new InvalidObservationError('Measurement text too large')
    }
  }
}

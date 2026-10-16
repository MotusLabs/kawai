// Pure formatting for the Metrics tab (team-process-metrics D5): a value in
// its unit, the baseline delta with which way is better, and the sample note.
// Shared by the rows and their tests so the wording has one source.
import { MIN_SAMPLE, type MetricDef, type MetricStat, type MetricUnit } from '@shared/processMetrics'

const trim = (value: number, digits: number) => Number(value.toFixed(digits)).toString()

export function formatValue(value: number | null, unit: MetricUnit): string {
  if (value === null) return '—'
  switch (unit) {
    case 'hours': return `${trim(value, 1)} h`
    case 'minutes': return `${trim(value, 1)} min`
    case 'share': return `${trim(value * 100, 1)}%`
    case 'count': return trim(value, 2)
    case 'tokens': return Math.round(value).toLocaleString('en-US')
  }
}

/** `+2.5 h vs baseline (worse)`; shares differ in percentage points. Null when either side has no value. */
export function formatDelta(def: MetricDef, current: MetricStat, baseline: MetricStat): string | null {
  if (current.value === null || baseline.value === null) return null
  const diff = current.value - baseline.value
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±'
  const magnitude = def.unit === 'share'
    ? `${trim(Math.abs(diff) * 100, 1)} pp`
    : formatValue(Math.abs(diff), def.unit)
  const verdict = diff === 0 || def.higherIsBetter === null
    ? ''
    : (diff > 0) === def.higherIsBetter ? ' (better)' : ' (worse)'
  return `${sign}${magnitude} vs baseline${verdict}`
}

export function baselineLabel(def: MetricDef, baseline: MetricStat): string {
  return baseline.value === null ? 'no baseline' : `baseline ${formatValue(baseline.value, def.unit)} (n=${baseline.n})`
}

export const insufficientLabel = (stat: MetricStat): string | null =>
  stat.insufficient ? `insufficient sample (n=${stat.n} < ${MIN_SAMPLE})` : null

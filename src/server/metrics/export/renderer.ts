// Pure Prometheus text format 0.0.4; no runtime, SDK, database or network dependency.
import { REGISTRY } from './registry';
export interface Sample {
  family: string;
  labels: Record<string, string>;
  bucket: string;
  value: number;
}
const escaped = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (values: Record<string, string>) => Object.keys(values).length ? `{${Object.entries(values).map(([key, value]) => `${key}="${escaped(value)}"`).join(',')}}` : '';
export function renderMetrics(samples: readonly Sample[]): string {
  const lines: string[] = [];
  for (const [family, definition] of Object.entries(REGISTRY)) {
    const rows = samples.filter(row => row.family === family && row.bucket !== 'admitted');
    if (!rows.length)
      continue;
    const name = `kawai_${family}`;
    lines.push(`# HELP ${name} ${definition.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${name} ${definition.type}`);
    if (definition.type === 'histogram') {
      const sets = new Map<string, {
        labels: Record<string, string>;
        values: Map<string, number>;
      }>();
      for (const row of rows) {
        const key = JSON.stringify(row.labels);
        if (!sets.has(key))
          sets.set(key, { labels: row.labels, values: new Map() });
        sets.get(key)!.values.set(row.bucket, row.value);
      }
      for (const set of sets.values()) {
        if (!set.values.has('count'))
          continue;
        for (const bucket of definition.buckets!)
          lines.push(`${name}_bucket${labels({ ...set.labels, le: bucket === Infinity ? '+Inf' : String(bucket) })} ${set.values.get(String(bucket)) ?? 0}`);
        lines.push(`${name}_count${labels(set.labels)} ${set.values.get('count')}`, `${name}_sum${labels(set.labels)} ${set.values.get('sum') ?? 0}`);
      }
    }
    else
      for (const row of rows)
        lines.push(`${name}${labels(row.labels)} ${row.value}`);
  }
  return lines.join('\n') + '\n';
}

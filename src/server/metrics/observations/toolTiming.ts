// One turn's observed tool time: overlapping execution is a union, summed work can exceed it.
import type { StoredObservation } from '../../../shared/processObservations';
type Interval = [
  number,
  number
];
const union = (intervals: Interval[]): Interval[] => {
  const result: Interval[] = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1])
      last[1] = Math.max(last[1], end);
    else
      result.push([start, end]);
  }
  return result;
};
export function observedToolTiming(rows: readonly StoredObservation[]): {
  sumSeconds: number;
  unionSeconds: number;
} {
  const scopes = new Set(rows.map(row => JSON.stringify([row.sessionId, row.turnId])));
  if (scopes.size > 1)
    throw Error('Tool timing requires a single managed turn');
  const intervals = (kind: string): Interval[] => rows.filter(row => row.kind === kind && typeof row.data.durationSeconds === 'number' && typeof row.data.startedAt === 'string')
    .map(row => [Date.parse(String(row.data.startedAt)), Date.parse(row.observedAt)] as Interval).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a);
  const tools = union(intervals('tool')), requests = union(intervals('request'));
  const elapsed = tools.reduce((sum, [a, b]) => sum + b - a, 0);
  const waiting = tools.reduce((sum, [a, b]) => sum + requests.reduce((overlap, [x, y]) => overlap + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0), 0);
  return { sumSeconds: rows.filter(row => row.kind === 'tool' && typeof row.data.durationSeconds === 'number').reduce((sum, row) => sum + Number(row.data.durationSeconds), 0), unionSeconds: Math.max(0, elapsed - waiting) / 1000 };
}

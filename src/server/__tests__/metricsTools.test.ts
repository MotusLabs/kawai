// `team_metrics` (team-process-metrics D5): bound to the caller's team (a
// forged team argument is stripped), the same result `computeMetrics` gives,
// unknown windows and slices refused naming what is allowed, registered on
// the team server, and allowed without approval cards. Table T rows T1, T1a,
// T1b, and T9a (bounded-metrics-reads) run through `teamToolTable` under both
// runtimes' registrations on the 300-task fixture (`metricsDrillHarness`).
import { expect, test } from 'bun:test'
import type { MetricValue, ProcessMetrics } from '../../shared/processMetrics'
import { MetricsReader, readMetrics } from '../metrics/computeMetrics'
import { METRICS_TOOL_NAMES, metricsHandlers } from '../metrics/metricsTools'
import type { TeamMailbox } from '../team/TeamMailbox'
import { TEAM_ALLOWED_TOOLS, createMailboxServer } from '../team/mailboxTools'
import { END, Seed, TEAM } from './metricsSeed'
import { MAIL_SHARE_MESSAGES, big, useMetricsTools } from './metricsDrillHarness'

const OTHER = '/other/.git'

function setup() {
  const s = new Seed()
  s.task('mine', 3 * 24)
  s.status('mine', 'active', 'done', 24)
  s.task('theirs', 3 * 24, 'open', OTHER)
  s.status('theirs', 'active', 'done', 24, OTHER)
  s.status('theirs', 'done', 'active', 20, OTHER)
  const teams: Record<string, string> = { 'chat-lead': TEAM, 'chat-other': OTHER }
  const deps = { teamOf: (id: string) => teams[id] ?? null, reader: new MetricsReader(s.db, () => END) }
  return { s, deps }
}

test('the tool returns the caller team\'s computeMetrics result and never another team\'s', async () => {
  const { s, deps } = setup()
  const tool = metricsHandlers(deps, 'chat-lead')
  const result = await tool.team_metrics({ window: '7d', team_id: OTHER, teamId: OTHER })
  expect(result).toEqual(readMetrics(s.db, TEAM, '7d', null, END))
  expect(result.teamId).toBe(TEAM)
  expect(result.metrics.find(m => m.id === 'lead_time_p50')!.drill.tasks).toEqual([{ id: 'mine', title: 'mine' }])
  expect(result.usageCaveat).toContain('Task subagents')
  const sliced = await tool.team_metrics({ window: '3d', slice: { kind: 'memoryFile', file: ' MEMORY.md ' } })
  expect(sliced.slice).toEqual({ kind: 'memoryFile', file: 'MEMORY.md' })
  s.db.close()
})

test('unknown windows and slices are refused naming the allowed ones; a team-less session reads nothing', async () => {
  const { s, deps } = setup()
  const tool = metricsHandlers(deps, 'chat-lead')
  await expect(tool.team_metrics({ window: '30d' })).rejects.toThrow('Allowed windows: 1d, 3d, 7d.')
  await expect(tool.team_metrics({ window: '7d', slice: { kind: 'model' } })).rejects.toThrow('Allowed: group, profile, groupFileHash, memoryFile.')
  await expect(tool.team_metrics({ window: '7d', slice: { kind: 'memoryFile' } })).rejects.toThrow('needs file')
  await expect(metricsHandlers(deps, 'chat-nobody').team_metrics({ window: '7d' })).rejects.toThrow('no team')
  s.db.close()
})

test('team_metrics is registered on the team server and allowed without cards', async () => {
  const { s, deps } = setup()
  for (const name of METRICS_TOOL_NAMES) expect(TEAM_ALLOWED_TOOLS).toContain(`mcp__kawai-team__${name}`)
  const server = await createMailboxServer({} as TeamMailbox, 'chat-lead', { metrics: deps })
  expect(Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools))
    .toContain('team_metrics')
  await server.instance.close()
  s.db.close()
})

test('compact and full use the same status while compact bounds large drills without mutating cached numerics',async()=>{
  const {s,deps}=setup()
  try{
    for(let i=0;i<80;i++){
      const id='long-'+i+'x'.repeat(500)
      s.task(id,72);s.status(id,'active','done',24)
    }
    const tool=metricsHandlers(deps,'chat-lead')
    const full=await tool.team_metrics({window:'7d',detail:'full'})
    const before=structuredClone(full)
    const compact=await tool.team_metrics({window:'7d'})
    expect(new TextEncoder().encode(JSON.stringify(compact)).length).toBeLessThan(32000)
    expect(compact.projectionTruncated).toBe(true)
    expect(compact.toolMeasurement).toEqual(full.toolMeasurement)
    expect(full).toEqual(before)
    expect(full.metrics.find(m=>m.id==='lead_time_p50')!.drill.tasks).toHaveLength(81)
    expect(compact.metrics.find(m=>m.id==='lead_time_p50')!.drill.tasks.length).toBeLessThanOrEqual(50)
    expect(await tool.team_metrics({window:'7d',detail:'full'})).toEqual(full)
  }finally{s.db.close()}
})

const make = useMetricsTools()
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
/** Every value, n, baseline, and flag of a metric: what compaction must keep. */
const numerics = ({ id, value, n, insufficient, baseline, approximate, partial, notSliceable, toolCoverage }: MetricValue) =>
  ({ id, value, n, insufficient, baseline, approximate, partial, notSliceable, toolCoverage })
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value))

// @covers: team-process-metrics › Agents read metrics through a read-only tool › Lead reads its team
// @covers: team-process-metrics › Agents read metrics through a read-only tool › Same values as the tab
// @covers: team-process-metrics › Agents read metrics through a read-only tool › Compact marks shortened lists
test('T1: compact team_metrics 7d is under 32,000 bytes, keeps every value, n, baseline, and flag of a full read, and marks messagesTotal 2,595', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      const compact = await call('chat-lead', 'team_metrics', { window: '7d' })
      const full = await call('chat-lead', 'team_metrics', { window: '7d', detail: 'full' })
      expect(compact.error, runtime).toBeNull()
      const c = compact.value as ProcessMetrics, whole = full.value as ProcessMetrics
      expect(bytes(c), runtime).toBeLessThan(32000)
      expect(c.metrics.map(numerics)).toEqual(whole.metrics.map(numerics))
      expect(c.toolMeasurement).toEqual(whole.toolMeasurement)
      expect([c.periodEnd, c.computedAt]).toEqual([whole.periodEnd, whole.computedAt])
      const mail = c.metrics.find(m => m.id === 'mail_share')!
      expect(mail.drill.messages.length).toBeLessThanOrEqual(50)
      expect(mail.drill.messagesTotal).toBe(MAIL_SHARE_MESSAGES)
      expect(c.projectionTruncated).toBe(true)
      expect(whole.projectionTruncated).toBeUndefined()
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents read metrics through a read-only tool › Full detail is lossless
// @covers: team-process-metrics › The Metrics tab reads metrics whole › Tab keeps the whole drill list
test('T1a: team_metrics detail full deep-equals the tab read of the same key, drill, breakdown, and slices included', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      for (const slice of [null, { kind: 'group' }] as const) {
        await call('chat-lead', 'team_metrics', { window: '7d', ...(slice ? { slice } : {}) })
        const full = await call('chat-lead', 'team_metrics', { window: '7d', detail: 'full', ...(slice ? { slice } : {}) })
        const tab = f.reader.read(TEAM, '7d', slice)
        expect(full.value, runtime).toEqual(roundTrip(tab))
        expect(tab.metrics.find(m => m.id === 'mail_share')!.drill.messages).toHaveLength(MAIL_SHARE_MESSAGES)
      }
    }
  } finally { f.close() }
})

// @covers: team-process-metrics › Agents read metrics through a read-only tool › Measurement status in both details
test('T1b: compact and full team_metrics both carry toolMeasurement.export.state budget-unavailable', async () => {
  const f = make()
  try {
    big(f)
    f.measurement.status = { export: { state: 'budget-unavailable', reason: 'family-budget', availableSince: null },
      recovery: { status: 'ok', quarantinedCount: 0, pendingCount: 0, checkedAt: new Date(END).toISOString() } }
    for (const { runtime, call } of f.runtimes) {
      for (const detail of ['compact', 'full']) {
        const read = await call('chat-lead', 'team_metrics', { window: '7d', detail })
        expect(read.value.toolMeasurement.export.state, `${runtime} ${detail}`).toBe('budget-unavailable')
      }
    }
  } finally { f.close() }
})

test('T9a: two team_metrics reads 1 s apart share one periodEnd; a fresh report submission reads at now, bypassing both caches', async () => {
  const f = make()
  try {
    big(f)
    for (const { runtime, call } of f.runtimes) {
      f.clock.now += 60_000
      const first = await call('chat-lead', 'team_metrics', { window: '7d' })
      f.clock.now += 1000
      const second = await call('chat-lead', 'team_metrics', { window: '7d' })
      expect(second.value.periodEnd, runtime).toBe(first.value.periodEnd)
      expect(first.value.periodEnd).toBe(new Date(f.clock.now - 1000).toISOString())
      const report = await call('chat-lead', 'process_report_submit', { window: '7d', summary: 'Weekly.' })
      expect(report.error, runtime).toBeNull()
      expect(report.value.snapshot.periodEnd).toBe(new Date(f.clock.now).toISOString())
      expect(report.value.periodEnd).toBe(new Date(f.clock.now).toISOString())
    }
  } finally { f.close() }
})

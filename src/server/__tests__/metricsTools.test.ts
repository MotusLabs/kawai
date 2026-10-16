// `team_metrics` (team-process-metrics D5): bound to the caller's team (a
// forged team argument is stripped), the same result `computeMetrics` gives,
// unknown windows and slices refused naming what is allowed, registered on
// the team server, and allowed without approval cards.
import { expect, test } from 'bun:test'
import { MetricsReader, readMetrics } from '../metrics/computeMetrics'
import { METRICS_TOOL_NAMES, metricsHandlers } from '../metrics/metricsTools'
import type { TeamMailbox } from '../team/TeamMailbox'
import { TEAM_ALLOWED_TOOLS, createMailboxServer } from '../team/mailboxTools'
import { END, Seed, TEAM } from './metricsSeed'

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
  expect(result.metrics.find(m => m.id === 'lead_time_p50')!.drill.tasks).toEqual(['mine'])
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

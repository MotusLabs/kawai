// The human's proposal decision over the chat WebSocket (team-process-metrics
// 9.1): accept and reject (with its reason) record the target's latest hash at
// its own granularity; the same key and payload replays the stored decision
// without a write or a re-send; the same key with another decision is refused
// naming the field; a second decision under a new key is refused; another
// team's proposal and an unknown team path are refused; a committed decision
// re-sends subscribers' snapshots, which carry reports, freshness, and the
// window's unproposed changes. Older reports still holding an undecided or
// unlinked accepted proposal stay in the snapshot past the newest 20; any
// other report opens by id and is re-sent on every commit until closed.
import { expect, test } from 'bun:test'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { MetricsReader } from '../metrics/computeMetrics'
import { ProcessReportService, type ReportCaller } from '../metrics/reportService'
import type { GroupDefinition } from '../team/groupFile'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { END, HOUR, Seed, TEAM } from './metricsSeed'

const OTHER = '/other/.git'
type Result = Extract<ServerMessage, { type: 'process-proposal-result' }>
type Snapshot = Extract<ServerMessage, { type: 'process-metrics-snapshot' }>

function reportSetup() {
  const s = new Seed()
  s.manifest('mem-1', { 'MEMORY.md': 'm-a' })
  s.start('chat-rev', 100, { group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-1' })
  s.start('chat-rev', 50, { group: 'reviewers', groupFileHash: 'h-b', memoryHash: 'mem-1' })
  s.start('chat-x', 50, { group: 'reviewers', groupFileHash: 'x-a', team: OTHER })
  let now = END
  const metrics = new MetricsReader(s.db, () => now)
  const teamScopes = { resolve: async (path: string) => (path === '/repo' ? { teamId: TEAM } : path === '/other' ? { teamId: OTHER } : null) }
  let connections: ChatConnections | null = null
  const reports = new ProcessReportService(s.db, metrics, { now: () => now, onCommit: team => connections!.publishMetrics(team) })
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, metrics, reports } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  const send = async (message: ClientMessage) => {
    await connections!.handle(connection, message)
    return messages.at(-1)
  }
  const caller = (teamId: string): ReportCaller => ({
    teamId, sessionId: 'chat-lead', group: { id: 'lead', canReportProcess: true } as GroupDefinition, groupIds: new Set(['lead', 'reviewers']),
  })
  const submit = (teamId = TEAM, proposals = [{
    kind: 'change', target_kind: 'group', target: 'reviewers', edit: 'Ask for tests first.', rationale: 'Fail rate rose.',
    expected: [{ metric: 'finding_fail_rate', direction: 'down' }],
  }]) => reports.submit(caller(teamId), { window: '7d', summary: 'Weekly.', proposals }).proposals[0]!.id
  const results = () => messages.filter((m): m is Result => m.type === 'process-proposal-result')
  const snapshots = () => messages.filter((m): m is Snapshot => m.type === 'process-metrics-snapshot')
  const rows = (table: string) => (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { s, reports, send, submit, caller, messages, results, snapshots, rows, tick: (ms: number) => { now += ms } }
}

const decide = (proposalId: string, decision: 'accepted' | 'rejected', commandId: string, reason?: string, teamPath = '/repo'): ClientMessage =>
  ({ type: 'process-proposal-decide', teamPath, proposalId, decision, commandId, ...(reason === undefined ? {} : { reason }) })

test('accept records the target\'s latest hash and re-sends snapshots with the report and its decision', async () => {
  const { s, send, submit, snapshots, tick } = reportSetup()
  const id = submit()
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null })
  expect(snapshots()[0]!.reports.map(r => r.proposals[0]!.id)).toEqual([id])
  expect(snapshots()[0]!.freshness.find(f => f.window === '7d')!.ageHours).toBe(0)
  expect(snapshots()[0]!.unproposed.map(c => [c.target, c.hash, c.previousHash])).toEqual([['reviewers', 'h-b', 'h-a']])
  tick(HOUR)
  const result = await send(decide(id, 'accepted', 'k-1'))
  expect(result).toEqual({
    type: 'process-proposal-result', teamPath: '/repo', commandId: 'k-1', kind: 'decide', replayed: false,
    decision: { decision: 'accepted', reason: null, targetHashAtDecision: 'h-b', decidedAt: new Date(END + HOUR).toISOString() },
  })
  expect(snapshots()).toHaveLength(2)
  expect(snapshots()[1]!.reports[0]!.proposals[0]!.decision!.decision).toBe('accepted')
  s.db.close()
})

test('reject keeps its reason; a memory target records that file\'s hash', async () => {
  const { s, send, submit } = reportSetup()
  const id = submit(TEAM, [{
    kind: 'change', target_kind: 'memory', target: 'MEMORY.md', edit: 'Trim.', rationale: 'Noise.', expected: [{ metric: 'mail_share', direction: 'down' }],
  }])
  const result = await send(decide(id, 'rejected', 'k-1', '  Not now.  ')) as Result
  expect(result.decision).toMatchObject({ decision: 'rejected', reason: 'Not now.', targetHashAtDecision: 'm-a' })
  s.db.close()
})

test('a replay returns the stored decision without a write or a re-send; a changed payload or second decision is refused', async () => {
  const { s, send, submit, snapshots, rows } = reportSetup()
  const id = submit()
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null })
  const first = await send(decide(id, 'accepted', 'k-1')) as Result
  const replay = await send(decide(id, 'accepted', 'k-1')) as Result
  expect(replay.replayed).toBe(true)
  expect(replay.decision).toEqual(first.decision!)
  expect(snapshots()).toHaveLength(2)
  expect(rows('process_commands')).toBe(1)
  expect((await send(decide(id, 'rejected', 'k-1')) as Result).error).toBe('Command key k-1 was already used with a different decision.')
  expect((await send(decide(id, 'accepted', 'k-1', 'why')) as Result).error).toBe('Command key k-1 was already used with a different reason.')
  expect((await send(decide(id, 'rejected', 'k-2', 'Changed my mind.')) as Result).error).toBe(`Proposal ${id} was already accepted; a decision is final.`)
  expect([rows('process_commands'), rows('process_proposal_decisions'), snapshots().length]).toEqual([1, 1, 2])
  s.db.close()
})

test('another team\'s proposal and an unknown team path are refused with nothing written', async () => {
  const { s, send, submit, rows } = reportSetup()
  const theirs = submit(OTHER)
  expect((await send(decide(theirs, 'accepted', 'k-1')) as Result).error).toBe(`Unknown proposal: ${theirs}`)
  expect((await send(decide(theirs, 'accepted', 'k-2', undefined, '/nowhere')) as Result).error).toContain('/nowhere')
  expect([rows('process_commands'), rows('process_proposal_decisions')]).toEqual([0, 0])
  // The owning team decides it fine, recording its own hash.
  expect((await send(decide(theirs, 'accepted', 'k-1', undefined, '/other')) as Result).decision!.targetHashAtDecision).toBe('x-a')
  s.db.close()
})

test('the proposal commands are listed for the WS router', () => {
  for (const type of ['process-proposal-decide', 'process-proposal-link']) expect(CHAT_CONNECTION_TYPES).toContain(type as never)
})

type Detail = Extract<ServerMessage, { type: 'process-report-detail' }>

test('older reports with work left stay in the snapshot; any other report opens by id and stays current', async () => {
  const { s, reports, send, submit, caller, messages, snapshots, tick } = reportSetup()
  const reportOf = (proposalId: string) => reports.list(TEAM).reports.find(r => r.proposals.some(p => p.id === proposalId))!.id
  const undecided = submit()
  tick(HOUR)
  const rejected = submit()
  await send(decide(rejected, 'rejected', 'k-r', 'Not now.'))
  tick(HOUR)
  const accepted = submit()
  await send(decide(accepted, 'accepted', 'k-a'))
  for (let i = 0; i < 20; i++) {
    tick(HOUR)
    reports.submit(caller(TEAM), { window: '1d', summary: `Day ${i}.` })
  }
  const newest = reports.list(TEAM, 20).reports.map(r => r.id)
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null })
  expect(snapshots().at(-1)!.reports.map(r => r.id)).toEqual([...newest, reportOf(accepted), reportOf(undecided)])

  // The rejected proposal's report left the snapshot; opened by id, it arrives and follows commits.
  const details = () => messages.filter((m): m is Detail => m.type === 'process-report-detail')
  await send({ type: 'process-report-open', teamPath: '/repo', reportId: reportOf(rejected) })
  expect(details().at(-1)).toMatchObject({ teamPath: '/repo', teamId: TEAM, reportId: reportOf(rejected) })
  expect(details().at(-1)!.report!.proposals[0]!.decision!.reason).toBe('Not now.')
  await send(decide(undecided, 'rejected', 'k-u'))
  expect(details()).toHaveLength(2)
  await send({ type: 'process-report-close', teamPath: '/repo', reportId: reportOf(rejected) })
  await send(decide(accepted, 'accepted', 'k-a2'))
  expect(details()).toHaveLength(2)
  s.db.close()
})

test('a report id the team does not have answers null; an unknown team path is refused', async () => {
  const { s, send, submit, reports } = reportSetup()
  submit(OTHER)
  const otherReport = reports.list(OTHER).reports[0]!.id
  expect(await send({ type: 'process-report-open', teamPath: '/repo', reportId: otherReport })).toMatchObject({ type: 'process-report-detail', report: null })
  expect(await send({ type: 'process-report-open', teamPath: '/repo', reportId: 'report-missing' })).toMatchObject({ report: null })
  expect(await send({ type: 'process-report-open', teamPath: '/nowhere', reportId: otherReport })).toMatchObject({ type: 'error' })
  expect(CHAT_CONNECTION_TYPES).toEqual(expect.arrayContaining(['process-report-open', 'process-report-close']))
  s.db.close()
})

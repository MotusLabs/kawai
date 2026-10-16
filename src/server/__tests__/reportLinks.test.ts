// Version changes and implementation links (team-process-metrics 9.2): a
// target's versions derive from its ordered starts (a recurring hash is a new
// change, the first start none); link candidates are the target's changes
// after the decision whose hash qualifies (≠ the decision hash for a change,
// = revert_to_hash for a revert); the human links, replaces, and unlinks by
// command key; a reporting agent only links an accepted, unlinked proposal to
// a candidate; and the whole link history keeps its actors.
import { expect, test } from 'bun:test'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { MetricsReader } from '../metrics/computeMetrics'
import { ProcessReportService, type ReportCaller } from '../metrics/reportService'
import { loadTargetStarts, versionChanges } from '../metrics/versionChanges'
import type { GroupDefinition } from '../team/groupFile'
import type { ServerMessage } from '../../shared/types'
import { END, HOUR, Seed, TEAM } from './metricsSeed'

const lead = (canReportProcess = true): ReportCaller => ({
  teamId: TEAM, sessionId: 'chat-lead', group: { id: 'lead', canReportProcess } as GroupDefinition, groupIds: new Set(['lead', 'devs', 'reviewers']),
})
const effect = [{ metric: 'finding_fail_rate', direction: 'down' }]
const change = (target = 'reviewers', target_kind = 'group') => ({ kind: 'change', target_kind, target, edit: 'E.', rationale: 'R.', expected: effect })

/**
 * reviewers: h-a (100h ago) → h-b (50h ago); decided at END with h-b current;
 * then h-c at END+1h and back to h-a at END+2h. devs: d-a → d-b at END+1h.
 * Memory: MEMORY.md stays m-a while notes.md moves n-a → n-b at END+1h.
 */
function setup() {
  const s = new Seed()
  s.manifest('mem-1', { 'MEMORY.md': 'm-a', 'notes.md': 'n-a' })
  s.manifest('mem-2', { 'MEMORY.md': 'm-a', 'notes.md': 'n-b' })
  s.start('chat-rev', 100, { group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-1' })
  s.start('chat-rev', 50, { id: 'rev-b', group: 'reviewers', groupFileHash: 'h-b', memoryHash: 'mem-1' })
  s.start('chat-dev', 40, { group: 'devs', groupFileHash: 'd-a', memoryHash: 'mem-1' })
  let now = END
  const service = new ProcessReportService(s.db, new MetricsReader(s.db, () => now), { now: () => now })
  const report = service.submit(lead(), { window: '7d', summary: 'S.', proposals: [
    { ...change(), kind: 'revert', revert_to_hash: 'h-a' }, change(), change(), change('MEMORY.md', 'memory'),
  ] })
  const [revert, first, second, memory] = report.proposals.map(p => p.id) as [string, string, string, string]
  for (const [id, n] of [[revert, 1], [first, 2], [second, 3], [memory, 4]] as const) {
    service.decide(TEAM, { proposalId: id, decision: 'accepted', commandId: `d-${n}` })
  }
  s.start('chat-rev', -1, { id: 'rev-c', group: 'reviewers', groupFileHash: 'h-c', memoryHash: 'mem-1' })
  s.start('chat-dev', -1, { id: 'dev-b', group: 'devs', groupFileHash: 'd-b', memoryHash: 'mem-2' })
  s.start('chat-rev', -2, { id: 'rev-a2', group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-2' })
  now = END + 10 * HOUR
  const read = (id: string) => service.report(TEAM, report.id)!.proposals.find(p => p.id === id)!
  return { s, service, read, revert, first, second, memory }
}

test('A → B → A is two version changes; the first start is none; skipped starts say nothing', () => {
  const at = (h: number) => new Date(END - h * HOUR).toISOString()
  const starts = [['s1', 'A', 3], ['s2', 'B', 2], ['s3', 'B', 1.5], ['s4', 'A', 1]].map(([startId, hash, h]) =>
    ({ startId: startId as string, sessionId: 'x', at: at(h as number), hash: hash as string }))
  expect(versionChanges('group', 'g', starts).map(c => [c.startId, c.previousHash, c.hash])).toEqual([['s2', 'A', 'B'], ['s4', 'B', 'A']])
  expect(versionChanges('group', 'g', starts.slice(0, 1))).toEqual([])
  const s = new Seed()
  s.start('chat-a', 3, { group: 'g', groupFileHash: 'A' })
  s.db.prepare(`INSERT INTO agent_starts (id, session_id, team_id, group_id, profile_id, cwd, group_file_hash, unavailable, started_at)
    VALUES ('blind', 'chat-a', ?, 'g', 'default', '/repo', NULL, '["group_file"]', ?)`).run(TEAM, at(2))
  s.start('chat-a', 1, { group: 'g', groupFileHash: 'A' })
  expect(versionChanges('group', 'g', loadTargetStarts(s.db, TEAM).get('group:g')!)).toEqual([])
  s.db.close()
})

test('candidates: a revert takes the post-decision return of its hash; a change any new hash; other targets offer nothing', () => {
  const { s, read, revert, first, memory } = setup()
  expect(read(revert).candidates.map(c => c.startId)).toEqual(['rev-a2'])
  expect(read(first).candidates.map(c => [c.startId, c.hash])).toEqual([['rev-c', 'h-c'], ['rev-a2', 'h-a']])
  // notes.md changed, MEMORY.md did not: nothing implements the MEMORY.md proposal.
  expect(read(memory).candidates).toEqual([])
  s.db.close()
})

test('the revert links to the return of its earlier hash; wrong hashes, other targets, and earlier changes are refused', () => {
  const { s, service, read, revert, first, memory } = setup()
  const link = (proposalId: string, changeStartId: string, commandId: string) => service.linkByHuman(TEAM, { proposalId, changeStartId, commandId })
  expect(() => link(revert, 'rev-c', 'l-1')).toThrow('A revert links only to a change back to h-a; that change loaded h-c.')
  expect(() => link(first, 'dev-b', 'l-1')).toThrow('Start dev-b is not a version change of group reviewers.')
  expect(() => link(first, 'rev-b', 'l-1')).toThrow('That version change of group reviewers happened before the decision.')
  expect(() => link(memory, 'dev-b', 'l-1')).toThrow('Start dev-b is not a version change of memory file MEMORY.md.')
  expect((s.db.prepare('SELECT COUNT(*) AS n FROM process_proposal_link_events').get() as { n: number }).n).toBe(0)
  link(revert, 'rev-a2', 'l-1')
  expect(read(revert).link).toMatchObject({ changeStartId: 'rev-a2', changeHash: 'h-a', actor: { kind: 'human', sessionId: null } })
  // An unrelated group's edit leaves a proposal unimplemented.
  expect(read(first).link).toBeNull()
  s.db.close()
})

test('a change never links to a change that loaded its decision hash', () => {
  const { s, service } = setup()
  const id = service.submit(lead(), { window: '7d', summary: 'S.', proposals: [change()] }).proposals[0]!.id
  service.decide(TEAM, { proposalId: id, decision: 'accepted', commandId: 'late' })
  // Decided at END+10h with h-a current: a later move to h-c qualifies, the return to h-a does not.
  expect(service.report(TEAM, service.store.proposal(TEAM, id)!.reportId)!.proposals[0]!.decision!.targetHashAtDecision).toBe('h-a')
  s.start('chat-rev', -11, { id: 'rev-a3', group: 'reviewers', groupFileHash: 'h-c' })
  s.start('chat-rev', -12, { id: 'rev-a4', group: 'reviewers', groupFileHash: 'h-a' })
  expect(() => service.linkByHuman(TEAM, { proposalId: id, changeStartId: 'rev-a4', commandId: 'x' }))
    .toThrow('That version change loaded the hash at decision (h-a), so it does not implement a change.')
  s.db.close()
})

test('two proposals linked to one change are both marked shared', () => {
  const { s, service, read, first, second } = setup()
  service.linkByHuman(TEAM, { proposalId: first, changeStartId: 'rev-c', commandId: 'l-1' })
  service.linkByHuman(TEAM, { proposalId: second, changeStartId: 'rev-c', commandId: 'l-2' })
  expect(read(first).sharedWith).toEqual([second])
  expect(read(second).sharedWith).toEqual([first])
  service.linkByHuman(TEAM, { proposalId: second, changeStartId: 'rev-a2', commandId: 'l-3' })
  expect(read(first).sharedWith).toEqual([])
  s.db.close()
})

test('an agent links once; relinking, unrights, and unaccepted proposals are refused; replace and unlink keep history', () => {
  const { s, service, read, first } = setup()
  expect(() => service.linkByAgent(lead(false), first, 'rev-c')).toThrow('does not set canReportProcess: true')
  expect(() => service.linkByAgent(lead(), first, 'rev-x')).toThrow('Start rev-x is not a version change')
  expect(service.linkByAgent(lead(), first, 'rev-c').link).toMatchObject({ changeStartId: 'rev-c', actor: { kind: 'agent', sessionId: 'chat-lead' } })
  expect(() => service.linkByAgent(lead(), first, 'rev-a2')).toThrow(`Proposal ${first} is already linked; only the human replaces or removes a link.`)
  service.linkByHuman(TEAM, { proposalId: first, changeStartId: 'rev-a2', commandId: 'r-1' })
  service.linkByHuman(TEAM, { proposalId: first, changeStartId: null, commandId: 'u-1' })
  expect(() => service.linkByHuman(TEAM, { proposalId: first, changeStartId: null, commandId: 'u-2' })).toThrow('has no link to remove')
  const proposal = read(first)
  expect(proposal.link).toBeNull()
  expect(proposal.linkHistory.map(e => [e.action, e.changeStartId, e.actor.kind])).toEqual([
    ['link', 'rev-c', 'agent'], ['replace', 'rev-a2', 'human'], ['unlink', null, 'human'],
  ])
  // A rejected proposal is never linked.
  const rejected = service.submit(lead(), { window: '7d', summary: 'S.', proposals: [change()] }).proposals[0]!.id
  service.decide(TEAM, { proposalId: rejected, decision: 'rejected', commandId: 'rj' })
  expect(() => service.linkByAgent(lead(), rejected, 'rev-c')).toThrow('is not accepted')
  s.db.close()
})

test('the human link command runs over the WebSocket and replays by key', async () => {
  const { s, service, first } = setup()
  const teamScopes = { resolve: async (path: string) => (path === '/repo' ? { teamId: TEAM } : null) }
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, reports: service } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  const link = async (changeStartId: string | null) => {
    await connections.handle(connection, { type: 'process-proposal-link', teamPath: '/repo', proposalId: first, changeStartId, commandId: 'k' })
    return messages.at(-1) as Extract<ServerMessage, { type: 'process-proposal-result' }>
  }
  expect(await link('rev-c')).toMatchObject({ kind: 'link', replayed: false, link: { action: 'link', changeStartId: 'rev-c' } })
  expect(await link('rev-c')).toMatchObject({ replayed: true, link: { action: 'link', changeStartId: 'rev-c' } })
  expect((await link('rev-a2')).error).toBe('Command key k was already used with a different version change.')
  s.db.close()
})

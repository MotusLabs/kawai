// Outcomes and unproposed changes (team-process-metrics 9.3): an implemented
// proposal compares, for each expected metric on its own side, work by starts
// that loaded the decision hash before the linked change with work by starts
// that loaded the linked hash from it on — so a reverted hash's old sessions
// never count as "after"; a metric no target start did (a reviewers proposal
// expecting author-side first-pass yield) compares the team's equal windows,
// labeled not attributed; below the sample floor it reads undetermined. Any
// version change no accepted proposal's current link names is unproposed.
import { expect, test } from 'bun:test'
import { MetricsReader } from '../metrics/computeMetrics'
import { outcomeState } from '../metrics/reportOutcomes'
import { ProcessReportService, type ReportCaller } from '../metrics/reportService'
import type { GroupDefinition } from '../team/groupFile'
import { END, HOUR, Seed, TEAM } from './metricsSeed'

const lead: ReportCaller = {
  teamId: TEAM, sessionId: 'chat-lead', group: { id: 'lead', canReportProcess: true } as GroupDefinition, groupIds: new Set(['reviewers']),
}
const CHANGE_AGO = 48

/** `fails` of `count` reviews by `reviewer`, spread over the 48 h ending `endAgo` hours before END. */
function reviews(s: Seed, reviewer: string, endAgo: number, count: number, fails: number) {
  for (let i = 0; i < count; i++) {
    const at = endAgo + 1 + i * (40 / count)
    const task = s.task(`${reviewer}-${endAgo}-${i}`, at + 2)
    const result = s.result(task, 'chat-dev', at + 1)
    s.finding(task, result, reviewer, i < fails ? 'fail' : 'pass', at)
  }
}

function service(s: Seed) {
  let now = END - 100 * HOUR
  const reports = new ProcessReportService(s.db, new MetricsReader(s.db, () => now), { now: () => now })
  return { reports, at: (hoursAgo: number) => { now = END - hoursAgo * HOUR } }
}

/** reviewers h-a (old sessions) → decided at 100 h ago → h-b from 48 h ago; returns the proposal read at END. */
function changeScenario(before: [number, number], after: [number, number], expected: Array<{ metric: string; direction: string }>) {
  const s = new Seed()
  s.start('chat-r1', 200, { group: 'reviewers', groupFileHash: 'h-a' })
  const { reports, at } = service(s)
  const report = reports.submit(lead, { window: '7d', summary: 'S.', proposals: [
    { kind: 'change', target_kind: 'group', target: 'reviewers', edit: 'E.', rationale: 'R.', expected },
  ] })
  const id = report.proposals[0]!.id
  reports.decide(TEAM, { proposalId: id, decision: 'accepted', commandId: 'd' })
  s.start('chat-r2', CHANGE_AGO, { id: 'rev-b', group: 'reviewers', groupFileHash: 'h-b' })
  reviews(s, 'chat-r1', CHANGE_AGO, ...before)
  reviews(s, 'chat-r2', 0, ...after)
  at(0)
  reports.linkByHuman(TEAM, { proposalId: id, changeStartId: 'rev-b', commandId: 'l' })
  return { s, proposal: reports.report(TEAM, report.id)!.proposals[0]! }
}

test('each outcome state: as expected, opposite, unchanged, undetermined', () => {
  const { s, proposal } = changeScenario([10, 6], [10, 2], [
    { metric: 'finding_fail_rate', direction: 'down' }, { metric: 'finding_fail_rate', direction: 'up' }, { metric: 'reopen_rate', direction: 'down' },
  ])
  expect(proposal.outcome!.map(o => [o.metric, o.state, o.before.n, o.before.value, o.after.n, o.after.value, o.attributed])).toEqual([
    ['finding_fail_rate', 'as-expected', 10, 0.6, 10, 0.2, true],
    ['finding_fail_rate', 'opposite', 10, 0.6, 10, 0.2, true],
    ['reopen_rate', 'undetermined', 0, null, 0, null, false],
  ])
  s.db.close()
  const equal = changeScenario([10, 3], [10, 3], [{ metric: 'finding_fail_rate', direction: 'down' }])
  expect(equal.proposal.outcome![0]!.state).toBe('unchanged')
  equal.s.db.close()
  const thin = changeScenario([10, 6], [9, 0], [{ metric: 'finding_fail_rate', direction: 'down' }])
  expect(thin.proposal.outcome![0]).toMatchObject({ state: 'undetermined', after: { n: 9, insufficient: true } })
  thin.s.db.close()
  expect(outcomeState({ value: 1, n: 10, insufficient: false }, { value: null, n: 0, insufficient: true }, 'up')).toBe('undetermined')
})

test('a reviewers proposal expecting first-pass yield compares the team\'s windows, labeled not attributed', () => {
  const { s, proposal } = changeScenario([10, 6], [10, 2], [{ metric: 'first_pass_yield', direction: 'up' }])
  expect(proposal.outcome).toEqual([{
    metric: 'first_pass_yield', direction: 'up', attributed: false, state: 'as-expected',
    before: { value: 0.4, n: 10, insufficient: false }, after: { value: 0.8, n: 10, insufficient: false },
  }])
  s.db.close()
})

test('a revert counts only work started on the returned hash; old sessions that loaded it before stay out of "after"', () => {
  const s = new Seed()
  s.start('chat-r1', 200, { group: 'reviewers', groupFileHash: 'h-a' })
  s.start('chat-r2', 150, { group: 'reviewers', groupFileHash: 'h-b' })
  const { reports, at } = service(s)
  const report = reports.submit(lead, { window: '7d', summary: 'S.', proposals: [{
    kind: 'revert', target_kind: 'group', target: 'reviewers', edit: 'Back to h-a.', rationale: 'R.', revert_to_hash: 'h-a',
    expected: [{ metric: 'finding_fail_rate', direction: 'down' }],
  }] })
  const id = report.proposals[0]!.id
  reports.decide(TEAM, { proposalId: id, decision: 'accepted', commandId: 'd' })
  s.start('chat-r3', CHANGE_AGO, { id: 'rev-a2', group: 'reviewers', groupFileHash: 'h-a' })
  reviews(s, 'chat-r2', CHANGE_AGO, 10, 5)
  reviews(s, 'chat-r3', 0, 10, 1)
  // chat-r1 loaded h-a long before the decision and keeps failing reviews after the return.
  reviews(s, 'chat-r1', 0, 10, 10)
  reviews(s, 'chat-r1', CHANGE_AGO, 10, 10)
  at(0)
  expect(reports.unproposed(TEAM, '3d').map(c => c.startId)).toEqual(['rev-a2'])
  reports.linkByHuman(TEAM, { proposalId: id, changeStartId: 'rev-a2', commandId: 'l' })
  expect(reports.unproposed(TEAM, '3d')).toEqual([])
  const [outcome] = reports.report(TEAM, report.id)!.proposals[0]!.outcome!
  expect(outcome).toMatchObject({ attributed: true, state: 'as-expected', before: { n: 10, value: 0.5 }, after: { n: 10, value: 0.1 } })
  s.db.close()
})

test('an unlinked edit and an unlinked return to an old hash are both unproposed, per window', () => {
  const s = new Seed()
  s.manifest('mem-1', { 'MEMORY.md': 'm-a' })
  s.manifest('mem-2', { 'MEMORY.md': 'm-b' })
  s.start('chat-r1', 100, { group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-1' })
  s.start('chat-r1', 40, { id: 'edit', group: 'reviewers', groupFileHash: 'h-b', memoryHash: 'mem-1' })
  s.start('chat-r1', 30, { id: 'return', group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-1' })
  s.start('chat-r1', 10, { id: 'memory', group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-2' })
  const { reports, at } = service(s)
  at(0)
  expect(reports.unproposed(TEAM, '3d').map(c => [c.startId, c.targetKind, c.target, c.previousHash, c.hash])).toEqual([
    ['edit', 'group', 'reviewers', 'h-a', 'h-b'], ['return', 'group', 'reviewers', 'h-b', 'h-a'], ['memory', 'memory', 'MEMORY.md', 'm-a', 'm-b'],
  ])
  // A 1d window holds only the memory edit.
  expect(reports.unproposed(TEAM, '1d').map(c => c.startId)).toEqual(['memory'])
  s.db.close()
})

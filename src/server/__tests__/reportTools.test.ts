// Process report tools (team-process-metrics 8.3): submit needs
// `canReportProcess` from the caller's current group; window roles bound the
// proposals; groups, metrics, and directions are validated; a revert hash must
// have been recorded for its target at the target's own granularity (the
// group file hash, or that one memory file's hash); every refusal writes
// nothing; Kawai computes and freezes the snapshot and period whatever the
// summary claims; list/get stay inside the caller's team; and no tool decides,
// applies, withdraws, relinks, or unlinks a proposal.
import { expect, test } from 'bun:test'
import { MetricsReader, readMetrics } from '../metrics/computeMetrics'
import { ProcessReportService, type ReportCaller } from '../metrics/reportService'
import { REPORT_FORBIDDEN_TOOL_NAMES, REPORT_TOOL_NAMES, reportHandlers, type ReportToolDeps } from '../metrics/reportTools'
import type { GroupDefinition } from '../team/groupFile'
import type { TeamMailbox } from '../team/TeamMailbox'
import { TEAM_ALLOWED_TOOLS, createMailboxServer } from '../team/mailboxTools'
import { END, Seed, TEAM } from './metricsSeed'

const OTHER = '/other/.git'
const GROUPS = new Set(['lead', 'devs', 'reviewers'])
const group = (canReportProcess: boolean) => ({ id: 'lead', canReportProcess }) as GroupDefinition

function setup() {
  const s = new Seed()
  // reviewers: h-a → h-b; devs: d-a. Memory: MEMORY.md m-a → m-b, notes.md n-a throughout.
  s.manifest('mem-1', { 'MEMORY.md': 'm-a', 'notes.md': 'n-a' })
  s.manifest('mem-2', { 'MEMORY.md': 'm-b', 'notes.md': 'n-a' })
  s.start('chat-rev', 100, { group: 'reviewers', groupFileHash: 'h-a', memoryHash: 'mem-1' })
  s.start('chat-rev', 50, { group: 'reviewers', groupFileHash: 'h-b', memoryHash: 'mem-2' })
  s.start('chat-dev', 40, { group: 'devs', groupFileHash: 'd-a', memoryHash: 'mem-2' })
  s.task('t1', 3 * 24)
  s.status('t1', 'active', 'done', 24)
  const commits: string[] = []
  const service = new ProcessReportService(s.db, new MetricsReader(s.db, () => END), { now: () => END, onCommit: team => commits.push(team) })
  const callers: Record<string, ReportCaller> = {
    'chat-lead': { teamId: TEAM, sessionId: 'chat-lead', group: group(true), groupIds: GROUPS },
    'chat-dev': { teamId: TEAM, sessionId: 'chat-dev', group: group(false), groupIds: GROUPS },
    'chat-loose': { teamId: TEAM, sessionId: 'chat-loose', group: undefined, groupIds: GROUPS },
    'chat-other': { teamId: OTHER, sessionId: 'chat-other', group: group(true), groupIds: GROUPS },
  }
  const deps: ReportToolDeps = { caller: async id => callers[id] ?? null, service }
  const rows = () => ['process_reports', 'process_proposals', 'process_commands']
    .map(table => (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  return { s, deps, service, commits, rows, tool: (id = 'chat-lead') => reportHandlers(deps, id) }
}

const change = (extra: Record<string, unknown> = {}) => ({
  kind: 'change', target_kind: 'group', target: 'reviewers', edit: 'Ask for tests first.', rationale: 'Fail rate rose.',
  expected: [{ metric: 'finding_fail_rate', direction: 'down' }], ...extra,
})
const revert = (extra: Record<string, unknown> = {}) => change({ kind: 'revert', revert_to_hash: 'h-a', ...extra })

test('submit stores the report with its proposals and a snapshot and period Kawai computed, whatever the summary claims', async () => {
  const { s, tool, commits } = setup()
  const report = await tool().process_report_submit({
    window: '7d', summary: 'Lead time is 0h and every review passed.', proposals: [change(), revert()],
    // Forged fields are stripped: the author, team, period, and snapshot are Kawai's.
    snapshot: { metrics: [] }, period_start: '2000-01-01T00:00:00.000Z', team_id: OTHER, author_session: 'chat-x',
  })
  const expected = readMetrics(s.db, TEAM, '7d', null, END)
  expect(report.snapshot).toEqual(expected)
  expect([report.teamId, report.authorSession, report.window, report.periodStart, report.periodEnd])
    .toEqual([TEAM, 'chat-lead', '7d', expected.periodStart, expected.periodEnd])
  expect(report.summary).toBe('Lead time is 0h and every review passed.')
  expect(report.proposals.map(p => [p.kind, p.target, p.revertToHash, p.decision, p.link])).toEqual([
    ['change', 'reviewers', null, null, null], ['revert', 'reviewers', 'h-a', null, null],
  ])
  expect(commits).toEqual([TEAM])
  // Frozen: later work changes the live metrics, never the stored snapshot.
  s.task('t2', 2 * 24)
  s.status('t2', 'active', 'done', 2)
  const again = await tool().process_report_get({ report_id: report.id })
  expect(again.snapshot).toEqual(expected)
  s.db.close()
})

test('window roles: 1d carries no proposals, 3d only reverts, 7d both', async () => {
  const { s, tool, rows } = setup()
  expect((await tool().process_report_submit({ window: '1d', summary: 'Daily.' })).proposals).toEqual([])
  expect((await tool().process_report_submit({ window: '3d', summary: 'Mid.', proposals: [revert()] })).proposals).toHaveLength(1)
  await expect(tool().process_report_submit({ window: '1d', summary: 'Daily.', proposals: [revert()] }))
    .rejects.toThrow('Proposal 1: A 1d report carries no proposals. Nothing was written.')
  await expect(tool().process_report_submit({ window: '3d', summary: 'Mid.', proposals: [revert(), change()] }))
    .rejects.toThrow('Proposal 2: A 3d report carries only revert proposals.')
  expect(rows()).toEqual([2, 1, 0])
  s.db.close()
})

test('revert hashes are checked at the target\'s own granularity', async () => {
  const { s, tool, rows } = setup()
  // Recorded for that file: accepted.
  const ok = await tool().process_report_submit({ window: '7d', summary: 'S.', proposals: [
    revert({ target_kind: 'memory', target: 'MEMORY.md', revert_to_hash: 'm-a' }),
  ] })
  expect(ok.proposals[0]!.revertToHash).toBe('m-a')
  const before = rows()
  // h-a was recorded, but for reviewers, never for devs.
  await expect(tool().process_report_submit({ window: '7d', summary: 'S.', proposals: [revert({ target: 'devs' })] }))
    .rejects.toThrow('h-a was never recorded as a group file hash of devs.')
  // n-a was recorded for notes.md, never for MEMORY.md; the whole-directory hash is not a file hash either.
  for (const hash of ['n-a', 'mem-1']) {
    await expect(tool().process_report_submit({ window: '7d', summary: 'S.', proposals: [
      revert({ target_kind: 'memory', target: 'MEMORY.md', revert_to_hash: hash }),
    ] })).rejects.toThrow(`${hash} was never recorded as a hash of memory file MEMORY.md.`)
  }
  await expect(tool().process_report_submit({ window: '7d', summary: 'S.', proposals: [revert({ revert_to_hash: 'h-zz' })] }))
    .rejects.toThrow('h-zz was never recorded as a group file hash of reviewers.')
  expect(rows()).toEqual(before)
  s.db.close()
})

test('every refusal names its cause and writes nothing, even after a valid proposal', async () => {
  const { s, tool, rows, commits } = setup()
  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ['chat-dev', { window: '7d', summary: 'S.' }, 'does not set canReportProcess: true'],
    ['chat-loose', { window: '7d', summary: 'S.' }, 'does not set canReportProcess: true'],
    ['chat-lead', { window: '30d', summary: 'S.' }, 'Unknown window "30d". Allowed windows: 1d, 3d, 7d.'],
    ['chat-lead', { window: '7d', summary: '  ' }, 'A report needs a summary.'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ kind: 'apply' })] }, 'Proposal 1: kind must be change or revert, got "apply".'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ target_kind: 'prompt' })] }, 'target_kind must be group or memory'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change(), change({ target: 'qa' })] },
      'Proposal 2: unknown group "qa". Known groups: devs, lead, reviewers.'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ target_kind: 'memory', target: '../CLAUDE.md' })] }, 'one file name inside the shared memory directory'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ target_kind: 'memory', target: '/etc/passwd' })] }, 'one file name inside the shared memory directory'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ edit: ' ' })] }, 'name the proposed edit'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ rationale: '' })] }, 'give a rationale'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ expected: [] })] }, 'name at least one expected effect'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ expected: [{ metric: 'happiness', direction: 'up' }] })] }, 'unknown metric "happiness"'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ expected: [{ metric: 'reopen_rate', direction: 'sideways' }] })] }, 'direction must be up or down'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [change({ revert_to_hash: 'h-a' })] }, 'only a revert names revert_to_hash'],
    ['chat-lead', { window: '7d', summary: 'S.', proposals: [revert({ revert_to_hash: null })] }, 'a revert names revert_to_hash'],
  ]
  for (const [session, input, message] of refusals) {
    await expect(tool(session).process_report_submit(input)).rejects.toThrow(message)
  }
  expect(rows()).toEqual([0, 0, 0])
  expect(commits).toEqual([])
  s.db.close()
})

test('list and get stay inside the caller\'s team; list is newest first with per-window freshness', async () => {
  const { s, tool } = setup()
  const first = await tool().process_report_submit({ window: '1d', summary: 'One.' })
  const theirs = await tool('chat-other').process_report_submit({ window: '1d', summary: 'Theirs.' })
  const list = await tool('chat-dev').process_reports_list({})
  expect(list.reports.map(r => r.id)).toEqual([first.id])
  expect(list.freshness.map(f => [f.window, f.latestReportId, f.ageHours])).toEqual([['1d', first.id, 0], ['3d', null, null], ['7d', null, null]])
  await expect(tool().process_report_get({ report_id: theirs.id })).rejects.toThrow(`Unknown report: ${theirs.id}`)
  await expect(reportHandlers({ caller: async () => null, service: setup().service }, 'chat-x').process_reports_list({}))
    .rejects.toThrow('belongs to no team')
  s.db.close()
})

test('the report tools are registered and allowed; no tool decides, applies, withdraws, relinks, or unlinks', async () => {
  const { s, deps } = setup()
  const server = await createMailboxServer({} as TeamMailbox, 'chat-lead', { reports: deps })
  const registered = Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
  for (const name of REPORT_TOOL_NAMES) {
    expect(registered).toContain(name)
    expect(TEAM_ALLOWED_TOOLS).toContain(`mcp__kawai-team__${name}`)
  }
  for (const name of REPORT_FORBIDDEN_TOOL_NAMES) {
    expect(registered).not.toContain(name)
    expect(TEAM_ALLOWED_TOOLS).not.toContain(`mcp__kawai-team__${name}`)
  }
  const proposalTools = registered.filter(name => name.startsWith('process_'))
  expect(proposalTools.sort()).toEqual([...REPORT_TOOL_NAMES].sort())
  await server.instance.close()
  s.db.close()
})

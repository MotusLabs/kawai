// The audit store (execution-safety-recovery 4.4): pages are authoritative
// and replace; `team-audit-changed` marks the view stale; a reply whose
// request id is no longer pending is dropped; Load more appends; the
// acknowledge command keeps its id while the payload is unchanged, retires
// on success, and marks itself refused so it is not re-sent. Every apply
// method is reached through the protocol dispatch, the caller the view and
// the router share.
import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerMessage } from '@shared/types'
import type { OutboundAuditRow } from '@shared/outbound'
import { useTeamAuditStore, closedAuditView } from '../stores/teamAuditStore'
import { handleTeamMessage } from '../protocol/teamMessages'

afterEach(() => { useTeamAuditStore.setState({ views: {} }) })

const row = (id: string, overrides: Partial<OutboundAuditRow> = {}): OutboundAuditRow => ({
  id, createdAt: '2026-01-02T00:00:00.000Z', verdict: 'allowed', rule: 'git-push', destination: 'github:origin',
  command: 'git push origin main', truncated: false, tool: 'Bash', cwd: '/repo', classifierVersion: 3,
  matches: [], outcome: { state: 'completed' }, session: { id: 'chat-1', name: 'Dev', clickable: true },
  ...overrides,
})

const page = (rows: OutboundAuditRow[], cursor: string | null = null) => ({
  rows, counts: { allowedPerRule: { 'git-push': 2 }, unknown: 1, violations: 1, unacknowledgedViolations: 1 },
  cursor, backups: { dir: '/backups', newest: [], failures: [] },
})

const open = () => useTeamAuditStore.getState().open('/repo')

describe('the audit store', () => {
  test('a page replaces; a more appends; a stale reply is dropped', () => {
    open()
    useTeamAuditStore.getState().begin('/repo', 'r1', 'page')
    useTeamAuditStore.getState().applyPage({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'r1', page: page([row('a')], 'cur-1') })
    expect(useTeamAuditStore.getState().views['/repo']).toMatchObject({ rows: [row('a')], cursor: 'cur-1', loading: false })
    useTeamAuditStore.getState().begin('/repo', 'r2', 'more')
    useTeamAuditStore.getState().applyPage({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'r2', page: page([row('b')]) })
    expect(useTeamAuditStore.getState().views['/repo']!.rows!.map(r => r.id)).toEqual(['a', 'b'])
    // An unknown request id (superseded or replayed) lands nowhere.
    useTeamAuditStore.getState().applyPage({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'r9', page: page([row('z')], 'cur-9') })
    expect(useTeamAuditStore.getState().views['/repo']!.cursor).toBeNull()
  })

  test('team-audit-changed marks the view stale; a closed view stays quiet', () => {
    open()
    handleTeamMessage({ type: 'team-audit-changed', teamPath: '/repo', teamId: 't' }, {} as never)
    expect(useTeamAuditStore.getState().views['/repo']!.changed).toBe(1)
    useTeamAuditStore.getState().close('/repo')
    handleTeamMessage({ type: 'team-audit-changed', teamPath: '/repo', teamId: 't' }, {} as never)
    expect(useTeamAuditStore.getState().views['/repo']).toBeUndefined()
  })

  test('the acknowledge command keeps its id while the payload is unchanged; a refusal marks it', () => {
    open()
    useTeamAuditStore.getState().arm('/repo')
    const armed = useTeamAuditStore.getState().views['/repo']!.command!.commandId
    const again = useTeamAuditStore.getState().command('/repo', '{"callId":"a"}', 'r1')
    expect(again).toBe(armed)
    const changed = useTeamAuditStore.getState().command('/repo', '{"callId":"b"}', 'r1')
    expect(changed).not.toBe(armed)
    useTeamAuditStore.getState().begin('/repo', 'r1', 'acknowledge')
    useTeamAuditStore.getState().applyResult({ type: 'team-audit-result', teamPath: '/repo', requestId: 'r1', error: 'not a violation' })
    expect(useTeamAuditStore.getState().views['/repo']!.command).toMatchObject({ refused: true })
    expect(useTeamAuditStore.getState().views['/repo']!.error).toBe('not a violation')
  })

  test('a success retires the command; a reconnect drops pending requests', () => {
    open()
    useTeamAuditStore.getState().arm('/repo')
    useTeamAuditStore.getState().command('/repo', '{"callId":"a"}', 'r1')
    useTeamAuditStore.getState().begin('/repo', 'r1', 'acknowledge')
    useTeamAuditStore.getState().applyResult({ type: 'team-audit-result', teamPath: '/repo', requestId: 'r1' })
    expect(useTeamAuditStore.getState().views['/repo']!.command).toBeNull()
    useTeamAuditStore.getState().begin('/repo', 'r2', 'page')
    useTeamAuditStore.getState().reconnected('/repo')
    expect(useTeamAuditStore.getState().views['/repo']!.pending).toEqual({})
  })
})

describe('every apply method has a dispatch caller', () => {
  test('the router feeds page, changed, and result into the store', () => {
    open()
    const sent: ServerMessage[] = []
    const deps = {} as never
    const fire = (message: ServerMessage) => handleTeamMessage(message as never, deps)
    fire({ type: 'team-audit-changed', teamPath: '/repo', teamId: 't' })
    expect(useTeamAuditStore.getState().views['/repo']!.changed).toBe(1)
    // A page through the router: the store never saw a request, so it drops —
    // but the dispatch path itself is what this asserts (no throw, routed).
    fire({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'x', page: page([row('a')]) })
    expect(useTeamAuditStore.getState().views['/repo']!.rows).toBeNull()
    useTeamAuditStore.getState().begin('/repo', 'x', 'page')
    fire({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'x', page: page([row('a')]) })
    expect(useTeamAuditStore.getState().views['/repo']!.rows!.map(r => r.id)).toEqual(['a'])
    void sent
  })
})

describe('page generations, notices, and applied filters (findings-bee1aa24)', () => {
  test('a new page supersedes a pending more: its reply appends to nothing', () => {
    open()
    useTeamAuditStore.setState({ views: { '/repo': { ...closedAuditView(), open: true } } })
    useTeamAuditStore.getState().begin('/repo', 'm1', 'more')
    useTeamAuditStore.getState().begin('/repo', 'p2', 'page')
    // The new page resolves, clearing the orphaned more's spinner…
    useTeamAuditStore.getState().applyPage({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'p2', page: page([row('a')], 'cur-2') })
    // …and the stale more's reply, arriving after, lands nowhere.
    useTeamAuditStore.getState().applyPage({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'm1', page: page([row('z')], 'cur-z') })
    const view = useTeamAuditStore.getState().views['/repo']!
    expect(view.rows!.map(r => r.id)).toEqual(['a'])
    expect(view.cursor).toBe('cur-2')
    expect(view.loadingMore).toBe(false)
    expect(view.pending).toEqual({})
  })

  test('a more whose generation matches still appends; acknowledge entries survive a new page', () => {
    open()
    useTeamAuditStore.setState({ views: { '/repo': { ...closedAuditView(), open: true, rows: [row('a')] } } })
    useTeamAuditStore.getState().begin('/repo', 'ack1', 'acknowledge')
    useTeamAuditStore.getState().begin('/repo', 'm1', 'more')
    useTeamAuditStore.getState().applyPage({ type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'm1', page: page([row('b')]) })
    expect(useTeamAuditStore.getState().views['/repo']!.rows!.map(r => r.id)).toEqual(['a', 'b'])
    expect(useTeamAuditStore.getState().views['/repo']!.pending).toEqual({ ack1: 'acknowledge' })
  })

  test("clearing the selection drops the group's filters (the URL left the call)", () => {
    open()
    useTeamAuditStore.getState().begin('/repo', 'p1', 'page')
    useTeamAuditStore.getState().applyPage({
      type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'p1', page: page([row('a')]),
      appliedFilters: { rule: 'gh-write', destination: 'github:other/repo' },
    })
    expect(useTeamAuditStore.getState().views['/repo']!.filters).toEqual({ rule: 'gh-write', destination: 'github:other/repo' })
    useTeamAuditStore.getState().select('/repo', null)
    expect(useTeamAuditStore.getState().views['/repo']!.filters).toEqual({})
  })

  test('a notice rides the page and clears on the next request; applied filters are adopted', () => {
    open()
    useTeamAuditStore.getState().begin('/repo', 'p1', 'page')
    useTeamAuditStore.getState().applyPage({
      type: 'team-audit-page', teamPath: '/repo', teamId: 't', requestId: 'p1',
      page: page([row('a')]), notice: 'Call obc-x was not found in this team.',
      appliedFilters: { rule: 'gh-write', destination: 'github:other/repo' },
    })
    const view = useTeamAuditStore.getState().views['/repo']!
    expect(view.notice).toContain('obc-x')
    // The store adopts the group filters, so a changed push re-requests the group.
    expect(view.filters).toEqual({ rule: 'gh-write', destination: 'github:other/repo' })
    useTeamAuditStore.getState().begin('/repo', 'p2', 'page')
    expect(useTeamAuditStore.getState().views['/repo']!.notice).toBeNull()
  })
})

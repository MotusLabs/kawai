// The Audit tab's component behavior (execution-safety-recovery 4.4, D9):
// newest-first rows with the counts, filters and Load more, each outcome
// state's label, gone sessions named and not clickable, Acknowledge arming
// one command id that survives an unchanged resend, and every control
// disabled while disconnected.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { OutboundAuditRow } from '@shared/outbound'
import TeamAuditView from '../components/team/TeamAuditView'
import { useTeamAuditStore } from '../stores/teamAuditStore'

afterEach(() => { useTeamAuditStore.setState({ views: {} }) })

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const row = (id: string, overrides: Partial<OutboundAuditRow> = {}): OutboundAuditRow => ({
  id, createdAt: '2026-01-02T03:04:05.000Z', verdict: 'allowed', rule: 'git-push', destination: 'github:origin',
  command: 'git push origin main', truncated: false, tool: 'Bash', cwd: '/repo', classifierVersion: 3,
  matches: [], outcome: { state: 'completed' }, session: { id: 'chat-1', name: 'Dev', clickable: true },
  ...overrides,
})

const pageOf = (rows: OutboundAuditRow[], cursor: string | null = null) => ({
  type: 'team-audit-page' as const, teamPath: '/repo', teamId: 't', requestId: 'r1',
  page: {
    rows, cursor,
    counts: { allowedPerRule: { 'git-push': 2, 'gh-write': 1 }, unknown: 1, violations: 3, unacknowledgedViolations: 1 },
    backups: { dir: '/h/.agentboard/backups', newest: [{ reason: 'interval' as const, name: 'db-1.db', bytes: 2048, checked: 'ok' }], failures: [{ reason: 'interval' as const, path: null, error: 'integrity failed', at: '2026-01-01T00:00:00Z' }] },
  },
})

const mount = (setup: () => void = () => {}) => {
  useTeamAuditStore.getState().open('/repo')
  act(() => { setup() })
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  let connected = true
  let epoch = 0
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const element = () => <TeamAuditView teamPath="/repo" view={useTeamAuditStore.getState().views['/repo']!}
    sendMessage={sendMessage} connected={connected} connectionEpoch={epoch} />
  act(() => { renderer = TestRenderer.create(element()) })
  const rerender = (next: { connected?: boolean; epoch?: number } = {}) => {
    if (next.connected !== undefined) connected = next.connected
    if (next.epoch !== undefined) epoch = next.epoch
    act(() => { renderer.update(element()) })
  }
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const allBy = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId })
  return { renderer, sent, rerender, byId, allBy, send: sendMessage }
}

const openWith = (cursor: string | null = null) => mount(() => {
  useTeamAuditStore.getState().begin('/repo', 'r1', 'page')
  useTeamAuditStore.getState().applyPage(pageOf([
    row('obc-new', { createdAt: '2026-01-02T03:04:05.000Z', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', command: 'gh issue create -R other/repo --title x', outcome: { state: 'denied', detail: 'declined by the human' }, session: { id: 'chat-gone', name: 'Gone Dev (gone)', clickable: false } }),
    row('obc-old', { createdAt: '2026-01-01T00:00:00.000Z', outcome: { state: 'outcome-unknown' }, session: { id: 'chat-gone', name: 'Gone Dev (gone)', clickable: false } }),
    row('obc-bg', { createdAt: '2026-01-01T00:00:01.000Z', outcome: { state: 'started-background' } }),
  ], cursor))
})

test('rows list newest first with the counts; gone sessions are named and not clickable', () => {
  const { renderer, byId } = openWith()
  const rows = renderer.root.findAll(node => String(node.props['data-testid'] ?? '').startsWith('audit-row-'))
  expect(rows.map(r => r.props['data-testid'])).toEqual(['audit-row-obc-new', 'audit-row-obc-old', 'audit-row-obc-bg'])
  expect(textOf(byId('audit-counts'))).toContain('git-push 2')
  expect(textOf(byId('audit-counts'))).toContain('gh-write 1')
  expect(textOf(byId('audit-counts'))).toContain('Unknown destinations 1')
  expect(textOf(byId('audit-counts'))).toContain('Violations 3')
  expect(textOf(byId('audit-counts'))).toContain('Unacknowledged 1')
  // Outcome labels per state.
  expect(textOf(rows[0]!)).toContain('Denied')
  expect(textOf(rows[1]!)).toContain('Outcome unknown')
  expect(textOf(rows[2]!)).toContain('Started in background')
  // The gone session renders as text, never a button.
  const gone = rows[0]!.findAll(node => node.props['data-testid'] === 'audit-session')
  expect(gone).toHaveLength(1)
  expect(gone[0]!.type).toBe('span')
  expect(textOf(gone[0]!)).toBe('Gone Dev (gone)')
  // A clickable session is a button.
  const live = rows[2]!.findAll(node => node.props['data-testid'] === 'audit-session')
  expect(live[0]!.type).toBe('button')
  act(() => renderer.unmount())
})

test('filters commit as one page request; Load more sends the cursor; the footer shows backups', () => {
  const { sent, byId, renderer } = mount(() => {
    useTeamAuditStore.getState().begin('/repo', 'r1', 'page')
    useTeamAuditStore.getState().applyPage(pageOf([row('a')], 'cur-1'))
  })
  sent.length = 0
  byId('audit-apply-filters').props.onClick()
  expect(sent.at(-1)).toMatchObject({ type: 'team-audit-open', teamPath: '/repo', filters: {} })
  byId('audit-load-more').props.onClick()
  expect(sent.at(-1)).toMatchObject({ type: 'team-audit-more', teamPath: '/repo', cursor: 'cur-1', filters: {} })
  const footer = textOf(byId('audit-backups'))
  expect(footer).toContain('/h/.agentboard/backups')
  expect(footer).toContain('interval db-1.db (2 KB, check ok)')
  expect(footer).toContain('1 failed backup: interval integrity failed')
  act(() => renderer.unmount())
})

test('acknowledge arms one command id and reuses it while the payload is unchanged', () => {
  const { sent, byId, allBy } = openWith()
  act(() => byId('audit-acknowledge').props.onClick())
  // Re-render so the row reads the armed command.
  const armed = useTeamAuditStore.getState().views['/repo']!.command!.commandId
  const dialog = allBy('audit-ack-dialog')[0]!
  const confirm = dialog.findAll(node => node.props['data-testid'] === 'audit-ack-confirm')[0]!
  act(() => confirm.props.onClick())
  expect(sent.at(-1)).toMatchObject({ type: 'team-audit-acknowledge', teamPath: '/repo', callId: 'obc-new', commandId: armed })
  // The same payload resends under the same command id (a lost result replays).
  const sentLength = sent.length
  act(() => confirm.props.onClick())
  expect(sent.length).toBe(sentLength + 1)
  expect(sent.at(-1)).toMatchObject({ commandId: armed })
  // A different note re-mints.
  const noteField = dialog.findAll(node => node.props['aria-label'] === 'Acknowledgement note')[0]!
  act(() => noteField.props.onChange({ target: { value: 'noted' } }))
  act(() => confirm.props.onClick())
  expect((sent.at(-1) as { commandId: string }).commandId).not.toBe(armed)
})

test('every control disables while disconnected', () => {
  const { rerender, byId, allBy } = openWith('cur-1')
  rerender({ connected: false })
  expect(byId('audit-apply-filters').props.disabled).toBe(true)
  expect(byId('audit-load-more').props.disabled).toBe(true)
  expect(textOf(byId('team-audit'))).toContain('Disconnected')
  // The acknowledge buttons, including the armed dialog's, disable too.
  for (const button of allBy('audit-acknowledge')) expect(button.props.disabled).toBe(true)
})

describe('the fix round (findings-bee1aa24)', () => {
  test("the linked call's row is marked selected and the dialog closes on success", () => {
    const { renderer, sent, byId, allBy } = mount(() => {
      useTeamAuditStore.setState({ views: { '/repo': { ...useTeamAuditStore.getState().views['/repo']!, selected: 'obc-new' } } })
      useTeamAuditStore.getState().begin('/repo', 'r1', 'page')
      useTeamAuditStore.getState().applyPage(pageOf([
        row('obc-new', { createdAt: '2026-01-02T03:04:05.000Z', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo' }),
      ]))
    })
    const selectedRow = renderer.root.findAll(node => node.props['data-testid'] === 'audit-row-obc-new')[0]!
    expect(selectedRow.props['data-selected']).toBe(true)
    // Acknowledge: one command, and success closes the dialog.
    act(() => byId('audit-acknowledge').props.onClick())
    const confirm = renderer.root.findAll(node => node.props['data-testid'] === 'audit-ack-confirm')[0]!
    act(() => confirm.props.onClick())
    expect(sent.at(-1)).toMatchObject({ type: 'team-audit-acknowledge', callId: 'obc-new' })
    act(() => useTeamAuditStore.getState().applyResult({
      type: 'team-audit-result', teamPath: '/repo',
      requestId: (sent.at(-1) as { requestId: string }).requestId,
    }))
    expect(renderer.root.findAll(node => node.props['data-testid'] === 'audit-ack-dialog')).toHaveLength(0)
    act(() => renderer.unmount())
  })

  test('the destination filter rides the committed request; the footer is server-wide with the check result', () => {
    const { sent, byId, renderer } = mount(() => {
      useTeamAuditStore.getState().begin('/repo', 'r1', 'page')
      useTeamAuditStore.getState().applyPage(pageOf([row('a', { destination: 'github:origin' })]))
    })
    sent.length = 0
    const destination = renderer.root.findAllByProps({ 'aria-label': 'Filter by destination' })[0]!
    act(() => destination.props.onChange({ target: { value: 'github:origin' } }))
    byId('audit-apply-filters').props.onClick()
    expect(sent.at(-1)).toMatchObject({ type: 'team-audit-open', filters: { destination: 'github:origin' } })
    const footer = textOf(byId('audit-backups'))
    expect(footer).toContain('Server-wide database backups')
    expect(footer).toContain('check ok')
    act(() => renderer.unmount())
  })
})

test('a call id arriving while the tab is open re-requests with it (the attention link)', () => {
  const { sent, renderer, rerender } = mount(() => {
    useTeamAuditStore.getState().begin('/repo', 'r1', 'page')
    useTeamAuditStore.getState().applyPage(pageOf([row('a'), row('b')]))
  })
  sent.length = 0
  // The URL's call id lands (the WorkspaceView syncs the store's selection).
  act(() => useTeamAuditStore.getState().select('/repo', 'b'))
  rerender()
  expect(sent.at(-1)).toMatchObject({ type: 'team-audit-open', teamPath: '/repo', callId: 'b' })
  // The same selection again does not re-request.
  sent.length = 0
  rerender()
  expect(sent).toEqual([])
  act(() => renderer.unmount())
})

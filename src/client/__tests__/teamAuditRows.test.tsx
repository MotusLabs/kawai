// The Audit tab's rows, dialog, and chrome (execution-safety-recovery D9,
// D10): each verdict and outcome label exactly, the metadata line, the
// clipped command with its truncation mark, the selected row scrolled into
// view, sessions opening their chat only while clickable, the notice, error,
// empty, loading, and footer states, and the acknowledge dialog — a trimmed
// note in the payload identity, Cancel and success retiring the command, a
// refusal disabling Confirm with its explanation.
import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react-test-renderer'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamAuditStore } from '../stores/teamAuditStore'
import { answerLatest, auditRow, mountAudit, textOf } from './auditFixtures'

afterEach(() => {
  useTeamAuditStore.setState({ views: {} })
  useSessionStore.setState({ selectedSessionId: null })
})

const opened = (rows = [auditRow('a')], cursor: string | null = null) => {
  const audit = mountAudit()
  answerLatest(audit.sent, rows, cursor)
  audit.rerender()
  return audit
}

describe('row content', () => {
  test('verdict and outcome labels, exactly', () => {
    const states = ['denied', 'failed', 'completed', 'started-background', 'pending', 'outcome-unknown'] as const
    const audit = opened([
      ...states.map((state, index) => auditRow(`o${index}`, { outcome: { state } })),
      auditRow('v', { verdict: 'violation' }), auditRow('u', { verdict: 'unknown-destination' }),
    ])
    expect(audit.allBy('audit-outcome').map(node => textOf(node))).toEqual([
      'Denied', 'Failed', 'Completed', 'Started in background', 'Pending', 'Outcome unknown', 'Completed', 'Completed',
    ])
    expect(audit.allBy('audit-verdict').map(node => textOf(node))).toEqual([
      ...states.map(() => 'Allowed'), 'Violation', 'Unknown destination',
    ])
  })

  test('the metadata line names group, profile, task, subagent, server, tool, and cwd', () => {
    const audit = opened([auditRow('m', {
      groupId: 'devs', profileId: 'glm', taskId: 'task-1', agentId: 'agent-7', mcpServer: 'docs', tool: 'mcp__docs__search', cwd: '/repo/wt',
    })])
    const meta = audit.byId('audit-row-m').findAll(node => node.type === 'p')[0]!
    expect(textOf(meta)).toBe('group devs · profile glm · task task-1 · subagent agent-7 · server docs · tool mcp__docs__search · /repo/wt')
  })

  test('a long command clips at 160 characters until expanded; truncation is marked', () => {
    const long = `git push ${'x'.repeat(200)}`
    const audit = opened([auditRow('l', { command: long, truncated: true }), auditRow('s', { command: 'git push', truncated: true })])
    const commandOf = (id: string) => textOf(audit.byId(`audit-row-${id}`).findAll(node => node.type === 'p')[1]!)
    expect(commandOf('l')).toBe(`${long.slice(0, 160)}…`)
    expect(commandOf('s')).toBe('git push ‹truncated›')
    audit.change(() => audit.byId('audit-command-toggle').props.onClick())
    expect(commandOf('l')).toBe(`${long} ‹truncated›`)
  })

  test('the selected row is marked and scrolled into view once; others are not', () => {
    const scrolled: unknown[] = []
    useTeamAuditStore.getState().open('/repo')
    useTeamAuditStore.getState().select('/repo', 'b')
    const audit = mountAudit({ createNodeMock: () => ({ scrollIntoView: (options: unknown) => scrolled.push(options) }) })
    answerLatest(audit.sent, [auditRow('a'), auditRow('b')])
    audit.rerender()
    expect(audit.byId('audit-row-b').props['data-selected']).toBe(true)
    expect(audit.byId('audit-row-a').props['data-selected']).toBeUndefined()
    expect(scrolled).toEqual([{ block: 'center' }])
  })

  test('a clickable session opens its chat; a gone one is plain text', () => {
    const audit = opened([
      auditRow('live', { session: { id: 'chat-live', name: 'Dev', clickable: true } }),
      auditRow('gone', { session: { id: 'chat-gone', name: 'Old (gone)', clickable: false } }),
    ])
    const [live, gone] = audit.allBy('audit-session')
    expect(live!.type).toBe('button')
    expect(gone!.type).toBe('span')
    expect(textOf(gone!)).toBe('Old (gone)')
    act(() => live!.props.onClick())
    expect(useSessionStore.getState().selectedSessionId).toBe('chat-live')
  })
})

describe('page states', () => {
  test('loading before the first page, then the empty state, a notice, and an error', () => {
    const audit = mountAudit()
    expect(textOf(audit.byId('audit-counts'))).toBe('Loading…')
    answerLatest(audit.sent, [])
    audit.rerender()
    expect(textOf(audit.byId('audit-rows'))).toBe('No recorded sends match.')
    expect(textOf(audit.byId('audit-counts'))).toBe('Allowed git-push 2Unknown destinations 4Violations 3Unacknowledged 1')
    audit.change(() => useTeamAuditStore.setState(state => ({ views: { '/repo': { ...state.views['/repo']!, notice: 'Call obc-x was not found in this team.', error: 'refused: x' } } })))
    expect(textOf(audit.byId('audit-notice'))).toBe('Call obc-x was not found in this team.')
    expect(textOf(audit.renderer.root.findByProps({ role: 'alert' }))).toBe('refused: x')
  })

  test('the footer: no status, none yet, and newest with failures', () => {
    const audit = mountAudit()
    expect(textOf(audit.byId('audit-backups'))).toBe('Server-wide database backups: no status available.')
    answerLatest(audit.sent, [auditRow('a')])
    audit.rerender()
    expect(textOf(audit.byId('audit-backups'))).toBe('Server-wide database backups in /h/.agentboard/backups: none yet.')
    audit.change(() => useTeamAuditStore.setState(state => ({ views: { '/repo': { ...state.views['/repo']!, backups: {
      dir: '/b', newest: [{ reason: 'interval', name: 'db-1.db', bytes: 4096, checked: 'ok' }],
      failures: [{ reason: 'startup', path: null, error: 'disk full', at: '2026-01-01T00:00:00Z' }],
    } } } })))
    expect(textOf(audit.byId('audit-backups'))).toBe('Server-wide database backups in /b: interval db-1.db (4 KB, check ok) · 1 failed backup: startup disk full')
  })
})

describe('the acknowledge dialog', () => {
  const dialog = () => {
    const audit = opened([auditRow('v', { verdict: 'violation' }), auditRow('ok')])
    expect(audit.allBy('audit-acknowledge')).toHaveLength(1)
    audit.change(() => audit.byId('audit-acknowledge').props.onClick())
    return audit
  }
  const confirm = (audit: ReturnType<typeof dialog>) => {
    audit.sent.length = 0
    audit.change(() => audit.byId('audit-ack-confirm').props.onClick())
    return audit.sent[0] as { requestId: string; commandId: string }
  }

  test('the note is trimmed into the request; an empty note sends no note; each send is begun', () => {
    const audit = dialog()
    const armed = audit.view().command!.commandId
    const bare = confirm(audit)
    expect(audit.sent).toEqual([{ type: 'team-audit-acknowledge', teamPath: '/repo', requestId: bare.requestId, callId: 'v', commandId: armed }])
    expect(audit.view().pending[bare.requestId]).toBe('acknowledge')
    audit.change(() => audit.byLabel('Acknowledgement note').props.onChange({ target: { value: '  reviewed  ' } }))
    const noted = confirm(audit)
    expect(audit.sent).toEqual([{ type: 'team-audit-acknowledge', teamPath: '/repo', requestId: noted.requestId, callId: 'v', commandId: noted.commandId, note: 'reviewed' }])
    expect(noted.commandId).not.toBe(armed)
    // The trimmed payload is the identity: whitespace-only edits replay.
    audit.change(() => audit.byLabel('Acknowledgement note').props.onChange({ target: { value: 'reviewed ' } }))
    expect(confirm(audit).commandId).toBe(noted.commandId)
  })

  test('Cancel retires the command; reopening arms a new one', () => {
    const audit = dialog()
    const first = audit.view().command!.commandId
    const cancel = audit.byId('audit-ack-dialog').findAll(node => node.type === 'button' && textOf(node) === 'Cancel')[0]!
    audit.change(() => cancel.props.onClick())
    expect(audit.view().command).toBeNull()
    expect(audit.allBy('audit-ack-dialog')).toHaveLength(0)
    audit.change(() => audit.byId('audit-acknowledge').props.onClick())
    expect(audit.view().command!.commandId).not.toBe(first)
  })

  test('a refusal disables Confirm and explains; success closes the dialog', () => {
    const audit = dialog()
    const sent = confirm(audit)
    expect(audit.allBy('audit-ack-dialog')).toHaveLength(1)
    audit.change(() => useTeamAuditStore.getState().applyResult({ type: 'team-audit-result', teamPath: '/repo', requestId: sent.requestId, error: 'Only a violation can be acknowledged.' }))
    expect(audit.byId('audit-ack-confirm').props.disabled).toBe(true)
    const alerts = audit.byId('audit-ack-dialog').findAll(node => node.props.role === 'alert')
    expect(alerts.map(node => textOf(node))).toEqual(['The command was refused — close and reopen this dialog to try again.'])
    // Reopen: a new command, Confirm enabled again; success closes.
    const cancel = audit.byId('audit-ack-dialog').findAll(node => node.type === 'button' && textOf(node) === 'Cancel')[0]!
    audit.change(() => cancel.props.onClick())
    audit.change(() => audit.byId('audit-acknowledge').props.onClick())
    expect(audit.byId('audit-ack-confirm').props.disabled).toBe(false)
    const retry = confirm(audit)
    audit.change(() => useTeamAuditStore.getState().applyResult({ type: 'team-audit-result', teamPath: '/repo', requestId: retry.requestId }))
    expect(audit.allBy('audit-ack-dialog')).toHaveLength(0)
  })
})

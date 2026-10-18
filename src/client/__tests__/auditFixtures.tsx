// Shared fixtures for the Audit tab's view tests (execution-safety-recovery
// D9/D10): a row builder, a page message, and a mount that renders the view
// over the store's '/repo' view with a controllable connection and epoch.
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { OutboundAuditRow } from '@shared/outbound'
import TeamAuditView from '../components/team/TeamAuditView'
import { useTeamAuditStore } from '../stores/teamAuditStore'

export const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

export const auditRow = (id: string, overrides: Partial<OutboundAuditRow> = {}): OutboundAuditRow => ({
  id, createdAt: '2026-01-02T03:04:05.000Z', verdict: 'allowed', rule: 'git-push', destination: 'github:origin',
  command: 'git push origin main', truncated: false, tool: 'Bash', cwd: '/repo', classifierVersion: 3,
  matches: [], outcome: { state: 'completed' }, session: { id: 'chat-1', name: 'Dev', clickable: true },
  ...overrides,
})

export const auditPage = (rows: OutboundAuditRow[], requestId: string, cursor: string | null = null) => ({
  type: 'team-audit-page' as const, teamPath: '/repo', teamId: 't', requestId,
  page: {
    rows, cursor,
    counts: { allowedPerRule: { 'git-push': 2 }, unknown: 4, violations: 3, unacknowledgedViolations: 1 },
    backups: { dir: '/h/.agentboard/backups', newest: [], failures: [] },
  },
})

/** The open request the view's own mount sent, answered with `rows`. */
export function answerLatest(sent: ClientMessage[], rows: OutboundAuditRow[], cursor: string | null = null) {
  const open = sent.filter(message => message.type === 'team-audit-open').at(-1) as { requestId: string }
  act(() => useTeamAuditStore.getState().applyPage(auditPage(rows, open.requestId, cursor)))
}

export function mountAudit(options: {
  connected?: boolean
  onSelectedCall?: (callId: string | null) => void
  createNodeMock?: () => unknown
} = {}) {
  const sent: ClientMessage[] = []
  let sink = sent
  let connected = options.connected ?? true
  let epoch = 0
  let renderer!: TestRenderer.ReactTestRenderer
  const element = () => {
    // Each render passes a fresh sendMessage bound to the current sink.
    const target = sink
    return <TeamAuditView teamPath="/repo" view={useTeamAuditStore.getState().views['/repo']!}
      sendMessage={message => { target.push(message) }} connected={connected} connectionEpoch={epoch}
      {...(options.onSelectedCall ? { onSelectedCall: options.onSelectedCall } : {})} />
  }
  act(() => {
    if (!useTeamAuditStore.getState().views['/repo']) useTeamAuditStore.getState().open('/repo')
    renderer = TestRenderer.create(element(), options.createNodeMock ? { createNodeMock: options.createNodeMock } : undefined)
  })
  const rerender = (next: { connected?: boolean; epoch?: number; sink?: ClientMessage[] } = {}) => {
    if (next.sink !== undefined) sink = next.sink
    if (next.connected !== undefined) connected = next.connected
    if (next.epoch !== undefined) epoch = next.epoch
    act(() => { renderer.update(element()) })
  }
  /** Run a store change, then re-render with the view it produced (the host's job). */
  const change = (work: () => void) => { act(work); rerender() }
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const allBy = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId })
  const byLabel = (label: string) => renderer.root.findByProps({ 'aria-label': label })
  const opens = () => sent.filter(message => message.type === 'team-audit-open') as Array<Extract<ClientMessage, { type: 'team-audit-open' }>>
  const view = () => useTeamAuditStore.getState().views['/repo']!
  return { renderer, sent, rerender, change, byId, allBy, byLabel, opens, view }
}

// Header reflow keeps every header action and its neighbours working inside
// ChatView (chat-transcript-layout 3.3): rename, approval policy and its amber
// indication, Archive, confirmed Kill, connection status, archived stored
// readings with Restore below the transcript, and the usage and notification
// strips under the header with their dismissal rules. Team/task navigation
// and Debug are covered in chatHeader.test.tsx; the menu popup and dialog
// DOM flows in tests/e2e/chat-header.spec.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatNotification, ChatUsageReport } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import ChatKillDialog from '../components/chat/ChatKillDialog'
import ChatView from '../components/chat/ChatView'
import { Switch } from '../components/Switch'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { chooseSessionMenuEntry } from './support/sessionMenu'

const session = {
  id: 'chat-int', name: 'Header integration', projectPath: '/home/coder/kawai', status: 'waiting', kind: 'chat',
  approvalPolicy: 'manual', claudeProfileId: 'default',
} as unknown as Session
const archived = { ...session, status: 'unknown', archivedAt: '2026-10-15T09:00:00.000Z' } as unknown as Session

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : (node.children ?? []).map(textOf).join('')

const notice = (source: 'agent' | 'account', key: string): ChatNotification => ({
  key, source, severity: 'warning', priority: 'high', text: `${source} notice`, receivedAt: '2026-10-15T09:00:00.000Z',
})
const usage: ChatUsageReport = {
  status: 'allowed', receivedAt: '2026-10-15T09:00:00.000Z',
  windows: [{ key: 'five_hour', label: '5-hour window', percentUsed: 22, resetsAt: '2026-10-15T12:00:00.000Z' }],
} as ChatUsageReport

function seed(id: string) {
  useChatStore.getState().setContextUsage(id, {
    usedTokens: 42_000, thresholdTokens: 167_000, percentage: 25.1, at: '2026-10-15T09:00:00.000Z',
  })
  useChatStore.getState().setUsage('default', usage)
  useChatStore.getState().setNotifications(id, [notice('agent', 'agent-1'), notice('account', 'login-expiry')])
}

function renderView(chat: Session, connectionStatus: 'connected' | 'disconnected' = 'connected') {
  const sent: ClientMessage[] = []
  const kills: string[] = []
  act(() => { useSessionStore.setState({ sessions: [chat], selectedSessionId: chat.id }) })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView session={chat} sendMessage={message => { sent.push(message) }}
      connectionStatus={connectionStatus} connectionEpoch={0} error={null} onClose={() => {}}
      onKill={() => kills.push(chat.id)} />)
  })
  const byId = (id: string) => renderer.root.findByProps({ 'data-testid': id })
  const allById = (id: string) => renderer.root.findAllByProps({ 'data-testid': id })
  const sentOf = (type: string) => sent.filter(message => message.type === type)
  return { renderer, byId, allById, sentOf, kills }
}

/** Host test ids in document order. */
function order(renderer: TestRenderer.ReactTestRenderer, ids: string[]): string[] {
  return renderer.root.findAll(node => typeof node.type === 'string' && ids.includes(node.props['data-testid']))
    .map(node => node.props['data-testid'] as string)
}

afterEach(() => {
  useSessionStore.setState({ sessions: [], selectedSessionId: null, selectedHibernatingSessionId: null })
  useChatStore.setState({ sessions: {}, usage: {}, closedAccountNotices: {} })
})

describe('header actions after the reflow', () => {
  test('rename broadcasts through session-rename', () => {
    const { byId, sentOf, renderer } = renderView(session)
    act(() => byId('chat-name').props.onClick())
    act(() => byId('chat-name-input').props.onChange({ target: { value: 'Renamed chat' } }))
    act(() => byId('chat-name-input').props.onKeyDown({ key: 'Enter', preventDefault: () => {} }))
    expect(sentOf('session-rename')).toEqual([{ type: 'session-rename', sessionId: session.id, newName: 'Renamed chat' }])
    act(() => renderer.unmount())
  })

  test('Auto-approve sends the policy and shows the amber state from the broadcast session', () => {
    const { renderer, sentOf } = renderView(session)
    act(() => renderer.root.findByType(Switch).props.onCheckedChange(true))
    expect(sentOf('chat-set-approval-policy')).toEqual([{ type: 'chat-set-approval-policy', sessionId: session.id, policy: 'auto' }])
    const auto = { ...session, approvalPolicy: 'auto' } as Session
    act(() => renderer.update(<ChatView session={auto} sendMessage={() => {}} connectionStatus="connected"
      connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />))
    const host = renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-testid'] === 'chat-approval-policy')[0]!
    expect(host.props['aria-checked']).toBe(true)
    expect(host.props.className).toContain('data-[checked]:bg-approval')
    act(() => renderer.unmount())
  })

  test('Archive sends chat-archive; Kill asks first and only the confirmation kills', () => {
    const { renderer, sentOf, kills } = renderView(session)
    act(() => chooseSessionMenuEntry(renderer.root, 'archive'))
    expect(sentOf('chat-archive')).toEqual([{ type: 'chat-archive', sessionId: session.id }])
    act(() => chooseSessionMenuEntry(renderer.root, 'kill'))
    const dialog = renderer.root.findByType(ChatKillDialog)
    expect(dialog.props.open).toBe(true)
    expect(kills).toEqual([])
    act(() => dialog.props.onConfirm())
    expect(kills).toEqual([session.id])
    act(() => renderer.unmount())
  })

  test('connection status reaches the header; disconnected disables Restore', () => {
    const live = renderView(session, 'disconnected')
    expect(textOf(live.byId('chat-status'))).toBe('disconnected')
    act(() => live.renderer.unmount())
    const stored = renderView(archived, 'disconnected')
    expect(stored.renderer.root.findByProps({ children: 'Restore' }).props.disabled).toBe(true)
    act(() => stored.renderer.unmount())
  })
})

describe('strips and archived readings', () => {
  test('usage and notification strips sit under the header and agent notices dismiss server-side', () => {
    seed(session.id)
    const { renderer, allById, sentOf } = renderView(session)
    expect(order(renderer, ['chat-context-meter', 'chat-usage', 'chat-notifications', 'chat-transcript']))
      .toEqual(['chat-context-meter', 'chat-usage', 'chat-notifications', 'chat-transcript'])
    expect(allById('chat-notification')).toHaveLength(2)
    const agentClose = allById('chat-notification-close')[0]!
    act(() => agentClose.props.onClick())
    expect(sentOf('chat-dismiss-notification')).toEqual([{ type: 'chat-dismiss-notification', sessionId: session.id, key: 'agent-1' }])
    act(() => renderer.unmount())
  })

  test('an archived chat keeps its stored context and account notices, hides Auto-approve, and keeps Restore below the transcript', () => {
    seed(archived.id)
    const { renderer, byId, allById, sentOf } = renderView(archived)
    expect(textOf(byId('chat-context-meter'))).toContain('25.1%')
    expect(allById('chat-approval-policy')).toHaveLength(0)
    expect(allById('chat-notification').map(textOf).join(' ')).toContain('account notice')
    expect(allById('chat-notification').map(textOf).join(' ')).not.toContain('agent notice')
    expect(order(renderer, ['chat-usage', 'chat-transcript', 'chat-archived-bar']))
      .toEqual(['chat-usage', 'chat-transcript', 'chat-archived-bar'])
    act(() => renderer.root.findByProps({ children: 'Restore' }).props.onClick())
    expect(sentOf('chat-restore')).toEqual([{ type: 'chat-restore', sessionId: archived.id }])
    act(() => renderer.unmount())
  })
})

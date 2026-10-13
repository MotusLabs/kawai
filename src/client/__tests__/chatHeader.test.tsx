// The chat header (chat-header-layout): identity and status block.
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import ChatHeader, { projectName, type ChatHeaderProps } from '../components/chat/ChatHeader'

const session = {
  id: 'chat-1', name: 'Kawai Chat header buttons', projectPath: '/home/coder/kawai', status: 'working', kind: 'chat',
  approvalPolicy: 'manual',
} as unknown as Session

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : (node.children ?? []).map(textOf).join('')

function renderHeader(overrides: Partial<ChatHeaderProps> = {}) {
  const props: ChatHeaderProps = {
    session, profileLabel: 'Default', model: 'claude-opus-5-5', contextUsage: null, connectionStatus: 'connected',
    openSlot: null, onToggleSlot: () => {}, onOpenTask: () => {}, onRename: () => {}, onToggleApproval: () => {},
    onArchive: () => {}, onKill: () => {}, onClose: () => {}, ...overrides,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ChatHeader {...props} />) })
  const byId = (id: string) => renderer.root.findByProps({ 'data-testid': id })
  const allById = (id: string) => renderer.root.findAllByProps({ 'data-testid': id })
  const update = (next: Partial<ChatHeaderProps>) => act(() => renderer.update(<ChatHeader {...props} {...next} />))
  return { renderer, byId, allById, update }
}

describe('identity block', () => {
  test('live session identity: status and name, then profile · model · project with the full path on hover', () => {
    const { byId } = renderHeader()
    expect(textOf(byId('chat-status'))).toBe('working')
    expect(textOf(byId('chat-name'))).toBe('Kawai Chat header buttons')
    expect(textOf(byId('chat-profile'))).toBe('Default')
    expect(byId('chat-profile').props.title).toBe('Profile: Default')
    expect(textOf(byId('chat-model'))).toBe('claude-opus-5-5')
    expect(textOf(byId('chat-project'))).toBe('kawai')
    expect(byId('chat-project').props.title).toBe('/home/coder/kawai')
    expect(textOf(byId('chat-identity'))).toBe('Default·claude-opus-5-5·kawai')
  })

  test('no model segment before the agent reports one', () => {
    const { allById, byId } = renderHeader({ model: null })
    expect(allById('chat-model')).toHaveLength(0)
    expect(textOf(byId('chat-identity'))).toBe('Default·kawai')
  })

  test('the status indicator follows the session, the connection, and archiving', () => {
    const { byId, update } = renderHeader()
    expect(byId('chat-status-dot').props.className).toContain('bg-working')
    update({ session: { ...session, status: 'waiting' } as Session })
    expect(textOf(byId('chat-status'))).toBe('waiting')
    expect(byId('chat-status-dot').props.className).toContain('bg-waiting')
    update({ connectionStatus: 'disconnected' })
    expect(textOf(byId('chat-status'))).toBe('disconnected')
    expect(byId('chat-status-dot').props.className).toContain('bg-danger')
    update({ session: { ...session, archivedAt: '2026-10-01T00:00:00.000Z' } as Session })
    expect(textOf(byId('chat-status'))).toBe('archived')
  })

  test('task and paused chips sit on the second line; the task chip opens the task', () => {
    const opened: string[] = []
    const until = new Date(Date.now() + 40 * 60_000).toISOString()
    const { byId } = renderHeader({
      session: { ...session, taskId: 'task-1', taskTitle: 'Export', parked: { messageId: 'm1', until, profileId: 'glm', reason: 'Provider limit on glm' } } as Session,
      onOpenTask: taskId => opened.push(taskId),
    })
    const identity = byId('chat-identity')
    expect(identity.findByProps({ 'data-testid': 'chat-task-chip' })).toBeTruthy()
    expect(textOf(byId('chat-task-chip'))).toBe('Task Export')
    expect(textOf(identity.findByProps({ 'data-testid': 'chat-paused' }))).toStartWith('Paused: Provider limit on glm')
    act(() => byId('chat-task').props.onClick())
    expect(opened).toEqual(['task-1'])
  })

  test('clicking the name opens the rename field with the existing rename behavior', () => {
    const renames: string[] = []
    const { byId, allById } = renderHeader({ onRename: name => renames.push(name) })
    act(() => byId('chat-name').props.onClick())
    const input = byId('chat-name-input')
    act(() => input.props.onChange({ target: { value: '  New name  ' } }))
    act(() => byId('chat-name-input').props.onKeyDown({ key: 'Enter', preventDefault: () => {} }))
    expect(renames).toEqual(['New name'])
    expect(allById('chat-name-input')).toHaveLength(0)
  })

  test('projectName takes the last path segment', () => {
    expect(projectName('/home/coder/kawai')).toBe('kawai')
    expect(projectName('/home/coder/kawai/.worktrees/docs-chat-header-layout/')).toBe('docs-chat-header-layout')
    expect(projectName('/')).toBe('/')
  })
})

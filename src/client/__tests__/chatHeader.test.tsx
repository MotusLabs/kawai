// The chat header (chat-header-layout): identity and status block, panel
// switcher, the Auto-approve switch, the session menu, and the kill
// confirmation. Opening the menu or dialog needs a DOM; those flows run in
// tests/e2e/chat-header.spec.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import ChatHeader, { projectName, type ChatHeaderProps } from '../components/chat/ChatHeader'
import ChatKillDialog, { KillConfirmBody } from '../components/chat/ChatKillDialog'
import ChatPanelSwitcher from '../components/chat/ChatPanelSwitcher'
import { sessionMenuEntries, type SessionMenuEntry } from '../components/chat/ChatSessionMenu'
import ChatView from '../components/chat/ChatView'
import { Switch } from '../components/Switch'
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { chooseSessionMenuEntry, sessionMenuEntriesOf } from './support/sessionMenu'

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

const pressedOf = (button: TestRenderer.ReactTestInstance) => button.props['aria-pressed']

describe('panel switcher', () => {
  test('the group lists Tasks, Mailbox, Messages, and Strategy and presses the open one', () => {
    const toggled: string[] = []
    const { byId, update } = renderHeader({ openSlot: 'mailbox', onToggleSlot: slot => toggled.push(slot) })
    const group = byId('chat-panel-switcher')
    expect(group.props.role).toBe('group')
    expect(group.props['aria-label']).toBe('Side panels')
    const buttons = group.findAllByType('button')
    expect(buttons.map(button => textOf(button))).toEqual(['Tasks', 'Mailbox', 'Messages', 'Strategy'])
    expect(buttons.map(pressedOf)).toEqual([false, true, false, false])
    act(() => byId('chat-panel-tasks').props.onClick())
    expect(toggled).toEqual(['tasks'])
    update({ openSlot: 'tasks' })
    expect(byId('chat-panel-switcher').findAllByType('button').map(pressedOf)).toEqual([true, false, false, false])
  })

  test('choosing the open entry toggles it; nothing is pressed when no panel is open', () => {
    const toggled: string[] = []
    const { byId, update } = renderHeader({ openSlot: 'strategy', onToggleSlot: slot => toggled.push(slot) })
    act(() => byId('chat-panel-strategy').props.onClick())
    expect(toggled).toEqual(['strategy'])
    update({ openSlot: null })
    expect(byId('chat-panel-switcher').findAllByType('button').map(pressedOf)).toEqual([false, false, false, false])
  })

  test('the debug panel presses no switcher entry', () => {
    const { byId } = renderHeader({ openSlot: 'debug' })
    expect(byId('chat-panel-switcher').findAllByType('button').map(pressedOf)).toEqual([false, false, false, false])
  })
})

describe('icon-only switcher', () => {
  test('icon entries keep the panel name as accessible name and tooltip, and their pressed state', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatPanelSwitcher openSlot="messages" onToggle={() => {}} iconsOnly />) })
    const buttons = renderer.root.findAllByType('button')
    expect(buttons.map(button => button.props['aria-label'])).toEqual(['Tasks', 'Mailbox', 'Messages', 'Strategy'])
    expect(buttons.map(button => button.props.title)).toEqual(['Tasks', 'Mailbox', 'Messages', 'Strategy'])
    expect(buttons.map(pressedOf)).toEqual([false, false, true, false])
    for (const button of buttons) expect(button.findAll(node => typeof node === 'string' || node.type === 'svg').length).toBeGreaterThan(0)
    expect(buttons.map(button => textOf(button))).toEqual(['', '', '', ''])
  })
})

describe('approval switch', () => {
  const host = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-testid'] === 'chat-approval-policy')

  test('the switch reflects the policy and toggles it', () => {
    let toggles = 0
    const { renderer, update } = renderHeader({ onToggleApproval: () => { toggles += 1 } })
    expect(host(renderer)[0]!.props['aria-checked']).toBe(false)
    act(() => renderer.root.findByType(Switch).props.onCheckedChange(true))
    expect(toggles).toBe(1)
    update({ session: { ...session, approvalPolicy: 'auto' } as Session })
    expect(host(renderer)[0]!.props['aria-checked']).toBe(true)
    expect(host(renderer)[0]!.props.className).toContain('data-[checked]:bg-approval')
  })

  test('an archived chat shows no switch', () => {
    const { renderer } = renderHeader({ session: { ...session, archivedAt: '2026-10-01T00:00:00.000Z' } as Session })
    expect(host(renderer)).toHaveLength(0)
  })
})

describe('in ChatView', () => {
  afterEach(() => {
    act(() => {
      useTeamTaskStore.setState({ views: {} })
      useTeamMailboxStore.setState({ views: {} })
    })
  })

  test('the task chip opens the Tasks panel and presses Tasks in the switcher', () => {
    const chat = { ...session, taskId: 'task-1', taskTitle: 'Export' } as Session
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={chat} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />)
    })
    const pressed = () => renderer.root.findByProps({ 'data-testid': 'chat-panel-switcher' }).findAllByType('button').map(pressedOf)
    expect(pressed()).toEqual([false, false, false, false])
    act(() => renderer.root.findByProps({ 'data-testid': 'chat-task' }).props.onClick())
    expect(pressed()).toEqual([true, false, false, false])
    expect(useTeamTaskStore.getState().views['chat-1']?.selectedTaskId).toBe('task-1')
    act(() => renderer.root.findByProps({ 'data-testid': 'chat-panel-mailbox' }).props.onClick())
    expect(pressed()).toEqual([false, true, false, false])
    expect(useTeamTaskStore.getState().views['chat-1']?.open ?? false).toBe(false)
    act(() => renderer.unmount())
  })
})

describe('session menu entries', () => {
  const noop = () => {}
  const base = { openSlot: null, foldPanels: false, onRename: noop, onToggleSlot: noop, onArchive: noop, onKill: noop }
  const shape = (entries: SessionMenuEntry[]) =>
    entries.map(entry => entry.kind === 'separator' ? '---' : `${entry.label}${entry.kind === 'check' && entry.checked ? ' ✓' : ''}${entry.kind === 'item' && entry.danger ? ' !' : ''}`)

  test('a live chat lists Rename, Debug, Archive, and Kill session last and destructive', () => {
    expect(shape(sessionMenuEntries({ ...base, archived: false }))).toEqual(['Rename', 'Debug', '---', 'Archive', 'Kill session !'])
  })

  test('an archived chat has no Archive entry', () => {
    expect(shape(sessionMenuEntries({ ...base, archived: true }))).toEqual(['Rename', 'Debug', '---', 'Kill session !'])
  })

  test('Debug is checked while the debug panel is open and toggles the debug slot', () => {
    const toggled: string[] = []
    const entries = sessionMenuEntries({ ...base, archived: false, openSlot: 'debug', onToggleSlot: slot => toggled.push(slot) })
    const debug = entries.find(entry => entry.id === 'debug')!
    expect(debug).toMatchObject({ kind: 'check', checked: true })
    if (debug.kind === 'check') debug.onToggle()
    expect(toggled).toEqual(['debug'])
  })

  test('folded panels come first with their selected state', () => {
    const toggled: string[] = []
    const entries = sessionMenuEntries({ ...base, archived: false, openSlot: 'messages', foldPanels: true, onToggleSlot: slot => toggled.push(slot) })
    expect(shape(entries)).toEqual(['Tasks', 'Mailbox', 'Messages ✓', 'Strategy', '---', 'Rename', 'Debug', '---', 'Archive', 'Kill session !'])
    const tasks = entries[0]!
    if (tasks.kind === 'check') tasks.onToggle()
    expect(toggled).toEqual(['tasks'])
  })

  test('Rename keeps focus for the name field; other items return it to the trigger', () => {
    const entries = sessionMenuEntries({ ...base, archived: false })
    const items = entries.filter(entry => entry.kind === 'item')
    expect(items.map(entry => [entry.id, entry.kind === 'item' && (entry.keepFocus ?? false)])).toEqual([
      ['rename', true], ['archive', false], ['kill', false],
    ])
  })
})

describe('header session menu', () => {
  test('the header hands the menu its entries behind a labelled trigger; Rename opens the name field', () => {
    const archives: number[] = []
    const { renderer, allById } = renderHeader({ onArchive: () => archives.push(1) })
    const trigger = renderer.root.find(node => typeof node.type === 'string' && node.props['data-testid'] === 'chat-session-menu')
    expect(trigger.props['aria-label']).toBe('Session actions')
    expect(trigger.props['aria-haspopup']).toBe('menu')
    // Debug, Archive, and Kill session are no longer header buttons.
    for (const name of ['Debug', 'Archive', 'Kill session']) {
      expect(renderer.root.findAllByType('button').filter(button => textOf(button) === name)).toHaveLength(0)
    }
    act(() => chooseSessionMenuEntry(renderer.root, 'archive'))
    expect(archives).toEqual([1])
    act(() => chooseSessionMenuEntry(renderer.root, 'rename'))
    expect(allById('chat-name-input')).toHaveLength(1)
  })
})

describe('kill confirmation body', () => {
  test('names the session, says the removal is permanent, and only Kill confirms', () => {
    const calls: string[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<KillConfirmBody name="My chat" onCancel={() => calls.push('cancel')} onConfirm={() => calls.push('kill')} />)
    })
    expect(textOf(renderer.root.findByType('p'))).toBe('Kill “My chat”? This permanently removes the chat session from kawai. Archive keeps it instead.')
    const [cancel, kill] = renderer.root.findAllByType('button')
    expect(textOf(cancel!)).toBe('Cancel')
    expect(textOf(kill!)).toBe('Kill')
    expect(kill!.props.className).toContain('btn-danger')
    act(() => cancel!.props.onClick())
    expect(calls).toEqual(['cancel'])
    act(() => kill!.props.onClick())
    expect(calls).toEqual(['cancel', 'kill'])
  })

  test('the closed dialog renders nothing', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatKillDialog open={false} name="My chat" container={{ current: null }} onOpenChange={() => {}} onConfirm={() => {}} />)
    })
    expect(renderer.toJSON()).toBeNull()
  })
})

describe('width layouts', () => {
  const usage = {
    usedTokens: 47_700, thresholdTokens: 967_000, percentage: 4.93, thresholdApproximate: false, at: '2026-10-13T10:00:00.000Z',
  } as unknown as NonNullable<ChatHeaderProps['contextUsage']>
  const switcherButtons = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByProps({ 'data-testid': 'chat-panel-switcher' }).flatMap(group => group.findAllByType('button'))

  test('full: labelled entries and the full context meter', () => {
    const { renderer, byId } = renderHeader({ layout: 'full', contextUsage: usage })
    expect(switcherButtons(renderer).map(button => textOf(button))).toEqual(['Tasks', 'Mailbox', 'Messages', 'Strategy'])
    expect(textOf(byId('chat-context-meter'))).toBe('Context 4.9% · 47.7k / 967k')
    expect(sessionMenuEntriesOf(renderer.root).some(entry => entry.id.startsWith('panel-'))).toBe(false)
  })

  test('icons: icon entries named by their panel, full meter', () => {
    const { renderer, byId } = renderHeader({ layout: 'icons', contextUsage: usage })
    expect(switcherButtons(renderer).map(button => button.props['aria-label'])).toEqual(['Tasks', 'Mailbox', 'Messages', 'Strategy'])
    expect(switcherButtons(renderer).map(button => textOf(button))).toEqual(['', '', '', ''])
    expect(textOf(byId('chat-context-meter'))).toBe('Context 4.9% · 47.7k / 967k')
  })

  test('menu: panels fold into the session menu with their state, the meter shows its percentage, the rest stays', () => {
    const { renderer, byId } = renderHeader({ layout: 'menu', contextUsage: usage, openSlot: 'tasks' })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-panel-switcher' })).toHaveLength(0)
    const panels = sessionMenuEntriesOf(renderer.root).filter(entry => entry.id.startsWith('panel-'))
    expect(panels.map(entry => entry.kind === 'check' && [entry.label, entry.checked])).toEqual([
      ['Tasks', true], ['Mailbox', false], ['Messages', false], ['Strategy', false],
    ])
    const meter = byId('chat-context-meter')
    expect(textOf(meter)).toBe('4.9%')
    expect(meter.props.title).toContain('47700 of 967000 tokens')
    // Name, status, the Auto-approve switch, and the menu stay in the header.
    expect(textOf(byId('chat-name'))).toBe('Kawai Chat header buttons')
    expect(textOf(byId('chat-status'))).toBe('working')
    expect(renderer.root.findAllByType(Switch)).toHaveLength(1)
    expect(renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-testid'] === 'chat-session-menu')).toHaveLength(1)
  })

  test('an approximate threshold keeps its marker in the compact meter', () => {
    const { byId } = renderHeader({ layout: 'menu', contextUsage: { ...usage, thresholdApproximate: true } })
    expect(textOf(byId('chat-context-meter'))).toBe('4.9%~')
  })
})

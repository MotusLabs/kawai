// The chat header (chat-header-layout, team-workspace-pages 4.1): identity
// and status block, the one **Team** button (the side slot hosts only the
// debug panel; the team views live on the Team page), the Auto-approve
// switch, the session menu, and the kill confirmation. Opening the menu or
// dialog needs a DOM; those flows run in tests/e2e/chat-header.spec.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import ChatHeader, { projectName, type ChatHeaderProps } from '../components/chat/ChatHeader'
import ChatKillDialog, { KillConfirmBody } from '../components/chat/ChatKillDialog'
import { sessionMenuEntries, type SessionMenuEntry } from '../components/chat/ChatSessionMenu'
import ChatView from '../components/chat/ChatView'
import { Switch } from '../components/Switch'
import { useSessionStore } from '../stores/sessionStore'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
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
    debugOpen: false, onToggleDebug: () => {}, onOpenTeam: () => {}, onOpenTask: () => {}, onRename: () => {},
    onToggleApproval: () => {}, onArchive: () => {}, onKill: () => {}, onClose: () => {}, ...overrides,
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
    // The basename shows; the full path is on hover and read by assistive technology.
    expect(textOf(byId('chat-project'))).toBe('kawai (/home/coder/kawai)')
    expect(textOf(byId('chat-project').findByProps({ className: 'sr-only' }))).toBe(' (/home/coder/kawai)')
    expect(byId('chat-project').props.title).toBe('/home/coder/kawai')
    expect(textOf(byId('chat-identity'))).toBe('Default·claude-opus-5-5·kawai (/home/coder/kawai)')
  })

  test('no model segment before the agent reports one', () => {
    const { allById, byId } = renderHeader({ model: null })
    expect(allById('chat-model')).toHaveLength(0)
    expect(textOf(byId('chat-identity'))).toBe('Default·kawai (/home/coder/kawai)')
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

  test('task and paused context get their own wrapping row; the task chip opens the task', () => {
    const opened: string[] = []
    const until = new Date(Date.now() + 40 * 60_000).toISOString()
    const { byId } = renderHeader({
      session: { ...session, taskId: 'task-1', taskTitle: 'Export', parked: { messageId: 'm1', until, profileId: 'glm', reason: 'Provider limit on glm' } } as Session,
      onOpenTask: taskId => opened.push(taskId),
    })
    const context = byId('chat-context-row')
    expect(byId('chat-identity').findAllByProps({ 'data-testid': 'chat-task-chip' })).toHaveLength(0)
    expect(context.findByProps({ 'data-testid': 'chat-task-chip' })).toBeTruthy()
    expect(textOf(byId('chat-task-chip'))).toBe('Task Export')
    expect(textOf(context.findByProps({ 'data-testid': 'chat-paused' }))).toStartWith('Paused: Provider limit on glm')
    act(() => byId('chat-task').props.onClick())
    expect(opened).toEqual(['task-1'])
  })

  test('no task or pause: no empty context row', () => {
    const { allById } = renderHeader()
    expect(allById('chat-context-row')).toHaveLength(0)
  })

  test('a spawned member keeps its provenance in the context row', () => {
    const { byId } = renderHeader({ session: { ...session, taskId: 'task-1', taskTitle: 'Export', spawned: true } as Session })
    expect(textOf(byId('chat-task-chip'))).toBe('Spawned for task Export')
  })

  test('long metadata and task labels break inside themselves instead of clipping', () => {
    const long = 'x'.repeat(120)
    const { byId } = renderHeader({
      profileLabel: long, model: long,
      session: { ...session, projectPath: `/home/${long}`, taskId: 'task-1', taskTitle: long } as Session,
    })
    for (const id of ['chat-profile', 'chat-model', 'chat-project', 'chat-task-chip']) {
      expect(byId(id).props.className).toContain('[overflow-wrap:anywhere]')
      expect(byId(id).props.className).not.toContain('truncate')
    }
    // Rows wrap; nothing in the metadata forbids it.
    expect(byId('chat-identity').props.className).toContain('flex-wrap')
    expect(byId('chat-context-row').props.className).toContain('flex-wrap')
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

describe('Team button (4.1)', () => {
  test('one Team button, no team switcher, present for archived and plain-directory chats', () => {
    const opened: string[] = []
    const { byId, renderer } = renderHeader({ onOpenTeam: () => opened.push('team') })
    expect(textOf(byId('chat-team-button'))).toBe('Team')
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-panel-switcher' })).toHaveLength(0)
    for (const slot of ['chat-panel-tasks', 'chat-panel-mailbox', 'chat-panel-messages', 'chat-panel-strategy']) {
      expect(renderer.root.findAllByProps({ 'data-testid': slot })).toHaveLength(0)
    }
    act(() => byId('chat-team-button').props.onClick())
    expect(opened).toEqual(['team'])
    // Archived chats and plain-directory teams keep the button.
    const archived = renderHeader({ session: { ...session, archivedAt: '2026-10-01T00:00:00.000Z' } as Session })
    expect(archived.byId('chat-team-button')).toBeTruthy()
    const plain = renderHeader({ session: { ...session, projectPath: '/plain/project' } as Session })
    expect(plain.byId('chat-team-button')).toBeTruthy()
  })

  test('icon-only Team keeps its accessible name and tooltip', () => {
    const { byId } = renderHeader({ layout: 'icons' })
    const button = byId('chat-team-button')
    expect(button.props['aria-label']).toBe('Team')
    expect(button.props.title).toBe('Team')
    expect(textOf(button)).toBe('')
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
    useSessionStore.setState({ sessions: [], selectedSessionId: null, selectedHibernatingSessionId: null })
    resetTeamLocationForTests()
  })

  test('the Team button and the task chip open the Team page; no team view mounts in a chat', () => {
    const chat = { ...session, taskId: 'task-1', taskTitle: 'Export' } as Session
    act(() => { useSessionStore.setState({ sessions: [chat], selectedSessionId: chat.id }) })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={chat} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}}
        onOpenTeam={teamKey => useTeamLocationStore.getState().navigate({ teamKey, tab: 'tasks' })}
        onOpenTask={(teamKey, taskId) => useTeamLocationStore.getState().navigate({ teamKey, tab: 'tasks', id: taskId })} />)
    })
    // No team view mounts in the chat: the side slot hosts only Debug.
    expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(0)
    // The task chip opens the Team page's Tasks tab with that task.
    act(() => renderer.root.findByProps({ 'data-testid': 'chat-task' }).props.onClick())
    expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/home/coder/kawai', tab: 'tasks', id: 'task-1' })
    // The Team button opens the page on the last-used tab without an id.
    act(() => renderer.root.findByProps({ 'data-testid': 'chat-team-button' }).props.onClick())
    expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/home/coder/kawai', tab: 'tasks' })
    act(() => renderer.unmount())
  })

  test('Debug toggles from the session menu and mounts the only side-slot panel', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={session} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />)
    })
    act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(1)
    act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(0)
    act(() => renderer.unmount())
  })
})

describe('session menu entries', () => {
  const noop = () => {}
  const base = { debugOpen: false, foldTeam: false, onOpenTeam: noop, onRename: noop, onToggleDebug: noop, onArchive: noop, onKill: noop }
  const shape = (entries: SessionMenuEntry[]) =>
    entries.map(entry => entry.kind === 'separator' ? '---' : `${entry.label}${entry.kind === 'check' && entry.checked ? ' ✓' : ''}${entry.kind === 'item' && entry.danger ? ' !' : ''}`)

  test('a live chat lists Rename, Debug, Archive, and Kill session last and destructive', () => {
    expect(shape(sessionMenuEntries({ ...base, archived: false }))).toEqual(['Rename', 'Debug', '---', 'Archive', 'Kill session !'])
  })

  test('an archived chat has no Archive entry', () => {
    expect(shape(sessionMenuEntries({ ...base, archived: true }))).toEqual(['Rename', 'Debug', '---', 'Kill session !'])
  })

  test('Debug is checked while the debug panel is open and toggles it', () => {
    const toggled: number[] = []
    const entries = sessionMenuEntries({ ...base, archived: false, debugOpen: true, onToggleDebug: () => toggled.push(1) })
    const debug = entries.find(entry => entry.id === 'debug')!
    expect(debug).toMatchObject({ kind: 'check', checked: true })
    if (debug.kind === 'check') debug.onToggle()
    expect(toggled).toEqual([1])
  })

  test('the folded Team item comes first in the narrowest layout', () => {
    const opened: string[] = []
    const entries = sessionMenuEntries({ ...base, archived: false, foldTeam: true, onOpenTeam: () => opened.push('team') })
    expect(shape(entries)).toEqual(['Team', '---', 'Rename', 'Debug', '---', 'Archive', 'Kill session !'])
    const team = entries[0]!
    if (team.kind === 'item') team.onSelect()
    expect(opened).toEqual(['team'])
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

  test('full: the labelled Team button and the full context meter', () => {
    const { renderer, byId } = renderHeader({ layout: 'full', contextUsage: usage })
    expect(textOf(byId('chat-team-button'))).toBe('Team')
    expect(textOf(byId('chat-context-meter'))).toBe('Context 4.9% · 47.7k / 967k')
    expect(sessionMenuEntriesOf(renderer.root).some(entry => entry.id === 'team')).toBe(false)
  })

  test('icons: the icon Team button named Team, full meter', () => {
    const { byId } = renderHeader({ layout: 'icons', contextUsage: usage })
    expect(byId('chat-team-button').props['aria-label']).toBe('Team')
    expect(textOf(byId('chat-team-button'))).toBe('')
    expect(textOf(byId('chat-context-meter'))).toBe('Context 4.9% · 47.7k / 967k')
  })

  test('menu: Team folds into the session menu, the meter shows its percentage, the rest stays', () => {
    const { renderer, byId } = renderHeader({ layout: 'menu', contextUsage: usage })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-team-button' })).toHaveLength(0)
    const team = sessionMenuEntriesOf(renderer.root).filter(entry => entry.id === 'team')
    expect(team.map(entry => entry.kind === 'item' && entry.label)).toEqual(['Team'])
    const meter = byId('chat-context-meter')
    expect(textOf(meter.findByProps({ 'aria-hidden': 'true' }))).toBe('4.9%')
    expect(meter.props.title).toContain('47700 of 967000 tokens')
    // The full counts stay available to assistive technology, not only on hover.
    expect(textOf(meter.findByProps({ className: 'sr-only' }))).toBe('Context 4.9% · 47700 of 967000 tokens')
    // Name, status, the Auto-approve switch, and the menu stay in the header.
    expect(textOf(byId('chat-name'))).toBe('Kawai Chat header buttons')
    expect(textOf(byId('chat-status'))).toBe('working')
    expect(renderer.root.findAllByType(Switch)).toHaveLength(1)
    expect(renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-testid'] === 'chat-session-menu')).toHaveLength(1)
  })

  test('an approximate threshold keeps its marker in the compact meter', () => {
    const { byId } = renderHeader({ layout: 'menu', contextUsage: { ...usage, thresholdApproximate: true } })
    const meter = byId('chat-context-meter')
    expect(textOf(meter.findByProps({ 'aria-hidden': 'true' }))).toBe('4.9%')
    expect(textOf(meter)).toEndWith('~')
  })
})

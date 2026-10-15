// The chat side slot (chat-header-layout D2): one derived open slot and one
// toggle over the five panel stores. Debug belongs to the chat; the team
// panels to the chat's team key (team-workspace-pages D2).
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { readOpenSideSlot, toggleSideSlot, useOpenSideSlot, type SideSlot, type SlotOwner } from '../components/chat/sideSlot'
import { useChatDebugStore } from '../stores/chatDebugStore'
import { useStrategyStore } from '../stores/strategyStore'
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamMessageStore } from '../stores/teamMessageStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'

afterEach(() => {
  act(() => {
    useChatDebugStore.setState({ views: {} })
    useTeamMailboxStore.setState({ views: {} })
    useTeamTaskStore.setState({ views: {} })
    useTeamMessageStore.setState({ views: {} })
    useStrategyStore.setState({ views: {} })
  })
})

const SLOTS: SideSlot[] = ['debug', 'mailbox', 'tasks', 'messages', 'strategy']

const chat1 = { sessionId: 'chat-1', teamKey: '/repo' }
const chat2 = { sessionId: 'chat-2', teamKey: '/other' }
// Another chat of chat-1's team.
const chat3 = { sessionId: 'chat-3', teamKey: '/repo' }

const openFlags = (owner: SlotOwner) => ({
  debug: useChatDebugStore.getState().views[owner.sessionId]?.open ?? false,
  mailbox: useTeamMailboxStore.getState().views[owner.teamKey]?.open ?? false,
  tasks: useTeamTaskStore.getState().views[owner.teamKey]?.open ?? false,
  messages: useTeamMessageStore.getState().views[owner.teamKey]?.open ?? false,
  strategy: useStrategyStore.getState().views[owner.teamKey]?.open ?? false,
})

test('toggling a slot shows it and closes the others — except that Debug leaves the team’s panel open beneath it', () => {
  for (const first of SLOTS) {
    for (const second of SLOTS) {
      if (first === second) continue
      act(() => { toggleSideSlot(first, chat1) })
      act(() => { toggleSideSlot(second, chat1) })
      const flags = openFlags(chat1)
      const kept = second === 'debug' ? first : null
      for (const slot of SLOTS) expect(flags[slot]).toBe(slot === second || slot === kept)
      expect(readOpenSideSlot(chat1)).toBe(second)
      act(() => { toggleSideSlot(second, chat1) })
      // Closing Debug shows the team panel it was opened over.
      expect(readOpenSideSlot(chat1)).toBe(kept)
      if (kept) act(() => { toggleSideSlot(kept, chat1) })
    }
  }
})

test('toggling the open slot closes it', () => {
  for (const slot of SLOTS) {
    act(() => { toggleSideSlot(slot, chat1) })
    expect(readOpenSideSlot(chat1)).toBe(slot)
    act(() => { toggleSideSlot(slot, chat1) })
    expect(readOpenSideSlot(chat1)).toBeNull()
  }
})

test('slots are per team: another team keeps its own panel', () => {
  act(() => { toggleSideSlot('tasks', chat1) })
  act(() => { toggleSideSlot('mailbox', chat2) })
  expect(readOpenSideSlot(chat1)).toBe('tasks')
  expect(readOpenSideSlot(chat2)).toBe('mailbox')
})

test('a team panel is shared by every chat of the team; Debug stays with its chat and shows first', () => {
  act(() => { toggleSideSlot('tasks', chat1) })
  expect(readOpenSideSlot(chat3)).toBe('tasks')
  act(() => { toggleSideSlot('debug', chat1) })
  // chat-1 shows its own Debug; the team's Tasks stays open for chat-3.
  expect(readOpenSideSlot(chat1)).toBe('debug')
  expect(readOpenSideSlot(chat3)).toBe('tasks')
  // Choosing Tasks in chat-1 closes chat-1's Debug and keeps the team's Tasks.
  act(() => { toggleSideSlot('tasks', chat1) })
  expect(readOpenSideSlot(chat1)).toBe('tasks')
  expect(openFlags(chat1).debug).toBe(false)
  expect(readOpenSideSlot(chat3)).toBe('tasks')
})

test('useOpenSideSlot follows opens from outside the toggle, such as a task link', () => {
  const seen: Array<SideSlot | null> = []
  function Probe() {
    seen.push(useOpenSideSlot(chat1))
    return null
  }
  act(() => { TestRenderer.create(<Probe />) })
  expect(seen.at(-1)).toBeNull()
  act(() => { useTeamTaskStore.getState().open('/repo', 'task-7') })
  expect(seen.at(-1)).toBe('tasks')
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBe('task-7')
  act(() => { toggleSideSlot('strategy', chat1) })
  expect(seen.at(-1)).toBe('strategy')
  act(() => { toggleSideSlot('strategy', chat1) })
  expect(seen.at(-1)).toBeNull()
})

// The chat side slot (chat-header-layout D2): one derived open slot and one
// toggle over the five panel stores.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { readOpenSideSlot, toggleSideSlot, useOpenSideSlot, type SideSlot } from '../components/chat/sideSlot'
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

const openFlags = (sessionId: string) => ({
  debug: useChatDebugStore.getState().views[sessionId]?.open ?? false,
  mailbox: useTeamMailboxStore.getState().views[sessionId]?.open ?? false,
  tasks: useTeamTaskStore.getState().views[sessionId]?.open ?? false,
  messages: useTeamMessageStore.getState().views[sessionId]?.open ?? false,
  strategy: useStrategyStore.getState().views[sessionId]?.open ?? false,
})

test('toggling a slot opens it and closes every other slot', () => {
  for (const first of SLOTS) {
    for (const second of SLOTS) {
      if (first === second) continue
      act(() => { toggleSideSlot(first, 'chat-1') })
      act(() => { toggleSideSlot(second, 'chat-1') })
      const flags = openFlags('chat-1')
      for (const slot of SLOTS) expect(flags[slot]).toBe(slot === second)
      expect(readOpenSideSlot('chat-1')).toBe(second)
      act(() => { toggleSideSlot(second, 'chat-1') })
    }
  }
})

test('toggling the open slot closes it', () => {
  for (const slot of SLOTS) {
    act(() => { toggleSideSlot(slot, 'chat-1') })
    expect(readOpenSideSlot('chat-1')).toBe(slot)
    act(() => { toggleSideSlot(slot, 'chat-1') })
    expect(readOpenSideSlot('chat-1')).toBeNull()
  }
})

test('slots are per session', () => {
  act(() => { toggleSideSlot('tasks', 'chat-1') })
  act(() => { toggleSideSlot('mailbox', 'chat-2') })
  expect(readOpenSideSlot('chat-1')).toBe('tasks')
  expect(readOpenSideSlot('chat-2')).toBe('mailbox')
})

test('useOpenSideSlot follows opens from outside the toggle, such as a task link', () => {
  const seen: Array<SideSlot | null> = []
  function Probe() {
    seen.push(useOpenSideSlot('chat-1'))
    return null
  }
  act(() => { TestRenderer.create(<Probe />) })
  expect(seen.at(-1)).toBeNull()
  act(() => { useTeamTaskStore.getState().open('chat-1', 'task-7') })
  expect(seen.at(-1)).toBe('tasks')
  expect(useTeamTaskStore.getState().views['chat-1']?.selectedTaskId).toBe('task-7')
  act(() => { toggleSideSlot('strategy', 'chat-1') })
  expect(seen.at(-1)).toBe('strategy')
  act(() => { toggleSideSlot('strategy', 'chat-1') })
  expect(seen.at(-1)).toBeNull()
})

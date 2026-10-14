// Test access to the chat header's session menu (chat-header-layout D4). The
// menu popup needs a DOM, which the test renderer lacks, so tests act on the
// entries the header hands to ChatSessionMenu: they are exactly what the
// popup renders.
import type { ReactTestInstance } from 'react-test-renderer'
import ChatSessionMenu, { type SessionMenuEntry } from '../../components/chat/ChatSessionMenu'

export function sessionMenuEntriesOf(root: ReactTestInstance): SessionMenuEntry[] {
  return root.findByType(ChatSessionMenu).props.entries as SessionMenuEntry[]
}

export function sessionMenuEntry(root: ReactTestInstance, id: string): SessionMenuEntry | undefined {
  return sessionMenuEntriesOf(root).find(entry => entry.id === id)
}

/** Choose a menu entry the way a click would: select an item, toggle a check. */
export function chooseSessionMenuEntry(root: ReactTestInstance, id: string) {
  const entry = sessionMenuEntry(root, id)
  if (!entry || entry.kind === 'separator') throw new Error(`No session menu entry ${id}`)
  if (entry.kind === 'item') entry.onSelect()
  else entry.onToggle()
}

// Opens a chat search result (chat-session-search D5): selects the chat, and
// for a snippet asks its chat view to scroll to and highlight the matched
// transcript row. A header only opens the chat.
import type { SearchItem } from '../stores/sessionSearchStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'

export function openSearchItem(item: SearchItem): void {
  useSessionStore.getState().setSelectedSessionId(item.sessionId)
  if (item.kind === 'snippet') useChatStore.getState().requestReveal(item.sessionId, item.anchorId)
  else useChatStore.getState().clearReveal()
}

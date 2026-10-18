// Text for a chat session flagged context-exhausted (chat-context-exhaustion
// D9): the CLI's terminal reason and what clears it.
import type { ChatContextExhausted } from '@shared/chat'

export function contextExhaustedLabel(flag: ChatContextExhausted): string {
  return `Context exhausted (${flag.reason}) · Run /compact or start a new session`
}

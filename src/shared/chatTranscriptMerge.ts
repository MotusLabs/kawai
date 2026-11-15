// The chat transcript's continuation rule (fast-chat-switching D1, hazard
// "Merge predicate drift"): the one definition of when an assistant text
// event continues the previous entry. The client fold (`applyChatEvents`)
// and the server's history part walk both import it, so a history cut can
// never split an entry the client would have merged.
import type { ChatEvent } from './chat'

/** The assistant text kinds that merge into one continuing entry (D5). */
export type ContinuableChatEvent = Extract<ChatEvent, { type: 'assistant_text' | 'assistant_delta' }>

/**
 * One entry per text block (chat-transcript-layout D5): an assistant text or
 * delta event continues only the newest entry of its own message and turn —
 * exactly equal messageId and turnId, an existing previous entry — so text
 * after a tool call becomes its own entry in order. Anything else starts a
 * new entry.
 */
export function continuesEntry(prev: ChatEvent | undefined, next: ChatEvent): prev is ContinuableChatEvent {
  return (next.type === 'assistant_text' || next.type === 'assistant_delta') &&
    prev !== undefined &&
    (prev.type === 'assistant_text' || prev.type === 'assistant_delta') &&
    prev.messageId === next.messageId && prev.turnId === next.turnId
}

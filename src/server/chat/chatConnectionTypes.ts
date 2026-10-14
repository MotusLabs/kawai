// The client message types ChatConnections.handle owns. One list serves both
// the WS router (forward on membership, so nothing falls through to
// 'Unknown message type') and the structural test that guards the wiring.
// Completeness is a compile-time fact: a ClientMessage type added under one of
// the prefixes handle() dispatches on must appear here, or the file stops
// typechecking.
import type { ClientMessage } from '../../shared/types'

/** Everything `ChatConnections.handle` dispatches on, by its prefixes. */
export type ChatConnectionMessage = Extract<
  ClientMessage,
  {
    type:
      | `chat-${string}`
      | `team-mailbox-${string}`
      | `team-task${string}`
      | `team-message${string}`
      | `team-thread${string}`
      | `strategy-${string}`
  }
>

export const CHAT_CONNECTION_TYPES = [
  'chat-attach',
  'chat-detach',
  'chat-send',
  'chat-interrupt',
  'chat-archive',
  'chat-restore',
  'chat-approval',
  'chat-answer',
  'chat-set-approval-policy',
  'chat-debug-open',
  'chat-debug-page',
  'chat-debug-close',
  'chat-worker-transcript',
  'chat-task-output',
  'chat-task-stop',
  'chat-dismiss-notification',
  'team-mailbox-open',
  'team-mailbox-close',
  'team-mailbox-cancel',
  'team-mailbox-retry',
  'team-mailbox-discard',
  'team-mailbox-reload-rules',
  'team-mailbox-hand-off',
  'team-tasks-open',
  'team-tasks-close',
  'team-task-open',
  'team-task-close',
  'team-task-create',
  'team-task-draft',
  'team-task-publish',
  'team-task-notify',
  'team-task-accept-result',
  'team-task-handoff',
  'team-task-note',
  'team-task-status',
  'team-task-assign',
  'team-task-preview',
  'team-task-targets',
  'team-messages-open',
  'team-messages-close',
  'team-thread-open',
  'team-thread-close',
  'team-message-send',
  'strategy-open',
  'strategy-close',
  'strategy-save-draft',
  'strategy-submit',
  'strategy-approve',
  'strategy-withdraw',
] as const satisfies readonly ChatConnectionMessage['type'][]

// Compile-time completeness: every handled type is listed above. The alias
// only resolves to `true` when the Exclude is empty, and `Expect` rejects
// anything else — so an unlisted type is a type error here, not a silent
// 'Unknown message type' in production.
type Unlisted = Exclude<ChatConnectionMessage['type'], (typeof CHAT_CONNECTION_TYPES)[number]>
type Expect<T extends true> = T
type _ChatConnectionTypesComplete = Expect<Unlisted extends never ? true : ['unlisted', Unlisted]>

export function isChatConnectionMessage(
  message: ClientMessage
): message is ChatConnectionMessage {
  return (CHAT_CONNECTION_TYPES as readonly string[]).includes(message.type)
}

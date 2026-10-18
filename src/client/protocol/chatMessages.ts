// One-line store dispatches for the chat-* and debug message families,
// mirroring the server's additive chat message naming.
import { useChatStore } from '../stores/chatStore'
import { useChatDebugStore } from '../stores/chatDebugStore'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

type ChatMessage = Extract<ServerMessage, { type: `chat-${string}` }>

export function handleChatMessage(message: ChatMessage, _deps: MessageRouterDeps): void {
  const chat = useChatStore.getState()
  switch (message.type) {
    case 'chat-events': chat.apply(message.sessionId, message.events); return
    case 'chat-snapshot': chat.snapshot(message); return
    // One history page (chat-history-window D3): the store folds, dedupes,
    // and prepends it; on `stale` it re-attaches plain through the sender.
    case 'chat-history-page': chat.applyHistoryPage(message, _deps.sendClient); return
    case 'chat-commands': chat.setCommands(message); return
    case 'chat-activity': chat.setActivity(message.sessionId, message.activity); return
    case 'chat-context-usage': chat.setContextUsage(message.sessionId, message.usage); return
    case 'chat-usage': chat.setUsage(message.profileId, message.report); return
    case 'chat-workers': chat.setWorkers(message.sessionId, message.workers); return
    case 'chat-background-tasks': chat.setBackgroundTasks(message.sessionId, message.tasks); return
    case 'chat-notifications': chat.setNotifications(message.sessionId, message.notifications); return
    case 'chat-worker-transcript': chat.setWorkerBody(message); return
    case 'chat-task-output': chat.setTaskOutput(message); return
    case 'chat-model': chat.setModel(message.sessionId, message.model); return
    case 'chat-debug-frames': useChatDebugStore.getState().apply(message); return
  }
}

// Picks a chat driver from the chat's stored runtime (openspec
// codex-chat-sessions design D1): the caller passes `record.runtime`. The
// Claude driver is wired today; the Codex driver arrives with the change
// that wires it into the manager. A runtime with no wired driver throws — a
// chat must never silently start as something it is not. The deps are the
// Claude options object while Claude is the only runtime; per-runtime deps
// arrive with the drivers that need them.
import { ChatSessionDriver, type ChatSessionDriverOptions } from '../ChatSessionDriver'
import type { ChatAgentDriver, ChatRuntime } from './driver'

export function createChatDriver(
  runtime: ChatRuntime,
  deps: ChatSessionDriverOptions
): ChatAgentDriver {
  switch (runtime) {
    case 'claude':
      return new ChatSessionDriver(deps)
    default:
      // `codex` lands here too until its wiring change; anything else is a
      // stored value no build of kawai ever wrote.
      throw new Error(`No chat driver for runtime "${String(runtime)}" (wired runtimes: claude)`)
  }
}

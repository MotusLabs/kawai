// Picks a chat driver from the chat's stored runtime (openspec
// codex-chat-sessions design D1): the caller passes `record.runtime` with
// that runtime's options. `claude` builds the SDK-backed ChatSessionDriver,
// `codex` the app-server-backed CodexSessionDriver (task 5.6). A runtime
// with no wired driver throws — a chat must never silently start as
// something it is not.
import { ChatSessionDriver, type ChatSessionDriverOptions } from '../ChatSessionDriver'
import { CodexSessionDriver } from '../codex/CodexSessionDriver'
import type { CodexSessionDriverOptions } from '../codex/codexThread'
import type { ChatAgentDriver, ChatDriverCallbacks, ChatRuntime } from './driver'

/**
 * The options every runtime's driver takes: identity, the audit observer,
 * the prompt, effort, and policy readers, and the output callbacks.
 */
export type ChatDriverSharedOptions = Pick<
  ChatSessionDriverOptions & CodexSessionDriverOptions,
  'sessionId' | 'projectPath' | 'outbound' | 'getSystemPromptAppend' | 'getApprovalPolicy' | 'getEffort'
> & ChatDriverCallbacks

/** One runtime and the options its driver takes. */
export type ChatDriverDeps =
  | { runtime: 'claude'; options: ChatSessionDriverOptions }
  | { runtime: 'codex'; options: CodexSessionDriverOptions }

export function createChatDriver(deps: ChatDriverDeps): ChatAgentDriver {
  const runtime: ChatRuntime = deps.runtime
  switch (deps.runtime) {
    case 'claude':
      return new ChatSessionDriver(deps.options)
    case 'codex':
      return new CodexSessionDriver(deps.options)
    default:
      // A stored value no build of kawai ever wrote.
      throw new Error(`No chat driver for runtime "${String(runtime)}" (wired runtimes: claude, codex)`)
  }
}

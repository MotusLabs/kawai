// The chat driver suites' shared pieces: a scriptable stand-in for the SDK
// query() and the frame builders. The driver they run is Kawai's production
// composition, built by claudeRuntimeHarness.ts (re-exported below).
import type {
  Options,
  Query,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../../shared/chat'

/**
 * Minimal scriptable Query stand-in. The test pushes SDK messages into the
 * stream and pulls prompt (user turn) messages out explicitly, so queue
 * semantics (fold, clear-on-stop) are observable.
 */
export interface FakeQueryHandle {
  query: Query
  /** Captured query options (cwd, systemPrompt, canUseTool, ...). */
  options: Options
  /** Push an SDK message into the driver's stream. */
  push: (message: SDKMessage) => void
  /** Pull the next user turn the driver submitted (null when none waiting). */
  pullPrompt: () => Promise<SDKUserMessage | null>
  /** The prompt stream the driver feeds (for an unbounded pull). */
  prompt: AsyncIterable<SDKUserMessage>
  interrupts: number
  /** Each interrupt's options (the driver's cancel_queued choice). */
  interruptOptions: Array<{ cancelQueued?: boolean } | undefined>
  /** The receipt the next interrupts resolve to (undefined: an older CLI's). */
  interruptReceipt?: SDKControlInterruptResponse
  closed: boolean
  /** End the stream as the real process would on exit/crash. */
  exit: () => void
  /** Calls to the usage control (0 when the driver never pulled). */
  usageCalls: Array<{ skipBehaviors?: boolean }>
  /** Calls to the context-usage control (attach and turn boundaries). */
  contextCalls: Array<{ detail?: string }>
}

/** The usage control implementation a test injects into a fake query. */
export type FakeUsageControl = (opts: {
  skipBehaviors?: boolean
}) => Promise<unknown>

/** The context-usage control implementation a test injects into a fake query. */
export type FakeContextControl = (opts: {
  detail?: string
}) => Promise<unknown>

export function createFakeQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
  usageImpl?: FakeUsageControl,
  contextImpl?: FakeContextControl
): FakeQueryHandle {
  const messages: SDKMessage[] = []
  let resolveMessage: ((result: IteratorResult<SDKMessage>) => void) | null = null
  let ended = false
  const handle = {
    interrupts: 0,
    interruptOptions: [] as Array<{ cancelQueued?: boolean } | undefined>,
    closed: false,
    usageCalls: [] as Array<{ skipBehaviors?: boolean }>,
    contextCalls: [] as Array<{ detail?: string }>,
  } as FakeQueryHandle

  const stream = async function* (): AsyncGenerator<SDKMessage, void> {
    while (true) {
      const next = await new Promise<IteratorResult<SDKMessage>>((resolve) => {
        if (messages.length > 0) {
          resolve({ value: messages.shift()!, done: false })
        } else if (ended) {
          resolve({ value: undefined, done: true })
        } else {
          resolveMessage = resolve
        }
      })
      if (next.done) return
      yield next.value
    }
  }

  const query = Object.assign(stream(), {
    interrupt: (options?: { cancelQueued?: boolean }) => {
      handle.interrupts += 1
      handle.interruptOptions.push(options)
      return Promise.resolve(handle.interruptReceipt)
    },
    close: () => {
      handle.closed = true
      ended = true
      resolveMessage?.({ value: undefined, done: true })
    },
    // The unstable usage control: attached only when a test provides one, so
    // the default fake exercises the driver's missing-method path.
    ...(usageImpl
      ? {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (
            opts: { skipBehaviors?: boolean }
          ) => {
            handle.usageCalls.push(opts)
            return usageImpl(opts)
          },
        }
      : {}),
    // The context-usage control: attached only when a test provides one, so
    // the default fake exercises the driver's missing-method path.
    ...(contextImpl
      ? {
          getContextUsage: (opts: { detail?: string }) => {
            handle.contextCalls.push(opts)
            return contextImpl(opts)
          },
        }
      : {}),
  }) as unknown as Query

  handle.query = query
  handle.options = options
  handle.push = (message) => {
    if (resolveMessage) {
      const resolve = resolveMessage
      resolveMessage = null
      resolve({ value: message, done: false })
    } else {
      messages.push(message)
    }
  }
  handle.prompt = prompt
  handle.pullPrompt = async () => {
    const iterator = prompt[Symbol.asyncIterator]()
    const result = await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
    ])
    return result === null ? null : (result as IteratorResult<SDKUserMessage>).value ?? null
  }
  handle.exit = () => {
    ended = true
    resolveMessage?.({ value: undefined, done: true })
  }
  return handle
}

// The suites' harness runs Kawai's production composition (task-602c71e9):
// see claudeRuntimeHarness.ts, which builds on the fake query above.
export { cleanupHarnesses, createHarness, type Harness } from './claudeRuntimeHarness'

/** Let the driver's stream loop drain pushed messages. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

export function typesOf(events: ChatEvent[]): string[] {
  return events.map((event) => event.type)
}

export function assistantText(text: string, id = 'msg_1'): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id,
      content: [{ type: 'text', text }],
      role: 'assistant',
    },
    parent_tool_use_id: null,
    uuid: 'a-uuid',
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

export function userToolResult(toolUseId: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'done' },
      ],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

export function result(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    num_turns: 1,
    total_cost_usd: 0.01,
    result: 'all done',
    duration_ms: 100,
    duration_api_ms: 50,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
    ...extra,
  } as unknown as SDKMessage
}

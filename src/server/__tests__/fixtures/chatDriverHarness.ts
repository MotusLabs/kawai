// The chat driver's test harness: a scriptable stand-in for the SDK query()
// plus a driver wired to capture every callback, and the frame builders the
// driver suites share.
import type {
  Options,
  Query,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatActivity,
  ChatApprovalPolicy,
  ChatBackgroundTask,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatUsageReport,
  ChatWorker,
} from '../../../shared/chat'
import type { SessionStatus } from '../../../shared/types'
import type { ChatWireRecorder } from '../../chat/wireTap'
import type { ChatLimitSignal } from '../../chat/limitSignals'
import type { OutboundAuditSink } from '../../outbound/observer'
import {
  ChatSessionDriver,
  type ChatQueryFactory,
  type ChatSpawnInfo,
} from '../../chat/ChatSessionDriver'

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

function createFakeQuery(
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

export interface Harness {
  driver: ChatSessionDriver
  events: ChatEvent[]
  statuses: SessionStatus[]
  activities: Array<ChatActivity | null>
  /** Each agent notification (notification strip design D4) with its timeout. */
  notifications: Array<[ChatNotification, number | undefined]>
  /** Process-end callback firings (notification strip design D4). */
  processEnds: number[]
  /** Each roster publish (workers design D2): the full projection. */
  workers: ChatWorker[][]
  /** Each background-task roster publish (background tasks D2). */
  backgroundTasks: ChatBackgroundTask[][]
  rateLimits: ChatUsageReport[]
  usageReports: ChatUsageReport[]
  contextUsage: Array<ChatContextUsage | null>
  /** Persist-request flag per onContextUsage publish, aligned with contextUsage. */
  contextCorrections: boolean[]
  noData: number[]
  /** Main-session CwdChanged hook firings, in order (worktree tracking D1). */
  cwds: string[]
  fakes: FakeQueryHandle[]
  sdkSessionIds: string[]
  factoryWires: Array<ChatWireRecorder | undefined>
  commandStates: ChatCommandState[]
  /** Each onModel firing (chat-session-model design D5), in order. */
  models: string[]
}

export function createHarness(
  overrides: {
    deterministicTurnIds?: boolean
    claudeProfileId?: string
    resumeSessionId?: string
    claudeExecutablePath?: string
    getProviderEnv?: () => Record<string, string>
    getApprovalPolicy?: () => ChatApprovalPolicy
    teamMcpServer?: NonNullable<Options['mcpServers']>[string]
    getSystemPromptAppend?: () => string | undefined
    getEffort?: () => Options['effort']
    /** The outbound audit sink the driver's hooks report to (execution-safety-recovery D3). */
    outbound?: OutboundAuditSink
    onSpawn?: (info: ChatSpawnInfo) => void
    onCompaction?: (data: import('../../../shared/processObservations').Measurement) => void
    /** Replaces the harness's cwd capture (e.g. with a throwing observer). */
    onCwdChanged?: (newCwd: string) => void
    wire?: ChatWireRecorder
    onLimitEvent?: (signal: ChatLimitSignal) => void
    /** Injected usage control on every spawned fake query. */
    usageImpl?: FakeUsageControl
    /** Injected context-usage control on every spawned fake query. */
    contextImpl?: FakeContextControl
    /** Gates the driver's usage pull; defaults to "never claim". */
    claimUsagePull?: () => boolean
    /** Commands the fake queries' initializationResult() reports. */
    initializationCommands?: Array<Record<string, unknown>>
    /** Persisted roster rows seeding the driver (workers design D6). */
    recoveredWorkers?: ChatWorker[]
    /** Replaces the harness's notification capture. */
    onNotification?: (notification: ChatNotification, timeoutMs?: number) => void
    /** Replaces the harness's process-end capture. */
    onProcessEnd?: () => void
  } = {}
): Harness {
  const events: ChatEvent[] = []
  const statuses: SessionStatus[] = []
  const activities: Array<ChatActivity | null> = []
  const notifications: Array<[ChatNotification, number | undefined]> = []
  const processEnds: number[] = []
  const workers: ChatWorker[][] = []
  const backgroundTasks: ChatBackgroundTask[][] = []
  const rateLimits: ChatUsageReport[] = []
  const usageReports: ChatUsageReport[] = []
  const contextUsage: Array<ChatContextUsage | null> = []
  const contextCorrections: boolean[] = []
  const noData: number[] = []
  const cwds: string[] = []
  const fakes: FakeQueryHandle[] = []
  const sdkSessionIds: string[] = []
  const factoryWires: Array<ChatWireRecorder | undefined> = []
  const commandStates: ChatCommandState[] = []
  const models: string[] = []
  // usageImpl/contextImpl/claimUsagePull/initializationCommands feed the fake
  // factory; the rest pass to the driver.
  const { deterministicTurnIds = true, usageImpl, contextImpl, claimUsagePull, initializationCommands, ...driverOverrides } = overrides
  const factory: ChatQueryFactory = ({ prompt, options, wire }) => {
    factoryWires.push(wire)
    const handle = createFakeQuery(prompt, options, usageImpl, contextImpl)
    fakes.push(handle)
    if (initializationCommands) {
      ;(handle.query as { initializationResult?: () => Promise<unknown> }).initializationResult =
        () => Promise.resolve({ commands: initializationCommands })
    }
    return handle.query
  }
  let turnOrdinal = 0
  const driver = new ChatSessionDriver({
    ...(deterministicTurnIds ? { createTurnId: () => `turn-${++turnOrdinal}` } : {}),
    sessionId: 'chat-test',
    projectPath: '/tmp/project',
    queryFactory: factory,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onActivity: (activity) => activities.push(activity),
    onNotification: overrides.onNotification ?? ((notification, timeoutMs) => notifications.push([notification, timeoutMs])),
    onProcessEnd: overrides.onProcessEnd ?? (() => processEnds.push(1)),
    onWorkers: (list) => workers.push(list),
    onBackgroundTasks: (tasks) => backgroundTasks.push(tasks),
    onRateLimit: (report) => rateLimits.push(report),
    onUsageReport: (report) => usageReports.push(report),
    onContextUsage: (usage, opts) => {
      if (usage === null) {
        contextUsage.push(null)
        contextCorrections.push(opts?.persist === true)
        return
      }
      contextUsage.push(usage)
      contextCorrections.push(opts?.persist === true)
    },
    ...(claimUsagePull ? { claimUsagePull } : {}),
    onUsageNoData: () => noData.push(1),
    onSdkSessionId: (id) => sdkSessionIds.push(id),
    onModel: (model) => models.push(model),
    onCwdChanged: (cwd) => cwds.push(cwd),
    onCommandState: (state) => commandStates.push(state),
    ...driverOverrides,
  })
  return {
    driver,
    events,
    statuses,
    activities,
    notifications,
    processEnds,
    workers,
    backgroundTasks,
    rateLimits,
    usageReports,
    contextUsage,
    contextCorrections,
    noData,
    cwds,
    fakes,
    sdkSessionIds,
    factoryWires,
    commandStates,
    models,
  }
}

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

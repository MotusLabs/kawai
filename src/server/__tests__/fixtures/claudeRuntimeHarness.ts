// The Claude driver suites' harness over Kawai's production composition
// (extract-agent-runtime 6.2/6.3, task-602c71e9): createChatDriver →
// claudeRuntime.ts → the package's validation and session core, over the
// scriptable fake query from chatDriverHarness.ts. The fake is a model of
// the SDK query (injected through the adapter's existing queryFactory
// option, which runs the package's private createClaudeDriverWith seam); it
// never spawns a process, so nothing here claims a native exit.
//
// - The package builds its query asynchronously (RuntimeBoot), so a case
//   awaits `spawned(n)` — the factory's actual n-th call — before it reads
//   the fake; nothing sleeps for readiness.
// - The legacy class's knobs the adapter never reads are refused by name,
//   never dropped: createTurnId (and the old deterministicTurnIds switch).
// - cleanup() kills the driver and joins its settled() (the package stop,
//   callbacks and owned work). The one shared promise is reserved before the
//   kill runs, so overlapping calls and a reentry from a callback the kill
//   triggers share it; a settled() failure rejects it raw, once.
// - The fake reads its prompt stream eagerly, as the CLI reads stdin, into
//   a buffer that pullPrompt() and `prompt` read from (same 10 ms "nothing
//   waiting" answer as the shared fake). The package admits a send after its
//   async boot (claudeRuntime.ts submit: ensure() then inner.send()), so a
//   case awaits `admitted(n)` — the n-th prompt the package actually wrote —
//   before it pushes the frames that answer it. Each reader is joined by
//   cleanup after settled(), once the package has ended the stream.
// - A result frame pushed without its own uuid gets a fresh one, once, on
//   the pushed object: the pinned SDK stamps every result frame, and the
//   package binds a result frame at most once by that id, refusing a frame
//   without one (packages/agent-runtime/src/claude/resultFrames.ts, task 4.1
//   correction A1). The shared builders predate that requirement; a frame
//   that already carries a uuid, and every non-result frame, pass unchanged.
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatActivity,
  ChatBackgroundTask,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatUsageReport,
  ChatWorker,
} from '../../../shared/chat'
import type { SessionStatus } from '../../../shared/types'
import type { ChatQueryFactory } from '../../chat/ChatSessionDriver'
import type { ClaudeChatDriverOptions } from '../../chat/provider/claudeRuntime'
import { createChatDriver } from '../../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../../chat/provider/driver'
import type { ChatWireRecorder } from '../../chat/wireTap'
import {
  createFakeQuery,
  type FakeContextControl,
  type FakeQueryHandle,
  type FakeUsageControl,
} from './chatDriverHarness'

/** Kawai's production Claude composition, as createChatDriver returns it. */
export type RuntimeDriver = ChatAgentDriver & { settled(): Promise<void> }

/** The legacy-class knobs the production adapter never reads. */
const LEGACY_KNOBS = ['createTurnId', 'deterministicTurnIds'] as const

export type RuntimeHarnessOverrides = Partial<Omit<ClaudeChatDriverOptions, 'createTurnId' | 'queryFactory'>> & {
  /** Injected usage control on every spawned fake query. */
  usageImpl?: FakeUsageControl
  /** Injected context-usage control on every spawned fake query. */
  contextImpl?: FakeContextControl
  /** Commands the fake queries' initializationResult() reports. */
  initializationCommands?: Array<Record<string, unknown>>
}

export interface RuntimeHarness {
  driver: RuntimeDriver
  events: ChatEvent[]
  statuses: SessionStatus[]
  activities: Array<ChatActivity | null>
  notifications: Array<[ChatNotification, number | undefined]>
  processEnds: number[]
  workers: ChatWorker[][]
  backgroundTasks: ChatBackgroundTask[][]
  rateLimits: ChatUsageReport[]
  usageReports: ChatUsageReport[]
  contextUsage: Array<ChatContextUsage | null>
  contextCorrections: boolean[]
  noData: number[]
  cwds: string[]
  fakes: FakeQueryHandle[]
  sdkSessionIds: string[]
  factoryWires: Array<ChatWireRecorder | undefined>
  commandStates: ChatCommandState[]
  models: string[]
  /** Every prompt the package wrote, across spawns, in order. */
  prompts: SDKUserMessage[]
  /** Resolves once the package has written `count` prompts in total. */
  admitted(count?: number): Promise<void>
  /** The factory's n-th (0-based) query, once the package actually built it. */
  spawned(index?: number): Promise<FakeQueryHandle>
  /** Kill, join settled(), then finalize; one shared promise (see the header). */
  cleanup(): Promise<void>
}

export function createRuntimeHarness(overrides: RuntimeHarnessOverrides = {}): RuntimeHarness {
  for (const knob of LEGACY_KNOBS) {
    if (knob in overrides) throw new Error(`createRuntimeHarness: ${knob} is a legacy-driver knob the production adapter never reads`)
  }
  const h = {
    events: [], statuses: [], activities: [], notifications: [], processEnds: [], workers: [], backgroundTasks: [],
    rateLimits: [], usageReports: [], contextUsage: [], contextCorrections: [], noData: [], cwds: [], fakes: [],
    sdkSessionIds: [], factoryWires: [], commandStates: [], models: [],
  } as unknown as Omit<RuntimeHarness, 'driver' | 'spawned' | 'cleanup'>
  const waiters = new Map<number, Array<(fake: FakeQueryHandle) => void>>()
  const prompts: SDKUserMessage[] = []
  const admissions: Array<{ count: number; wake: () => void }> = []
  const readers: Promise<void>[] = []
  const read = (prompt: AsyncIterable<SDKUserMessage>, buffer: SDKUserMessage[], arrived: Array<() => void>) => {
    readers.push((async () => {
      for await (const message of prompt) {
        buffer.push(message)
        prompts.push(message)
        for (const wake of arrived.splice(0)) wake()
        for (const waiter of admissions.filter((entry) => prompts.length >= entry.count)) {
          admissions.splice(admissions.indexOf(waiter), 1)
          waiter.wake()
        }
      }
    })())
  }
  const { usageImpl, contextImpl, initializationCommands, ...driverOverrides } = overrides
  const factory: ChatQueryFactory = ({ prompt, options, wire }) => {
    h.factoryWires.push(wire)
    const handle = createFakeQuery(prompt, options as Options, usageImpl, contextImpl)
    if (initializationCommands) {
      ;(handle.query as { initializationResult?: () => Promise<unknown> }).initializationResult =
        () => Promise.resolve({ commands: initializationCommands })
    }
    const buffer: SDKUserMessage[] = []
    const arrived: Array<() => void> = []
    read(prompt, buffer, arrived)
    handle.pullPrompt = async () => {
      if (buffer.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10)
          arrived.push(() => { clearTimeout(timer); resolve() })
        })
      }
      return buffer.shift() ?? null
    }
    handle.prompt = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (buffer.length === 0) await new Promise<void>((resolve) => arrived.push(resolve))
          return { value: buffer.shift()!, done: false as const }
        },
      }),
    }
    const push = handle.push
    handle.push = (message) => {
      const frame = message as { type?: unknown; uuid?: unknown }
      if (frame.type === 'result' && (typeof frame.uuid !== 'string' || frame.uuid === '')) frame.uuid = crypto.randomUUID()
      push(message)
    }
    const index = h.fakes.push(handle) - 1
    for (const wake of waiters.get(index) ?? []) wake(handle)
    waiters.delete(index)
    return handle.query
  }
  const options: ClaudeChatDriverOptions = {
    sessionId: 'chat-test',
    projectPath: '/tmp/project',
    queryFactory: factory,
    onEvent: (event) => h.events.push(event),
    onStatus: (status) => h.statuses.push(status),
    onActivity: (activity) => h.activities.push(activity),
    onNotification: (notification, timeoutMs) => h.notifications.push([notification, timeoutMs]),
    onProcessEnd: () => h.processEnds.push(1),
    onWorkers: (list) => h.workers.push(list),
    onBackgroundTasks: (tasks) => h.backgroundTasks.push(tasks),
    onRateLimit: (report) => h.rateLimits.push(report),
    onUsageReport: (report) => h.usageReports.push(report),
    onContextUsage: (usage, opts) => {
      h.contextUsage.push(usage)
      h.contextCorrections.push(opts?.persist === true)
    },
    onUsageNoData: () => h.noData.push(1),
    onSdkSessionId: (id) => h.sdkSessionIds.push(id),
    onModel: (model) => h.models.push(model),
    onCwdChanged: (cwd) => h.cwds.push(cwd),
    onCommandState: (state) => h.commandStates.push(state),
    ...driverOverrides,
  }
  const driver = createChatDriver({ runtime: 'claude', options }) as RuntimeDriver

  let cleaning: Promise<void> | null = null
  const body = async (): Promise<void> => {
    driver.kill()
    try {
      await driver.settled()
    } finally {
      // The package ended every prompt stream at its stop; the readers end with them.
      await Promise.all(readers)
    }
  }
  const cleanup = (): Promise<void> => {
    if (cleaning) return cleaning
    // Reserved before kill() runs: a callback the kill triggers that reenters
    // cleanup gets this same promise, never a second body.
    let settle!: { resolve(): void; reject(error: unknown): void }
    cleaning = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    void cleaning.catch(() => {})
    body().then(settle.resolve, settle.reject)
    return cleaning
  }

  return {
    ...h,
    driver,
    prompts,
    admitted: (count = 1) => prompts.length >= count
      ? Promise.resolve()
      : new Promise<void>((wake) => admissions.push({ count, wake })),
    spawned: (index = 0) => {
      const ready = h.fakes[index]
      if (ready) return Promise.resolve(ready)
      return new Promise<FakeQueryHandle>((resolve) => {
        const list = waiters.get(index) ?? []
        list.push(resolve)
        waiters.set(index, list)
      })
    },
    cleanup,
  }
}

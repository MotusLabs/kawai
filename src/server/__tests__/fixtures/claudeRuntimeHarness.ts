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
//   The id is allocated once per object, so pushing the same object again is
//   a replay of the same frame. Identity-fault cases (missing, empty,
//   unknown, stale or duplicate frame ids) push through `pushRaw`, which
//   reaches the package unchanged.
// - Every harness joins at `cleanupHarnesses()` (each suite's afterEach). A
//   case that expects the driver's settled() to fail asserts it through
//   `expectFailures(...causes)`: the stop's causes must be exactly those
//   original objects, each once, by identity. Only that assertion marks the
//   rejection reported, so the join does not report it again; `failure()`
//   merely retrieves the rejection and marks nothing (r4 A6). The suite
//   join is one shared in-flight promise: an overlapping call joins it and
//   never settles early (R6, parent review findings-74686a77 F2).
// - `launches` records any call the fake made to the package's owned
//   spawner; the fake model never calls it, so a case can prove the
//   injected query launched no process (r4 A10).
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
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
import type { ChatQueryFactory } from '../../chat/provider/claudeDriverTypes'
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
export type RuntimeDriver = ChatAgentDriver & {
  settled(): Promise<void>
  /** The Claude adapter always has the workspace-context send (checked at construction). */
  sendWorkspaceContext: NonNullable<ChatAgentDriver['sendWorkspaceContext']>
}

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

/** The shared fake, plus the unfilled push for frame-identity fault cases. */
export type RuntimeFake = FakeQueryHandle & { pushRaw(message: SDKMessage): void }

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
  fakes: RuntimeFake[]
  sdkSessionIds: string[]
  factoryWires: Array<ChatWireRecorder | undefined>
  /**
   * Every call the fake made to the package's owned spawner, per query, in
   * order. The fake model never calls it: a case reads this to prove the
   * injected query launched no process (A10).
   */
  launches: number[]
  commandStates: ChatCommandState[]
  models: string[]
  /** Every prompt the package wrote, across spawns, in order. */
  prompts: SDKUserMessage[]
  /** Resolves once the package has written `count` prompts in total. */
  admitted(count?: number): Promise<void>
  /**
   * admitted(n) for the next write this case awaits: n counts the writes the
   * case already awaited through nextWrite() (or pulled), plus one.
   */
  nextWrite(): Promise<void>
  /** The factory's n-th (0-based) query, once the package actually built it. */
  spawned(index?: number): Promise<RuntimeFake>
  /** Kill, join settled(), then finalize; one shared promise (see the header). */
  cleanup(): Promise<void>
  /** The cleanup's rejection, retrieved only (never marked reported); throws when it resolves. */
  failure(): Promise<unknown>
  /**
   * Assert the cleanup rejected with exactly these original causes, each
   * once by identity (the package stop's causes, or the raw rejection), and
   * only then mark that rejection reported.
   */
  expectFailures(...causes: unknown[]): Promise<void>
}

/** The suites' names for the same harness. */
export type Harness = RuntimeHarness
export const createHarness = (overrides?: RuntimeHarnessOverrides): RuntimeHarness => createRuntimeHarness(overrides)

type LiveEntry = { harness: RuntimeHarness; asserted: { error: unknown } | null }
const live = new Set<LiveEntry>()
/** The one suite-level join in flight, shared by every overlapping caller (parent review F2). */
let joining: Promise<void> | null = null

/**
 * Join every harness created since the last call (each suite's afterEach):
 * a failure no case took through failure() rejects once, raw (one) or as an
 * AggregateError (several). The join is reserved before any harness cleanup
 * runs or any entry leaves `live`, so an overlapping call gets the same
 * promise and never settles while a harness it owns is still joining. An
 * entry leaves `live` only after its cleanup settled, and a harness created
 * during the join is joined by it too.
 *
 * The final observation that `live` is empty, the release of `joining` and
 * the settlement of the reserved promise are one synchronous step inside
 * the drain's own continuation (task-602c71e9 R7, findings-7712679a): no
 * await or later reaction separates them, so a harness registered at any
 * point is either joined by the pending join or, once that join has
 * settled, owned by the next one a later call starts.
 */
export function cleanupHarnesses(): Promise<void> {
  if (joining) return joining
  let settle!: Settle
  const reserved = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
  joining = reserved
  void drainLive(settle)
  return reserved
}

type Settle = { resolve(): void; reject(error: unknown): void }

async function drainLive(settle: Settle): Promise<void> {
  const failures: unknown[] = []
  for (;;) {
    if (live.size === 0) {
      // One synchronous completion step: empty decision, slot release, settlement.
      joining = null
      if (failures.length === 0) settle.resolve()
      else if (failures.length === 1) settle.reject(failures[0])
      else settle.reject(new AggregateError(failures, 'Claude harness cleanups failed'))
      return
    }
    const entries = [...live]
    const outcomes = await Promise.allSettled(entries.map((entry) => entry.harness.cleanup()))
    for (const entry of entries) live.delete(entry)
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected' && entries[index]!.asserted?.error !== outcome.reason) failures.push(outcome.reason)
    })
  }
}

export function createRuntimeHarness(overrides: RuntimeHarnessOverrides = {}): RuntimeHarness {
  for (const knob of LEGACY_KNOBS) {
    if (knob in overrides) throw new Error(`createRuntimeHarness: ${knob} is a legacy-driver knob the production adapter never reads`)
  }
  const h = {
    events: [], statuses: [], activities: [], notifications: [], processEnds: [], workers: [], backgroundTasks: [],
    rateLimits: [], usageReports: [], contextUsage: [], contextCorrections: [], noData: [], cwds: [], fakes: [],
    sdkSessionIds: [], factoryWires: [], launches: [], commandStates: [], models: [],
  } as unknown as Omit<RuntimeHarness, 'driver' | 'spawned' | 'cleanup'>
  const waiters = new Map<number, Array<(fake: RuntimeFake) => void>>()
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
    // Record any call to the package's owned spawner (forwarded unchanged).
    const query = h.factoryWires.length - 1
    const spawn = (options as Options).spawnClaudeCodeProcess
    if (spawn) {
      ;(options as Options).spawnClaudeCodeProcess = (spawnOptions) => {
        h.launches.push(query)
        return spawn(spawnOptions)
      }
    }
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
    const fake = handle as RuntimeFake
    fake.pushRaw = push
    handle.push = (message) => {
      const frame = message as { type?: unknown; uuid?: unknown }
      if (frame.type === 'result' && (typeof frame.uuid !== 'string' || frame.uuid === '')) frame.uuid = crypto.randomUUID()
      push(message)
    }
    const index = h.fakes.push(fake) - 1
    for (const wake of waiters.get(index) ?? []) wake(fake)
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
  if (typeof driver.sendWorkspaceContext !== 'function' || typeof driver.settled !== 'function') {
    throw new Error('createRuntimeHarness: the Claude adapter lost sendWorkspaceContext or settled')
  }

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

  const failure = async (): Promise<unknown> => {
    try {
      await cleanup()
    } catch (error) {
      return error
    }
    throw new Error('expected the driver cleanup to fail')
  }

  const admitted = (count = 1): Promise<void> => prompts.length >= count
    ? Promise.resolve()
    : new Promise<void>((wake) => admissions.push({ count, wake }))
  let awaitedWrites = 0
  const entry: { harness: RuntimeHarness; asserted: { error: unknown } | null } = { harness: undefined as never, asserted: null }
  const harness: RuntimeHarness = {
    ...h,
    driver,
    prompts,
    admitted,
    nextWrite: () => admitted(++awaitedWrites),
    spawned: (index = 0) => {
      const ready = h.fakes[index]
      if (ready) return Promise.resolve(ready)
      return new Promise<RuntimeFake>((resolve) => {
        const list = waiters.get(index) ?? []
        list.push(resolve)
        waiters.set(index, list)
      })
    },
    cleanup,
    failure,
    expectFailures: async (...expected: unknown[]) => {
      const error = await failure()
      const causes = error instanceof AgentRuntimeError ? [...error.causes] : [error]
      const once = expected.every((cause) => causes.filter((seen) => seen === cause).length === 1)
      if (!once || causes.length !== expected.length) {
        throw new Error(`expectFailures: expected exactly ${expected.length} original cause(s) once each, got ${causes.length}: ${causes.map(String).join(' | ')}`)
      }
      entry.asserted = { error }
    },
  }
  entry.harness = harness
  live.add(entry)
  return harness
}

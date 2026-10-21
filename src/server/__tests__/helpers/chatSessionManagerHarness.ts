import { afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { CwdChangedHookInput, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatActivity, ChatContextUsage, ChatEvent, ChatUsageReport, ChatWorker, ChatBackgroundTask } from '../../../shared/chat'
import { type SessionDatabase } from '../../db'
import { SessionRegistry } from '../../SessionRegistry'
import { ChatWorkerStore } from '../../chat/chatWorkerStore'
import type { ChatWireRecorder } from '../../chat/wireTap'
import { ChatSessionManager, type ChatQueryFactory } from '../../chat/ChatSessionManager'

/** Every fictitious project path (`/tmp/proj`) counts as an existing directory. */
export const anyDirectory = () => true

/** A user-level catalog with one credentialed provider (openrouter-provider D1). */
export function writeCredentialedProviderCatalog(home: string): void {
  const dir = path.join(home, '.kawai')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    or2: {
      label: 'OR2',
      authTokenEnv: 'OR2_KEY',
      env: { ANTHROPIC_BASE_URL: 'https://or2.example.internal/api' },
      models: { 'or2-opus': { model: 'opus' } },
    },
  }))
}

/** Minimal scriptable Query: tests push SDK messages, options are captured. */
export interface FakeHandle {
  query: Query
  options: Options
  wire?: ChatWireRecorder
  push: (message: SDKMessage) => void
  closed: boolean
  /** Usage control calls (options verbatim); empty when never pulled. */
  usageCalls: Array<{ skipBehaviors?: boolean }>
  /** Context-usage control calls; empty when the fake omits the method. */
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

export const testManagers = new Set<ChatSessionManager>()
export async function managedManager(options: ConstructorParameters<typeof ChatSessionManager>[0]) {
  const manager = new ChatSessionManager({
    // Provider usage pulls must never leave the tests: a harness that does
    // not inject a fetch gets one that fails, so the claim falls back to the
    // SDK pull exactly as an unreachable endpoint would — even when the
    // machine's real environment exports a provider base URL.
    providerUsageFetch:
      options.providerUsageFetch ??
      (async () => {
        throw new Error('provider usage pull not expected in this harness')
      }) as unknown as typeof fetch,
    ...options,
  })
  // Restore is async (async-transcript-parsing design D2): block until the
  // persisted rows are in, matching the pre-change synchronous constructor.
  await manager.whenRestored()
  testManagers.add(manager)
  return manager
}
/** Stops each manager's timers: a leaked observation tick would warn into later files' logger spies. */
export function closeDispatchers() {
  for (const manager of testManagers) {
    manager.dispatcher.close()
    manager.observations.stop()
  }
}
afterEach(() => {
  closeDispatchers()
  testManagers.clear()
})

export function fakeQueryFactory(
  handles: FakeHandle[],
  usageImpl?: FakeUsageControl,
  contextImpl?: FakeContextControl
): ChatQueryFactory {
  return ({ prompt: _prompt, options, wire }) => {
    const queue: SDKMessage[] = []
    let resolveMessage:
      | ((result: IteratorResult<SDKMessage>) => void)
      | null = null
    let ended = false
    const handle = {
      closed: false,
      usageCalls: [] as Array<{ skipBehaviors?: boolean }>,
      contextCalls: [] as Array<{ detail?: string }>,
    } as FakeHandle

    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = await new Promise<IteratorResult<SDKMessage>>(
          (resolve) => {
            if (queue.length > 0) {
              resolve({ value: queue.shift()!, done: false })
            } else if (ended) {
              resolve({ value: undefined, done: true })
            } else {
              resolveMessage = resolve
            }
          }
        )
        if (next.done) return
        yield next.value
      }
    }

    const query = Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      close: () => {
        handle.closed = true
        ended = true
        resolveMessage?.({ value: undefined, done: true })
      },
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
    handle.wire = wire
    handle.push = (message) => {
      if (resolveMessage) {
        const resolve = resolveMessage
        resolveMessage = null
        resolve({ value: message, done: false })
      } else {
        queue.push(message)
      }
    }
    handles.push(handle)
    return query
  }
}

export interface ManagerHarness {
  manager: ChatSessionManager
  registry: SessionRegistry
  handles: FakeHandle[]
  events: Array<{ sessionId: string; event: ChatEvent }>
  activities: Array<{ sessionId: string; activity: ChatActivity | null }>
  contextUsage: Array<{ sessionId: string; usage: ChatContextUsage | null }>
  /** Model publishes (chat-session-model design D5), in order. */
  models: Array<{ sessionId: string; model: string }>
  usage: Array<{ providerId: string; report: ChatUsageReport | null }>
  /** Worker-roster publishes, in order (workers design D2). */
  workers: Array<{ sessionId: string; workers: ChatWorker[] }>
  /** Background-task roster publishes, in order (background tasks D2). */
  backgroundTasks: Array<{ sessionId: string; tasks: ChatBackgroundTask[] }>
  /** Scoped workspace refreshes fired after cwd moves (worktree tracking D2). */
  refreshes: string[]
}

export async function createHarness(
  db: SessionDatabase,
  isDirectory: (path: string) => boolean = anyDirectory,
  usageImpl?: FakeUsageControl,
  titleLocateIntervalMs?: number,
  contextImpl?: FakeContextControl,
  cwdRefreshDebounceMs?: number,
  workerStore?: ChatWorkerStore,
  catalogHome?: string
): Promise<ManagerHarness> {
  const registry = new SessionRegistry()
  const handles: FakeHandle[] = []
  const events: Array<{ sessionId: string; event: ChatEvent }> = []
  const activities: Array<{ sessionId: string; activity: ChatActivity | null }> = []
  const contextUsage: Array<{ sessionId: string; usage: ChatContextUsage | null }> = []
  const models: Array<{ sessionId: string; model: string }> = []
  const usage: Array<{ providerId: string; report: ChatUsageReport | null }> = []
  const workers: Array<{ sessionId: string; workers: ChatWorker[] }> = []
  const backgroundTasks: Array<{ sessionId: string; tasks: ChatBackgroundTask[] }> = []
  const refreshes: string[] = []
  const manager = await managedManager({
    isDirectory,
    registry,
    db,
    onEvent: (sessionId, event) => events.push({ sessionId, event }),
    onActivity: (sessionId, activity) => activities.push({ sessionId, activity }),
    onContextUsage: (sessionId, reading) => contextUsage.push({ sessionId, usage: reading }),
    onModel: (sessionId, model) => models.push({ sessionId, model }),
    onUsage: (providerId, report) => usage.push({ providerId, report }),
    onWorkers: (sessionId, roster) => workers.push({ sessionId, workers: roster }),
    onBackgroundTasks: (sessionId, tasks) => backgroundTasks.push({ sessionId, tasks }),
    queryFactory: fakeQueryFactory(handles, usageImpl, contextImpl),
    titleLocateIntervalMs,
    ...(cwdRefreshDebounceMs !== undefined ? { cwdRefreshDebounceMs } : {}),
    requestWorkspaceRefresh: (projectPath) => refreshes.push(projectPath),
    ...(workerStore !== undefined ? { workerStore } : {}),
    ...(catalogHome ? { profileCatalogHome: catalogHome } : {}),
  })
  return { manager, registry, handles, events, activities, contextUsage, models, usage, workers, backgroundTasks, refreshes }
}

/** Let the driver's stream loop drain pushed messages. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** Poll until the condition holds (watcher callbacks are async). */
export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function initMessage(sessionId: string, model?: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    ...(model !== undefined ? { model } : {}),
  } as unknown as SDKMessage
}

/** Assistant frame whose per-request usage sums to input_tokens. */
export function assistantUsage(inputTokens: number, id: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id,
      content: [],
      role: 'assistant',
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: `uuid-${id}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

/** A successful result revealing a 200000-token model window. */
export function resultWithWindow(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.01,
    result: 'done',
    duration_ms: 100,
    duration_api_ms: 50,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      'claude-sonnet-4-5': {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      },
    },
    permission_denials: [],
    stop_reason: null,
  } as unknown as SDKMessage
}

/** A compact_boundary frame adopting the given post-compaction size. */
export function compactBoundary(postTokens: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: postTokens * 4, post_tokens: postTokens },
    uuid: 'compact-uuid',
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

/** Fire the driver's registered CwdChanged hook, as the SDK process would. */
export async function fireCwdChanged(
  handle: FakeHandle,
  newCwd: string,
  agentId?: string
): Promise<void> {
  const hook = handle.options.hooks?.CwdChanged?.[0]?.hooks[0]
  if (!hook) throw new Error('CwdChanged hook not registered')
  await hook(
    {
      session_id: 'sdk-cwd-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/proj',
      hook_event_name: 'CwdChanged',
      old_cwd: '/tmp/proj',
      new_cwd: newCwd,
      ...(agentId ? { agent_id: agentId } : {}),
    } as CwdChangedHookInput,
    undefined,
    { signal: new AbortController().signal }
  )
}

/** Write an SDK transcript where findTranscriptPath looks for it. */
export function writeTranscript(sdkSessionId: string, content: string): string {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${sdkSessionId}.jsonl`)
  fs.writeFileSync(filePath, content)
  return filePath
}

export async function drainNow(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

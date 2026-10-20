import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CwdChangedHookInput,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Session } from '../../shared/types'
import type {
  ChatActivity,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatUsageReport,
  ChatWorker,
  ChatBackgroundTask,
} from '../../shared/chat'
import type { ClaudeLaunchConfiguration } from '../chat/ClaudeProfiles'
import { initDatabase, type SessionDatabase } from '../db'
import { MetricsSnapshot } from '../metrics/export/snapshot'
import { NOTIFY_DEBOUNCE_MS } from '../metrics/observations/service'
import { OutboundStore } from '../outbound/store'
import { logger } from '../logger'
import { SessionRegistry } from '../SessionRegistry'
import { ChatWireLogs } from '../chat/ChatWireLogs'
import { ChatWorkerStore } from '../chat/chatWorkerStore'
import { ChatTaskStore } from '../chat/chatTaskStore'
import { ClaudeExecutableError } from '../chat/claudeExecutable'
import type { ChatWireRecorder } from '../chat/wireTap'
import {
  ChatSessionManager,
  hasClaudeAuth,
  type ChatQueryFactory,
} from '../chat/ChatSessionManager'

/** Every fictitious project path (`/tmp/proj`) counts as an existing directory. */
const anyDirectory = () => true

/** A user-level catalog with one credentialed provider (openrouter-provider D1). */
function writeCredentialedProviderCatalog(home: string): void {
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
interface FakeHandle {
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
type FakeUsageControl = (opts: {
  skipBehaviors?: boolean
}) => Promise<unknown>

/** The context-usage control implementation a test injects into a fake query. */
type FakeContextControl = (opts: {
  detail?: string
}) => Promise<unknown>

const testManagers = new Set<ChatSessionManager>()
async function managedManager(options: ConstructorParameters<typeof ChatSessionManager>[0]) {
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
function closeDispatchers() {
  for (const manager of testManagers) {
    manager.dispatcher.close()
    manager.observations.stop()
  }
}
afterEach(() => {
  closeDispatchers()
  testManagers.clear()
})

function fakeQueryFactory(
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

interface ManagerHarness {
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

async function createHarness(
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
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** Poll until the condition holds (watcher callbacks are async). */
async function waitForCondition(
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

function initMessage(sessionId: string, model?: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    ...(model !== undefined ? { model } : {}),
  } as unknown as SDKMessage
}

/** Assistant frame whose per-request usage sums to input_tokens. */
function assistantUsage(inputTokens: number, id: string): SDKMessage {
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
function resultWithWindow(): SDKMessage {
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
function compactBoundary(postTokens: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: postTokens * 4, post_tokens: postTokens },
    uuid: 'compact-uuid',
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

/** Fire the driver's registered CwdChanged hook, as the SDK process would. */
async function fireCwdChanged(
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
function writeTranscript(sdkSessionId: string, content: string): string {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${sdkSessionId}.jsonl`)
  fs.writeFileSync(filePath, content)
  return filePath
}

describe('ChatSessionManager', () => {
  let tempDir: string
  let db: SessionDatabase

  /**
   * The shipped catalog has no LAN profile; tests that exercise one write a
   * user-level fixture (reserved documentation address) into the pinned HOME.
   * A user file replaces the shipped default wholesale, so the shipped
   * profiles ride along.
   */
  function writeLanCatalog(): void {
    const shipped = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../config/profiles.default.json'), 'utf8'),
    ) as Record<string, unknown>
    // The GLM pair lives in the shipped providers default; flatten it into
    // legacy entries so these launch tests read the same settings.
    const providers = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../config/providers.default.json'), 'utf8'),
    ) as Record<string, { env?: Record<string, string>; limitResetTimeZone?: string; models?: Record<string, { label?: string; model?: string }> }>
    for (const provider of Object.values(providers)) {
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        shipped[key] = {
          ...(model.label ? { label: model.label } : {}),
          ...(model.model ? { model: model.model } : {}),
          ...(provider.limitResetTimeZone ? { limitResetTimeZone: provider.limitResetTimeZone } : {}),
          env: { ...provider.env },
        }
      }
    }
    // Bracket access: a dotted property would read as a LAN hostname to the scrub grep.
    shipped['lan'] = { label: 'LAN', env: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:9292' } }
    fs.mkdirSync(path.join(tempDir, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, '.kawai', 'profiles.json'), JSON.stringify(shipped))
  }

  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Isolate auth from the host: no API key, empty CLI config dir. HOME is
    // pinned so the profile catalog resolves against an empty home — a real
    // ~/.kawai must not leak into these tests.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    if (originalOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    if (originalAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('observability foundation records managed task context, compaction, usage and acceptance without Prometheus', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const h = await createHarness(db)
    const task = h.manager.tasks.store.create({teamId:'/tmp/proj',title:'foundation',direction:'fixture only',creator:{kind:'human',sessionId:null}})
    const created = h.manager.createSession({projectPath:'/tmp/proj',taskId:task.id})
    if(!created.ok)throw Error('create failed')
    expect((await h.manager.send(created.session.id,'fixture work')).ok).toBe(true)
    const handle=h.handles[0]!
    handle.push(initMessage('sdk-observability'))
    handle.push(assistantUsage(12000,'context-before'))
    handle.push(resultWithWindow())
    await flush()
    // A second turn has a known context threshold; the boundary preserves both sizes.
    await h.manager.send(created.session.id,'compact and finish')
    handle.push(assistantUsage(14000,'context-next'))
    handle.push(compactBoundary(3000))
    handle.push(resultWithWindow())
    await flush()
    const result=h.manager.tasks.store.results.insert({teamId:'/tmp/proj',taskId:task.id,taskRevision:1,summary:'fixture accepted',commit:null,diff:null,worktree:null,tests:[],limitations:null,submittedBy:{kind:'agent',sessionId:created.session.id}})
    h.manager.tasks.store.setStatus(task.id,'done',()=>{h.manager.tasks.store.results.markAccepted(result.id,{kind:'human',sessionId:null})})
    await flush()
    // Post-commit notifications reconcile in one debounced pass.
    await new Promise((resolve) => setTimeout(resolve, NOTIFY_DEBOUNCE_MS + 20))
    const observations = db.db.prepare('SELECT kind,data FROM process_observations').all() as {kind:string;data:string}[]
    for(const kind of ['turn_started','turn_ended','context','compaction','usage','acceptance'])expect(observations.some(row=>row.kind===kind)).toBe(true)
    expect(h.manager.observations.recorder.failures).toBe(0)
    const snapshot=new MetricsSnapshot(h.manager.observations).read()
    expect(snapshot).toContain('kawai_task_acceptance_duration_seconds_count')
    expect(snapshot).toContain('kawai_agent_compactions_total')
    expect(snapshot).toContain('source="provider-quota"} 0')
    writeTranscript('sdk-observability','[]')
    h.manager.shutdown()
    const restarted=await createHarness(db)
    expect(new MetricsSnapshot(restarted.manager.observations).read()).toContain('kawai_task_acceptance_duration_seconds_count')
    expect((db.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='acceptance'").get() as {n:number}).n).toBe(1)
    const resumed=await restarted.manager.send(created.session.id,'work after restart')
    if(!resumed.ok)throw Error(resumed.error)
    expect(restarted.handles[0]!.options.resume).toBe('sdk-observability')
    restarted.handles[0]!.push(initMessage('sdk-observability'))
    restarted.handles[0]!.push(resultWithWindow())
    await flush()
    const turns=restarted.manager.turnUsage.forSession(created.session.id)
    expect(turns).toHaveLength(3)
    expect(new Set(turns.map(turn=>turn.turnId)).size).toBe(3)
    expect((db.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='turn_ended'").get() as {n:number}).n).toBe(3)
    restarted.manager.shutdown()
  })

  test('profiles persist, retain metadata, reject unknown IDs, and restore the SDK conversation', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const first = await createHarness(db)
    expect(first.manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'unknown' }).ok).toBe(false)
    expect(db.getChatSessions()).toEqual([])
    expect(first.registry.getAll()).toEqual([])
    const created = first.manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error(created.error)
    expect(created.session.claudeProfileId).toBe('glm')
    const id = created.session.id
    expect(db.getChatSession(id)?.claudeProfileId).toBe('glm')
    await first.manager.send(id, 'first')
    first.handles[0]!.push(initMessage('profile-conversation'))
    await flush()
    writeTranscript('profile-conversation', JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }))
    first.manager.shutdown()
    const restored = await createHarness(db)
    expect(restored.registry.get(id)?.claudeProfileId).toBe('glm')
    expect((await restored.manager.send(id, 'resume')).ok).toBe(true)
    expect(restored.handles[0]!.options.resume).toBe('profile-conversation')
    expect(restored.handles[0]!.options.model).toBe('opus')
    expect(restored.handles[0]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    restored.manager.shutdown()
    db.updateChatSession(id, { claudeProfileId: 'removed-profile' })
    const unknown = await createHarness(db)
    expect(unknown.registry.get(id)?.claudeProfileId).toBe('removed-profile')
    const result = await unknown.manager.send(id, 'resume')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('removed-profile')
    expect(unknown.handles).toHaveLength(0)
    expect(db.getChatSession(id)?.sdkSessionId).toBe('profile-conversation')
    unknown.manager.shutdown()
  })

  test('create-time approval policy: supplied policy sticks, absent means manual, profiles leave it unchanged', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { manager, registry } = await createHarness(db)

    // A supplied policy is stored on the session, registry, and DB row.
    const auto = manager.createSession({ projectPath: '/tmp/proj', approvalPolicy: 'auto' })
    if (!auto.ok) throw new Error(auto.error)
    expect(auto.session.approvalPolicy).toBe('auto')
    expect(registry.get(auto.session.id)?.approvalPolicy).toBe('auto')
    expect(db.getChatSession(auto.session.id)?.approvalPolicy).toBe('auto')

    // Absent field falls back to manual (older clients, terminal path).
    const manual = manager.createSession({ projectPath: '/tmp/proj' })
    if (!manual.ok) throw new Error(manual.error)
    expect(manual.session.approvalPolicy).toBe('manual')
    expect(db.getChatSession(manual.session.id)?.approvalPolicy).toBe('manual')

    // A named profile does not override the supplied policy.
    const profiled = manager.createSession({
      projectPath: '/tmp/proj',
      claudeProfileId: 'glm',
      approvalPolicy: 'auto',
    })
    if (!profiled.ok) throw new Error(profiled.error)
    expect(profiled.session.claudeProfileId).toBe('glm')
    expect(profiled.session.approvalPolicy).toBe('auto')
    manager.shutdown()
  })

  test('resume re-resolves the stored profile against the current filesystem', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    const project = path.join(tempDir, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    const catalogFile = path.join(project, '.kawai', 'profiles.json')
    fs.writeFileSync(catalogFile, JSON.stringify({
      'glm-turbo': { label: 'GLM Turbo', model: 'glm-5.3-flash[1m]' },
    }))
    const first = await createHarness(db)
    const created = first.manager.createSession({ projectPath: project, claudeProfileId: 'glm-turbo' })
    expect(created.ok).toBe(true)
    await first.manager.send(created.ok ? created.session.id : '', 'first turn')
    expect(first.handles[0]!.options.model).toBe('glm-5.3-flash[1m]')
    first.manager.shutdown()

    // The defining file is gone after a restart: the session survives with
    // its stored identity, and sending reports the missing profile.
    fs.rmSync(catalogFile)
    const restored = await createHarness(db)
    const result = await restored.manager.send(created.ok ? created.session.id : '', 'resume')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('glm-turbo')
    expect(restored.registry.get(created.ok ? created.session.id : '')?.claudeProfileId).toBe('glm-turbo')
    expect(restored.handles).toHaveLength(0)
  })

  test('catalog file failures are reported and the rest of the catalog still launches', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    const project = path.join(tempDir, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    const badFile = path.join(project, '.kawai', 'profiles.json')
    fs.writeFileSync(badFile, '{ not json')
    const reported: string[][] = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory([]),
      catalogErrorLog: errors => reported.push(errors),
    })
    // The invalid file is skipped: Default (shipped catalog) still creates
    // and spawns — but the failure is reported instead of vanishing.
    const created = manager.createSession({ projectPath: project })
    expect(created.ok).toBe(true)
    expect((await manager.send(created.ok ? created.session.id : '', 'hi')).ok).toBe(true)
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]![0]).toContain(badFile)
    manager.shutdown()
  })

  test('profile auth uses global credentials and refuses unauthenticated launch without side effects', async () => {
    writeLanCatalog()
    let globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    const registry = new SessionRegistry()
    const handles: FakeHandle[] = []
    const manager = await managedManager({ isDirectory: anyDirectory, db, registry, onEvent: () => {}, queryFactory: fakeQueryFactory(handles), getProviderEnv: () => globalEnv })
    for (const profile of ['glm', 'minimax', 'kimi']) {
      const result = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: profile })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      globalEnv = { ANTHROPIC_AUTH_TOKEN: '' }
      expect((await manager.send(result.session.id, 'no auth')).ok).toBe(false)
      expect(handles).toHaveLength(0)
      globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    }
    manager.shutdown()
    globalEnv = { ANTHROPIC_AUTH_TOKEN: '' }
    const count = db.getChatSessions().length
    expect(manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'lan' }).ok).toBe(false)
    expect(db.getChatSessions()).toHaveLength(count)
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    expect(manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'lan' }).ok).toBe(true)
  })

  test('availability caches complete profile configuration and retries failures', async () => {
    writeLanCatalog()
    let globalEnv = { ANTHROPIC_AUTH_TOKEN: 'global-token' }
    const launches: ClaudeLaunchConfiguration[] = []
    let fail = false
    const manager = await managedManager({ isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {}, getProviderEnv: () => globalEnv,
      availabilityProbe: async (_env, launch) => { launches.push(launch!); if (fail) throw new Error('failed') },
    })
    const create = (claudeProfileId: string) => manager.createAvailableSession({ projectPath: '/tmp/proj', claudeProfileId })
    await Promise.all([create('glm'), create('glm')])
    await create('minimax')
    await create('glm')
    expect(launches).toHaveLength(2)
    expect(launches[0]?.model).toBe('opus')
    expect(launches[1]?.model).toBe('MiniMax-M3')
    expect(launches[0]?.settings).toMatchObject({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]' } })
    globalEnv = { ANTHROPIC_AUTH_TOKEN: 'changed-token' }
    await create('glm')
    expect(launches).toHaveLength(3)
    fail = true
    expect((await create('lan')).ok).toBe(false)
    fail = false
    expect((await create('lan')).ok).toBe(true)
    expect(launches).toHaveLength(5)
    manager.shutdown()
  })

  describe('auth gate', () => {
    test('failed availability probe disables creation without creating a driver or row', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        availabilityProbe: async () => { probes++; throw new Error('broken runtime') },
      })
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toContain('Claude Agent SDK is unavailable')
          expect(result.error).toContain('try again')
        }
      }
      // Failures are not cached: each attempt re-probes.
      expect(probes).toBe(2)
      expect(db.getChatSessions()).toHaveLength(0)
      expect(registry.getAll()).toHaveLength(0)
    })

    test('a probe that failed recovers once the provider environment is corrected', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let providerEnv: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://broken.example' }
      const probed: string[] = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async (env) => {
          probed.push(env.ANTHROPIC_BASE_URL ?? '')
          if (env.ANTHROPIC_BASE_URL === 'https://broken.example') throw new Error('unreachable')
        },
        getProviderEnv: () => providerEnv,
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(false)
      providerEnv = { ANTHROPIC_BASE_URL: 'https://fixed.example' }
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probed).toEqual(['https://broken.example', 'https://fixed.example'])
    })

    test('a provider change re-probes; the same configuration (any key order) reuses the probe', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let providerEnv: Record<string, string> = { A: '1', B: '2' }
      let probes = 0
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async () => { probes++ },
        getProviderEnv: () => providerEnv,
      })
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      providerEnv = { B: '2', A: '1' }
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(probes).toBe(1)
      providerEnv = { A: '1', B: '3' }
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(probes).toBe(2)
    })

    test('concurrent creations share one in-flight probe', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      let release!: () => void
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: () => { probes++; return new Promise<void>((resolve) => { release = resolve }) },
      })
      const first = manager.createAvailableSession({ projectPath: '/tmp/proj' })
      const second = manager.createAvailableSession({ projectPath: '/tmp/proj' })
      // The executable check precedes the probe, so let it start first.
      await flush()
      release()
      expect((await first).ok).toBe(true)
      expect((await second).ok).toBe(true)
      expect(probes).toBe(1)
    })

    test('successful availability probe is cached for subsequent creations', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let probes = 0
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        availabilityProbe: async () => { probes++ },
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probes).toBe(1)
    })
    test('refuses creation with an actionable error when no auth exists', async () => {
      const { manager, registry } = await createHarness(db)
      const result = manager.createSession({ projectPath: '/tmp/proj' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('ANTHROPIC_API_KEY')
        expect(result.error).toContain('claude login')
      }
      // No side effects: nothing registered, nothing persisted.
      expect(registry.getAll()).toHaveLength(0)
      expect(db.getChatSessions()).toHaveLength(0)
      expect(hasClaudeAuth()).toBe(false)
    })

    test('accepts ANTHROPIC_API_KEY from the environment', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      expect(hasClaudeAuth()).toBe(true)
      const { manager } = await createHarness(db)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('accepts an OAuth token from the environment', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const { manager } = await createHarness(db)
      expect(hasClaudeAuth()).toBe(true)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('accepts ANTHROPIC_AUTH_TOKEN from the environment', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token'
      expect(hasClaudeAuth()).toBe(true)
    })

    test('evaluates credentials against the provider environment', () => {
      expect(hasClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 'gateway-token' })).toBe(true)
      expect(hasClaudeAuth({ ANTHROPIC_API_KEY: 'sk-provider' })).toBe(true)
      // An override can also blank an inherited credential.
      process.env.ANTHROPIC_API_KEY = 'sk-host'
      expect(hasClaudeAuth({ ANTHROPIC_API_KEY: '' })).toBe(false)
      // And redirect the CLI config dir to one with stored credentials.
      const providerConfig = path.join(tempDir, 'provider-config')
      fs.mkdirSync(providerConfig, { recursive: true })
      fs.writeFileSync(path.join(providerConfig, '.credentials.json'), '{}')
      delete process.env.ANTHROPIC_API_KEY
      expect(hasClaudeAuth({ CLAUDE_CONFIG_DIR: providerConfig })).toBe(true)
    })

    test('a credential supplied only by getProviderEnv allows creation', async () => {
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        queryFactory: fakeQueryFactory([]),
        getProviderEnv: () => ({ ANTHROPIC_AUTH_TOKEN: 'gateway-token' }),
      })
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('the availability probe runs under the provider environment', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const probed: Array<Record<string, string>> = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async (providerEnv) => { probed.push(providerEnv) },
        getProviderEnv: () => ({ ANTHROPIC_BASE_URL: 'https://gw.example/a' }),
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(probed).toEqual([{ ANTHROPIC_BASE_URL: 'https://gw.example/a' }])
    })

    test('rejects a blank OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '   '
      expect(hasClaudeAuth()).toBe(false)
    })

    test('accepts CLI credentials under CLAUDE_CONFIG_DIR', async () => {
      fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
        '{}'
      )
      expect(hasClaudeAuth()).toBe(true)
      const { manager } = await createHarness(db)
      expect(manager.createSession({ projectPath: '/tmp/proj' }).ok).toBe(true)
    })

    test('a credentialed provider needs its own key variable, whatever host login exists', async () => {
      writeCredentialedProviderCatalog(tempDir)
      // A host claude.ai login and a server API key exist; neither counts.
      fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{}')
      process.env.ANTHROPIC_API_KEY = 'sk-host'
      let providerEnv: Record<string, string> = {}
      const handles: FakeHandle[] = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        profileCatalogHome: tempDir,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        getProviderEnv: () => providerEnv,
      })
      const refused = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'or2-opus' })
      expect(refused).toEqual({ ok: false, error: 'Provider OR2 needs OR2_KEY in the server environment.' })
      expect(db.getChatSessions()).toEqual([])
      expect(handles).toHaveLength(0)
      // The variable alone (here from Settings) authenticates.
      providerEnv = { OR2_KEY: 'or-sentinel' }
      expect(manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'or2-opus' }).ok).toBe(true)
    })
  })

  describe('executable gate', () => {
    test('refuses creation with the executable error verbatim and persists nothing', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const registry = new SessionRegistry()
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        executableCheck: () => Promise.reject(
          new ClaudeExecutableError('missing', 'No Claude Code executable found. Install Claude Code.')
        ),
      })
      const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(result).toEqual({ ok: false, error: 'No Claude Code executable found. Install Claude Code.' })
      expect(db.getChatSessions()).toEqual([])
      expect(registry.getAll().filter((session) => session.kind === 'chat')).toEqual([])
    })

    test('creation re-checks after an executable failure and recovers', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let checks = 0
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async () => {},
        executableCheck: async () => {
          checks += 1
          if (checks === 1) throw new ClaudeExecutableError('missing', 'No Claude Code executable found.')
          return { path: '/opt/claude', identity: 'id-1' }
        },
      })
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(false)
      expect((await manager.createAvailableSession({ projectPath: '/tmp/proj' })).ok).toBe(true)
      expect(checks).toBe(2)
    })

    test('an upgraded executable re-runs the handshake; an unchanged one reuses it', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      let checks = 0
      let probes = 0
      const probedPaths: Array<string | undefined> = []
      let identity = 'id-1'
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        executableCheck: async () => {
          checks += 1
          return { path: '/opt/claude', identity }
        },
        availabilityProbe: async (_env, _launch, executablePath) => {
          probes += 1
          probedPaths.push(executablePath)
        },
      })
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(probes).toBe(1)
      expect(probedPaths[0]).toBe('/opt/claude')

      // Same executable identity: the version check runs again, the cached
      // handshake is reused.
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(checks).toBe(2)
      expect(probes).toBe(1)

      // An upgrade at the same path (new identity) re-runs the handshake too.
      identity = 'id-2'
      await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      expect(checks).toBe(3)
      expect(probes).toBe(2)
      expect(probedPaths[1]).toBe('/opt/claude')
    })

    test('a send after the executable disappears is refused with the record intact', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const { manager, handles } = await createHarness(db)
      let available = true
      const gated = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        executableCheck: async () => {
          if (!available) throw new ClaudeExecutableError('missing', `Claude Code executable not found at /opt/claude.`)
          return { path: '/opt/claude', identity: 'id-1' }
        },
      })
      const created = await gated.createAvailableSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('creation should succeed')
      expect((await gated.send(created.session.id, 'first turn')).ok).toBe(true)
      handles[0]!.push(initMessage('sdk-session-9'))
      await flush()
      // The agent dies (process exit); the executable then disappears.
      handles[0]!.query.close()
      await flush()
      available = false
      const refused = await gated.send(created.session.id, 'second turn')
      expect(refused).toEqual({ ok: false, error: 'Claude Code executable not found at /opt/claude.' })
      expect(gated.has(created.session.id)).toBe(true)
      expect(manager.has(created.session.id)).toBe(false)
      expect(db.getChatSessions().map((row) => row.sdkSessionId)).toEqual(['sdk-session-9'])
      // History reading still answers (the transcript file never existed in
      // this fixture; the stored identity that locates it is intact).
      expect(gated.getHistory(created.session.id)).not.toBeNull()
    })

    test('a respawn uses the freshly verified path when the executable moved', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const handles: FakeHandle[] = []
      let current = '/old/claude'
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        executableCheck: async () => ({ path: current, identity: current }),
      })
      const created = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('creation should succeed')
      expect((await manager.send(created.session.id, 'first')).ok).toBe(true)
      expect(handles[0]!.options.pathToClaudeCodeExecutable).toBe('/old/claude')

      // The agent dies; the CLI moves and PATH now resolves a replacement.
      handles[0]!.query.close()
      await flush()
      current = '/new/claude'
      expect((await manager.send(created.session.id, 'second')).ok).toBe(true)
      expect(handles).toHaveLength(2)
      expect(handles[1]!.options.pathToClaudeCodeExecutable).toBe('/new/claude')
    })

    test('an injected queryFactory skips the executable check entirely', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const original = process.env.KAWAI_CLAUDE_PATH
      process.env.KAWAI_CLAUDE_PATH = '/nonexistent-claude'
      try {
        const { manager } = await createHarness(db)
        const result = await manager.createAvailableSession({ projectPath: '/tmp/proj' })
        expect(result.ok).toBe(true)
      } finally {
        if (original === undefined) delete process.env.KAWAI_CLAUDE_PATH
        else process.env.KAWAI_CLAUDE_PATH = original
      }
    })
  })

  test('provider env reaches the SDK spawn and Settings changes apply to the next driver', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    let providerEnv: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://gw.example/a' }
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory(handles),
      getProviderEnv: () => providerEnv,
    })
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    expect(handles[0]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example/a')

    providerEnv = { ANTHROPIC_BASE_URL: 'https://gw.example/b' }
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(second.session.id, 'hello')
    expect(handles[1]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example/b')
    manager.kill(first.session.id)
    manager.kill(second.session.id)
  })

  test('without provider env the SDK spawn gets the server env minus catalog-named key variables', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    process.env.OPENROUTER_MANAGEMENT_KEY = 'management-sentinel'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    // The shipped catalog names OpenRouter's keys (openrouter-provider D3).
    const env = handles[0]!.options.env as Record<string, string | undefined>
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token')
    expect(env).not.toHaveProperty('OPENROUTER_MANAGEMENT_KEY')
    manager.kill(created.session.id)
  })

  test('each driver records into its session wire log, and kill deletes the log', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory(handles), wireLogs,
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const sessionId = created.session.id
    await manager.send(sessionId, 'hello')
    expect(handles[0]!.options.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(handles[0]!.wire).toBe(wireLogs.get(sessionId))
    handles[0]!.wire!.record('in', '{"type":"system"}')
    expect((await wireLogs.readPage(sessionId, { limit: 10 })).frames.map(frame => frame.raw))
      .toEqual(['{"type":"system"}'])
    const logFile = wireLogs.get(sessionId).currentPath
    expect(fs.existsSync(logFile)).toBe(true)

    manager.kill(sessionId)
    await flush()
    expect(fs.existsSync(logFile)).toBe(false)
  })

  test('startup prunes wire logs of sessions that no longer exist', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const dir = path.join(tempDir, 'chat-wire')
    const first = await managedManager({ isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {} })
    const kept = first.createSession({ projectPath: '/tmp/proj' })
    if (!kept.ok) throw new Error('create failed')
    const seed = new ChatWireLogs({ dir })
    for (const id of [kept.session.id, 'chat-orphan']) {
      seed.get(id).record('in', 'frame')
      await seed.get(id).flush()
    }
    managedManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {}, wireLogs: new ChatWireLogs({ dir }),
    })
    await flush()
    expect(fs.readdirSync(dir)).toEqual([`${kept.session.id}.jsonl`])
  })

  test('without wire logs the SDK spawns its own process', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    expect('spawnClaudeCodeProcess' in handles[0]!.options).toBe(false)
    manager.kill(created.session.id)
  })

  test('create registers a chat session and persists a row', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry } = await createHarness(db)
    const result = manager.createSession({
      projectPath: '/tmp/proj',
      name: 'delta',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const session = registry.get(result.session.id)
    expect(session).toMatchObject({
      id: result.session.id,
      name: 'delta',
      kind: 'chat',
      projectPath: '/tmp/proj',
      status: 'waiting',
      source: 'managed',
      agentType: 'claude',
    })
    expect(result.session.id).toMatch(/^chat-[0-9a-f-]{36}$/)
    expect(result.session.tmuxWindow).toBeUndefined()
    expect(result.session.createdAt).toBeTruthy()

    const row = db.getChatSession(result.session.id)
    expect(row).toMatchObject({
      sessionId: result.session.id,
      name: 'delta',
      projectPath: '/tmp/proj',
      sdkSessionId: null,
      status: 'waiting',
    })

    // A generated name is used when none is offered.
    const unnamed = manager.createSession({ projectPath: '/tmp/proj' })
    expect(unnamed.ok).toBe(true)
    if (unnamed.ok) expect(unnamed.session.name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  test('reconnect snapshots retain unfinished output and live pending requests without duplicating disk events', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'hello')
    const handle = handles[0]!
    handle.push({ type: 'assistant', uuid: 'live-a', message: { id: 'message-a', role: 'assistant', content: [{ type: 'text', text: 'unfinished' }] } } as unknown as SDKMessage)
    await flush()
    const pending = handle.options.canUseTool!('Bash', { command: 'echo hello' }, {
      signal: new AbortController().signal, toolUseID: 'tool-a', requestId: 'request-a',
    })
    await flush()
    const snapshot = manager.getSnapshot(id)!
    expect(snapshot.status).toBe('permission')
    expect(snapshot.pendingRequests).toHaveLength(1)
    expect(snapshot.events.filter(event => event.type === 'assistant_text')).toHaveLength(1)
    expect(snapshot.throughSequence).toBe(snapshot.events.at(-1)!.sequence)
    expect(snapshot.events.map(event => event.sequence)).toEqual(snapshot.events.map((_, index) => index + 1))
    const requestId = snapshot.pendingRequests[0]!.requestId
    expect(manager.resolveApproval(id, requestId, 'allow').ok).toBe(true)
    await pending
    expect(manager.getSnapshot(id)!.pendingRequests).toEqual([])
    expect(manager.getSnapshot(id)!.status).toBe('working')
    expect(manager.getSnapshot(id)!.events.at(-1)).toMatchObject({ type: 'request_resolved', outcome: 'allowed' })
    manager.kill(id)
    expect(manager.getSnapshot(id)).toBeNull()
  })

  describe('start on attach', () => {
    test('starts the agent without a prompt; sends reuse the same driver', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, events } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      expect(await manager.start(sessionId)).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
      // No prompt, no turn: the spawn alone produced no events.
      expect(events).toEqual([])
      expect(manager.getSnapshot(sessionId)?.status).toBe('waiting')

      expect(await manager.send(sessionId, 'hello')).toEqual({ ok: true })
      expect(handles).toHaveLength(1) // one driver for start + send
      expect(handles[0]!.options.cwd).toBe('/tmp/proj')
      manager.shutdown()
    })

    test('start is refused for archived sessions and starts nothing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      manager.archive(created.session.id)
      expect(await manager.start(created.session.id)).toEqual({
        ok: false,
        error: 'This chat session is archived. Restore it to continue the conversation.',
      })
      expect(handles).toHaveLength(0)
      // The refusal text is exposed read-only for the unavailable-recipient
      // waiting reason (team-waiting-reasons D2): same text `available`
      // rejects on, null for a session that may start.
      const record = db.getChatSession(created.session.id)!
      expect(manager.startBlockerFor(record)).toBe('This chat session is archived. Restore it to continue the conversation.')
      const fresh = manager.createSession({ projectPath: '/tmp/proj' })
      if (!fresh.ok) throw new Error('create failed')
      expect(manager.startBlockerFor(db.getChatSession(fresh.session.id)!)).toBeNull()
    })

    test('start is refused when the project directory is missing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let exists = true
      const { manager, handles } = await createHarness(db, () => exists)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      exists = false
      expect(await manager.start(created.session.id)).toMatchObject({ ok: false })
      expect(handles).toHaveLength(0)
      // The refusal keeps the session: sending reports the same reason.
      expect((await manager.send(created.session.id, 'hi')).ok).toBe(false)
    })

    test('start is refused when the stored transcript is missing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'start-ghost.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)
      const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harnessA.manager.send(sessionId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-start-ghost'))
      await flush()
      closeDispatchers()
      dbA.close()

      // Restart with no transcript on disk: attach must not silently start a
      // fresh conversation under the stored id.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
      const result = await harnessB.manager.start(sessionId)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('sdk-start-ghost')
      expect(harnessB.handles).toHaveLength(0)
      closeDispatchers()
      dbB.close()
    })

    test('concurrent start and send share one driver', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      const [started, sent] = await Promise.all([
        manager.start(sessionId),
        manager.send(sessionId, 'hello'),
      ])
      expect(started).toEqual({ ok: true })
      expect(sent).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
    })

    test('a spawn failure is reported as a session error and retried later', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      const events: Array<{ sessionId: string; event: ChatEvent }> = []
      let broken = true
      const handles: FakeHandle[] = []
      const failingFactory: ChatQueryFactory = (params) => {
        if (broken) throw new Error('spawn exploded')
        return fakeQueryFactory(handles)(params)
      }
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry,
        onEvent: (sessionId, event) => events.push({ sessionId, event }),
        queryFactory: failingFactory,
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      expect(await manager.start(sessionId)).toEqual({ ok: true })
      await flush()
      const error = events.find((e) => e.event.type === 'error')
      expect(error?.event).toMatchObject({ message: 'The agent process failed to start: spawn exploded' })
      // The session survives the failed spawn.
      expect(db.getChatSession(sessionId)).not.toBeNull()

      // Once the spawn works again, a later start respawns.
      broken = false
      expect(await manager.start(sessionId)).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
      manager.shutdown()
    })
  })

  describe('command state delivery', () => {
    test('snapshot carries the live driver state; pushes fire on change and archive', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      const handles: FakeHandle[] = []
      const events: Array<{ sessionId: string; event: ChatEvent }> = []
      const commandStates: Array<{ sessionId: string; status: string }> = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry,
        onEvent: (sessionId, event) => events.push({ sessionId, event }),
        onCommandState: (sessionId, state) =>
          commandStates.push({ sessionId, status: state.status }),
        queryFactory: fakeQueryFactory(handles),
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      // Before any spawn: unavailable, no special-casing on the client.
      expect(manager.getSnapshot(sessionId)?.commands).toEqual({
        status: 'unavailable',
        commands: [],
      })

      await manager.start(sessionId)
      await flush()
      expect(commandStates).toEqual([{ sessionId, status: 'loading' }])

      handles[0]!.push({
        type: 'system',
        subtype: 'commands_changed',
        commands: [{ name: 'usage', description: 'costs', builtin: true }],
      } as unknown as SDKMessage)
      await flush()
      expect(commandStates.at(-1)).toEqual({ sessionId, status: 'ready' })
      expect(manager.getSnapshot(sessionId)?.commands).toEqual({
        status: 'ready',
        commands: [{ name: 'usage', description: 'costs', aliases: [], source: 'builtin' }],
      })

      manager.archive(sessionId)
      await flush()
      expect(commandStates.at(-1)).toEqual({ sessionId, status: 'unavailable' })
      expect(manager.getSnapshot(sessionId)?.commands.status).toBe('unavailable')
      manager.shutdown()
    })

    test('blocked starts publish no command state', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      const commandStates: string[] = []
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry,
        onEvent: () => {},
        onCommandState: (_sessionId, state) => commandStates.push(state.status),
        queryFactory: fakeQueryFactory([]),
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      manager.archive(created.session.id)
      expect(await manager.start(created.session.id)).toMatchObject({ ok: false })
      await flush()
      expect(commandStates).toEqual([])
      manager.shutdown()
    })
  })

  test('first send lazily spawns the driver and persists sdkSessionId immediately', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles, events } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const sessionId = created.session.id

    expect(handles).toHaveLength(0) // no SDK spawn at create time
    await manager.send(sessionId, 'hello')
    expect(handles).toHaveLength(1) // spawned lazily by the first turn
    expect(registry.get(sessionId)?.status).toBe('working')
    expect(handles[0]!.options.cwd).toBe('/tmp/proj')
    expect(handles[0]!.options.resume).toBeUndefined()
    expect(
      events.filter((e) => e.sessionId === sessionId).map((e) => e.event.type)
    ).toEqual(['turn_started', 'user_message'])

    // The init message reveals the SDK session id; it must hit the db at once.
    handles[0]!.push(initMessage('sdk-session-abc'))
    await flush()
    expect(db.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-session-abc')
    expect(manager.getSdkSessionIds().has('sdk-session-abc')).toBe(true)

    // The row still exists with the id after a later status write.
    expect(manager.interrupt(sessionId)).toEqual({ ok: true })
    expect(db.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-session-abc')
  })

  test('kill denies pending approvals, removes session and row, ignores later sends', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const sessionId = created.session.id
    await manager.send(sessionId, 'go')
    const handle = handles[0]!

    const approval = handle.options.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
    )
    await flush()
    handle.push(initMessage('sdk-doomed'))
    await flush()

    expect(manager.kill(sessionId)).toBe(true)
    expect(handle.closed).toBe(true)
    await expect(approval).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: true,
    })
    expect(registry.get(sessionId)).toBeUndefined()
    expect(db.getChatSession(sessionId)).toBeNull()
    expect(manager.getSdkSessionIds().has('sdk-doomed')).toBe(false)

    // Killing again is a no-op; sends to the dead session are refused.
    expect(manager.kill(sessionId)).toBe(false)
    await expect(manager.send(sessionId, 'ghost')).resolves.toMatchObject({
      ok: false,
    })
  })

  describe('archive and restore', () => {
    test('archiving an idle session keeps record, conversation, and protocol log', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
      const handles: FakeHandle[] = []
      const registry = new SessionRegistry()
      const updates: Array<Session | undefined> = []
      registry.on('session-update', (session) => updates.push(session))
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry, onEvent: () => {},
        queryFactory: fakeQueryFactory(handles), wireLogs,
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await manager.send(sessionId, 'one')
      handles[0]!.push(initMessage('sdk-archived'))
      await flush()
      handles[0]!.wire!.record('in', '{"type":"system"}')
      await flush()

      expect(manager.archive(sessionId)).toEqual({ ok: true })
      expect(handles[0]!.closed).toBe(true)
      // Record, conversation id, and protocol log all survive.
      const row = db.getChatSession(sessionId)!
      expect(row.archivedAt).toBeTruthy()
      expect(row.sdkSessionId).toBe('sdk-archived')
      expect(row.status).toBe('waiting')
      expect(fs.existsSync(wireLogs.get(sessionId).currentPath)).toBe(true)
      expect(manager.getSnapshot(sessionId)).not.toBeNull()
      const published = registry.get(sessionId)
      expect(published?.archivedAt).toBe(row.archivedAt)
      expect(updates.at(-1)?.archivedAt).toBe(row.archivedAt)

      // A second archive is a harmless idempotent no-op.
      expect(manager.archive(sessionId)).toEqual({ ok: true })
    })

    test('archiving an in-flight turn cancels pending requests and reports them to subscribers', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, events, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await manager.send(sessionId, 'work')
      const handle = handles[0]!
      const approval = handle.options.canUseTool!(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' }
      )
      await flush()
      expect(registry.get(sessionId)?.status).toBe('permission')
      expect(manager.getPendingRequests(sessionId)).toHaveLength(1)

      expect(manager.archive(sessionId)).toEqual({ ok: true })
      await flush()
      await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
      const types = events
        .filter((e) => e.sessionId === sessionId)
        .map((e) => e.event.type)
      expect(types).toContain('request_resolved')
      expect(
        events.some(
          (e) =>
            e.sessionId === sessionId &&
            e.event.type === 'request_resolved' &&
            e.event.outcome === 'cancelled'
        )
      ).toBe(true)
      expect(types).toContain('turn_interrupted')
      expect(registry.get(sessionId)?.status).toBe('waiting')
      expect(manager.getPendingRequests(sessionId)).toEqual([])
      expect(handle.closed).toBe(true)
    })

    test('send to an archived session is refused and starts no driver', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      manager.archive(sessionId)
      const result = await manager.send(sessionId, 'hello?')
      expect(result).toEqual({
        ok: false,
        error: 'This chat session is archived. Restore it to continue the conversation.',
      })
      expect(handles).toHaveLength(0)
    })

    test('a driver import racing archive never starts the process', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      // First send starts the in-flight driver promise (import resolving);
      // archive lands before it completes. ensureDriver must discard the
      // driver instead of registering it.
      const sendPromise = manager.send(sessionId, 'race')
      manager.archive(sessionId)
      await sendPromise
      await flush()
      expect(handles.every((handle) => handle.closed)).toBe(true)
      expect(db.getChatSession(sessionId)?.archivedAt).toBeTruthy()
      // Still archived and driverless afterwards.
      expect((await manager.send(sessionId, 'again')).ok).toBe(false)
      const started = handles.filter((handle) => !handle.closed)
      expect(started).toHaveLength(0)
    })

    test('restore clears archived_at and the next send resumes the stored conversation', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await manager.send(sessionId, 'first')
      handles[0]!.push(initMessage('sdk-resume-after-archive'))
      await flush()
      manager.archive(sessionId)
      expect(registry.get(sessionId)?.archivedAt).toBeTruthy()

      expect(manager.restore(sessionId)).toEqual({ ok: true })
      expect(db.getChatSession(sessionId)?.archivedAt).toBeNull()
      // The published session carries archivedAt: null (falsy = live).
      expect(registry.get(sessionId)?.archivedAt).toBeNull()
      // Resume needs the transcript on disk (the resume gate).
      writeTranscript('sdk-resume-after-archive', '[]')
      expect((await manager.send(sessionId, 'continue')).ok).toBe(true)
      expect(handles[1]!.options.resume).toBe('sdk-resume-after-archive')
      // Restoring an unarchived session is a harmless no-op.
      expect(manager.restore(sessionId)).toEqual({ ok: true })
    })

    test('archived sessions survive a manager restart as archived, idle, and driverless', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const wireLogs = new ChatWireLogs({ dir: path.join(tempDir, 'chat-wire') })
      const handles: FakeHandle[] = []
      const managerA = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles), wireLogs,
      })
      const created = managerA.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await managerA.send(sessionId, 'one')
      handles[0]!.push(initMessage('sdk-restart-archived'))
      await flush()
      handles[0]!.wire!.record('in', '{"type":"system"}')
      await flush()
      managerA.archive(sessionId)
      const archivedAt = db.getChatSession(sessionId)!.archivedAt!
      managerA.shutdown()

      // "Restart": fresh registry and manager on the same database and logs.
      const handlesB: FakeHandle[] = []
      const registryB = new SessionRegistry()
      const managerB = await managedManager({
        isDirectory: anyDirectory,
        db, registry: registryB, onEvent: () => {},
        queryFactory: fakeQueryFactory(handlesB), wireLogs,
      })
      expect(registryB.get(sessionId)?.archivedAt).toBe(archivedAt)
      expect(registryB.get(sessionId)?.status).toBe('waiting')
      // Attach replays the transcript snapshot without starting a driver.
      expect(managerB.getSnapshot(sessionId)?.events.length).toBeGreaterThanOrEqual(0)
      expect(handlesB).toHaveLength(0)
      // Send is refused while archived even after restart.
      expect((await managerB.send(sessionId, 'nope')).ok).toBe(false)
      expect(handlesB).toHaveLength(0)

      // Kill on an archived session removes row and protocol log.
      const logFile = wireLogs.get(sessionId).currentPath
      expect(fs.existsSync(logFile)).toBe(true)
      expect(managerB.kill(sessionId)).toBe(true)
      await flush()
      expect(fs.existsSync(logFile)).toBe(false)
      expect(db.getChatSession(sessionId)).toBeNull()
      expect(registryB.get(sessionId)).toBeUndefined()
      managerB.shutdown()
    })

    test('archive and restore on unknown sessions return actionable errors', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager } = await createHarness(db)
      expect(manager.archive('chat-none')).toEqual({
        ok: false,
        error: 'Unknown chat session chat-none',
      })
      expect(manager.restore('chat-none')).toEqual({
        ok: false,
        error: 'Unknown chat session chat-none',
      })
    })
  })

  test('actions on unknown sessions and idle sessions return actionable errors', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager } = await createHarness(db)
    expect(manager.interrupt('chat-none')).toMatchObject({ ok: false })
    await expect(manager.send('chat-none', 'x')).resolves.toMatchObject({
      ok: false,
    })
    expect(
      manager.resolveApproval('chat-none', 'req-1', 'allow')
    ).toMatchObject({ ok: false })

    // Known but idle (no driver): interrupt is a harmless no-op, approvals
    // have nothing pending.
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(manager.interrupt(created.session.id)).toEqual({ ok: true })
    const approval = manager.resolveApproval(created.session.id, 'req-1', 'deny')
    expect(approval).toMatchObject({ ok: false })
    if (!approval.ok) {
      expect(approval.error).toContain('req-1')
    }
    const answer = manager.answerQuestion(created.session.id, 'req-1', {})
    expect(answer).toMatchObject({ ok: false })
    if (!answer.ok) {
      expect(answer.error).toContain('req-1')
    }
  })

  test('shutdown settles drivers without removing sessions', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const { manager, registry, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hi')

    manager.shutdown()
    expect(handles[0]!.closed).toBe(true)
    // Rows survive shutdown; the restart path restores them.
    expect(db.getChatSession(created.session.id)).not.toBeNull()
    expect(registry.get(created.session.id)).toBeDefined()
  })

  describe('project directory', () => {
    test('creation refuses a path that is not an existing directory, with no side effects', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const registry = new SessionRegistry()
      // No isDirectory override: the real filesystem check runs.
      const manager = await managedManager({ db, registry, onEvent: () => {} })
      const file = path.join(tempDir, 'file.txt')
      fs.writeFileSync(file, '')
      for (const projectPath of [
        path.join(tempDir, 'missing'),
        `${tempDir} (deleted)`,
        file,
      ]) {
        expect(manager.createSession({ projectPath })).toEqual({
          ok: false,
          error: `Project directory does not exist: ${projectPath}`,
        })
      }
      expect(registry.getAll()).toHaveLength(0)
      expect(db.getChatSessions()).toHaveLength(0)
      expect(manager.createSession({ projectPath: `  ${tempDir}  ` }).ok).toBe(true)
    })

    test('a home-relative path is checked and stored as an absolute path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const checked: string[] = []
      const { manager } = await createHarness(db, (dir) => {
        checked.push(dir)
        return true
      })
      const result = manager.createSession({ projectPath: '~/work/app' })
      if (!result.ok) throw new Error('create failed')
      const expected = path.join(os.homedir(), 'work', 'app')
      expect(checked).toEqual([expected])
      expect(result.session.projectPath).toBe(expected)
      expect(db.getChatSession(result.session.id)?.projectPath).toBe(expected)
    })

    test('availability-checked creation refuses a missing directory before probing', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let probes = 0
      const manager = await managedManager({
        isDirectory: () => false,
        db, registry: new SessionRegistry(), onEvent: () => {},
        availabilityProbe: async () => { probes++ },
      })
      expect(await manager.createAvailableSession({ projectPath: '/tmp/gone (deleted)' })).toEqual({
        ok: false,
        error: 'Project directory does not exist: /tmp/gone (deleted)',
      })
      expect(probes).toBe(0)
      expect(db.getChatSessions()).toHaveLength(0)
    })

    test('send refuses to spawn when the directory disappeared, keeping the session', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let exists = true
      const { manager, registry, handles, events } = await createHarness(db, () => exists)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id

      exists = false
      expect(await manager.send(sessionId, 'Hi')).toEqual({
        ok: false,
        error:
          'Cannot start the agent: the project directory /tmp/proj no longer exists. ' +
          'Create a new chat session in an existing directory.',
      })
      expect(handles).toHaveLength(0)
      expect(events).toHaveLength(0)
      expect(registry.get(sessionId)?.status).toBe('waiting')
      expect(db.getChatSession(sessionId)).not.toBeNull()
      expect(manager.getSnapshot(sessionId)?.events).toEqual([])

      // Restoring the directory makes the session usable again.
      exists = true
      expect(await manager.send(sessionId, 'Hi')).toEqual({ ok: true })
      expect(handles).toHaveLength(1)
    })

    test('a live driver is not blocked by the check; a crashed one is', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      let exists = true
      const { manager, handles } = await createHarness(db, () => exists)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      expect(await manager.send(sessionId, 'first')).toEqual({ ok: true })

      // The running process keeps its cwd, so later turns still go through.
      exists = false
      expect(await manager.send(sessionId, 'second')).toEqual({ ok: true })
      expect(handles).toHaveLength(1)

      // Once the process dies, a respawn would need the directory.
      handles[0]!.query.close()
      await flush()
      const result = await manager.send(sessionId, 'third')
      expect(result.ok).toBe(false)
      expect(handles).toHaveLength(1)
    })
  })

  describe('rename', () => {
    test('rename reaches db, registry, and the session-update broadcast as manual', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      expect(created.session.nameSource).toBe('placeholder')

      const updates: Session[] = []
      registry.on('session-update', (session: Session) => updates.push(session))

      expect(manager.rename(sessionId, '  Claude Code Chat metrics  ').ok).toBe(
        true
      )

      expect(db.getChatSession(sessionId)?.name).toBe('Claude Code Chat metrics')
      expect(db.getChatSession(sessionId)?.nameSource).toBe('manual')

      const inRegistry = registry.get(sessionId)
      expect(inRegistry?.name).toBe('Claude Code Chat metrics')
      expect(inRegistry?.nameSource).toBe('manual')

      expect(updates).toHaveLength(1)
      expect(updates[0]?.id).toBe(sessionId)
      expect(updates[0]?.name).toBe('Claude Code Chat metrics')
      expect(updates[0]?.nameSource).toBe('manual')
    })

    test('rename is a claim: provenance becomes manual even when the name is unchanged', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, registry } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      // An unnamed session starts on a placeholder; re-submitting that same
      // string is still a claim, so provenance must move to manual.
      expect(created.session.nameSource).toBe('placeholder')

      expect(manager.rename(sessionId, created.session.name).ok).toBe(true)
      expect(registry.get(sessionId)?.nameSource).toBe('manual')
      expect(db.getChatSession(sessionId)?.nameSource).toBe('manual')
    })

    test('rename refuses an empty name and an unknown session', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager } = await createHarness(db)
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')

      const empty = manager.rename(created.session.id, '   ')
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.error).toContain('empty')

      const unknown = manager.rename('chat-missing', 'anything')
      expect(unknown.ok).toBe(false)
      if (!unknown.ok) expect(unknown.error).toContain('Unknown')

      // Refusals leave the stored name alone.
      expect(db.getChatSession(created.session.id)?.nameSource).toBe(
        'placeholder'
      )
    })
  })

  describe('cwd tracking', () => {
    test('a cwd move patches the stored path, republishes it, and skips no-ops', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      expect(await harness.manager.send(sessionId, 'enter a worktree')).toEqual({ ok: true })
      expect(harness.handles[0]!.options.cwd).toBe('/tmp/proj')

      const updates: Session[] = []
      harness.registry.on('session-update', (session: Session) => updates.push(session))
      const worktree = '/tmp/proj/.claude/worktrees/add-feature'
      await fireCwdChanged(harness.handles[0]!, worktree)

      // The stored row and the published Session both show the new directory.
      expect(db.getChatSession(sessionId)?.projectPath).toBe(worktree)
      expect(harness.registry.get(sessionId)?.projectPath).toBe(worktree)
      // The session-update broadcast carries the move (worktree tracking D2),
      // so clients re-group the row without a reload.
      const moved = updates.filter((session) => session.id === sessionId)
      expect(moved.at(-1)?.projectPath).toBe(worktree)

      // A repeat for the same directory is a no-op: no write, no broadcast.
      const updateCount = updates.length
      await fireCwdChanged(harness.handles[0]!, worktree)
      expect(updates).toHaveLength(updateCount)
      expect(db.getChatSession(sessionId)?.projectPath).toBe(worktree)
      harness.manager.shutdown()
    })

    test('a respawn after the move resumes in the new directory', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harness.manager.send(sessionId, 'first')
      harness.handles[0]!.push(initMessage('sdk-cwd-session'))
      await flush()
      const worktree = '/tmp/proj/.claude/worktrees/add-feature'
      await fireCwdChanged(harness.handles[0]!, worktree)

      // The process dies; the respawn must land in the worktree, not the
      // creation path, and still resume the same conversation.
      harness.handles[0]!.query.close()
      await flush()
      expect(await harness.manager.send(sessionId, 'second')).toEqual({ ok: true })
      expect(harness.handles).toHaveLength(2)
      expect(harness.handles[1]!.options.cwd).toBe(worktree)
      expect(harness.handles[1]!.options.resume).toBe('sdk-cwd-session')
      harness.manager.shutdown()
    })

    test('several hook events together issue exactly one scoped refresh for the newest path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db, anyDirectory, undefined, undefined, undefined, 5)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      await harness.manager.send(created.session.id, 'cd around')
      // A fast cd chain collapses into one discovery pass for its final
      // directory (worktree tracking D2).
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/one')
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/two')
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/three')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(harness.refreshes).toEqual(['/tmp/proj/.claude/worktrees/three'])
      harness.manager.shutdown()
    })

    test('kill cancels a pending refresh', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db, anyDirectory, undefined, undefined, undefined, 5)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harness.manager.send(sessionId, 'move')
      await fireCwdChanged(harness.handles[0]!, '/tmp/proj/.claude/worktrees/gone')
      harness.manager.kill(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(harness.refreshes).toEqual([])
    })

    for (const action of ['send', 'start'] as const) {
      test(`direct ${action} recovers the path before validating and spawning`, async () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test-key'
        const worktree = '/tmp/proj/.claude/worktrees/recovered'
        const now = new Date().toISOString()
        db.insertChatSession({
          sessionId: 'chat-recovered', name: 'Recovered',
          projectPath: '/tmp/proj', sdkSessionId: 'sdk-late-cwd',
          status: 'waiting', createdAt: now, lastActivityAt: now,
        })
        // No transcript at startup. It arrives before the first direct action,
        // and the original directory is gone: the guard must use the new cwd.
        const harness = await createHarness(db, (directory) => directory === worktree,
          undefined, undefined, undefined, 5)
        writeTranscript('sdk-late-cwd', JSON.stringify({
          type: 'user', uuid: 'recovered-user', cwd: worktree,
          message: { role: 'user', content: 'hello' },
        }))
        const outcome = action === 'send'
          ? await harness.manager.send('chat-recovered', 'continue')
          : await harness.manager.start('chat-recovered')
        expect(outcome).toEqual({ ok: true })
        expect(db.getChatSession('chat-recovered')?.projectPath).toBe(worktree)
        expect(harness.handles[0]!.options.cwd).toBe(worktree)
        expect(harness.handles[0]!.options.resume).toBe('sdk-late-cwd')
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(harness.refreshes).toEqual([worktree])
        harness.manager.shutdown()
      })
    }

    test('history recovery refreshes discovery once for the latest moved path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const harness = await createHarness(db, anyDirectory, undefined, undefined, undefined, 5)
      const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const id = created.session.id
      await harness.manager.send(id, 'first')
      harness.handles[0]!.push(initMessage('sdk-history-cwd'))
      await flush()
      const recover = (cwd: string) => {
        writeTranscript('sdk-history-cwd', JSON.stringify({
          type: 'user', uuid: 'moved-user', cwd,
          message: { role: 'user', content: 'hello' },
        }))
        harness.manager.getHistory(id)
      }
      recover('/tmp/other-repo/one')
      recover('/tmp/other-repo/two')
      recover('/tmp/other-repo/two') // same-path recovery is a no-op
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(harness.refreshes).toEqual(['/tmp/other-repo/two'])
      expect(harness.registry.get(id)?.projectPath).toBe('/tmp/other-repo/two')
      harness.manager.shutdown()
    })

    test('a restored session whose transcript moved comes back with the worktree path', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const first = await createHarness(db)
      const created = first.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await first.manager.send(sessionId, 'enter a worktree')
      first.handles[0]!.push(initMessage('sdk-moved-session'))
      await flush()
      first.manager.shutdown()

      // The transcript records the conversation ending in a worktree.
      const movedLine = (uuid: string, cwd: string) =>
        JSON.stringify({
          type: 'user',
          uuid,
          timestamp: '2026-10-04T10:00:00.000Z',
          message: { role: 'user', content: 'hello' },
          cwd,
        })
      const transcriptPath = writeTranscript(
        'sdk-moved-session',
        [
          movedLine('u1', '/tmp/proj'),
          movedLine('u2', '/tmp/proj/.claude/worktrees/add-feature'),
        ].join('\n')
      )

      // Restart: restorePersisted adopts the transcript's last cwd (design
      // D3), so the row, the registry, and any respawn land in the worktree.
      const restored = await createHarness(db)
      expect(restored.registry.get(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/add-feature'
      )
      expect(db.getChatSession(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/add-feature'
      )
      expect(await restored.manager.send(sessionId, 'continue')).toEqual({ ok: true })
      expect(restored.handles[0]!.options.cwd).toBe(
        '/tmp/proj/.claude/worktrees/add-feature'
      )

      // A later transcript move reaches the attach/history replay the same
      // way (design D3): replaying the history syncs and re-publishes the
      // row. (The first attach after a restart is what replays history —
      // here send already cached a snapshot, so call the replay directly.)
      const updates: Session[] = []
      restored.registry.on('session-update', (session: Session) => updates.push(session))
      fs.writeFileSync(
        transcriptPath,
        movedLine('u3', '/tmp/proj/.claude/worktrees/later') + '\n'
      )
      const replay = restored.manager.getHistory(sessionId)
      expect(replay?.cwd).toBe('/tmp/proj/.claude/worktrees/later')
      expect(restored.registry.get(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/later'
      )
      expect(db.getChatSession(sessionId)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/later'
      )
      expect(updates.at(-1)?.projectPath).toBe(
        '/tmp/proj/.claude/worktrees/later'
      )
      restored.manager.shutdown()
    })
  })

  describe('restart restore', () => {
    test('rows load as idle chat sessions; next send resumes the stored SDK id', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'restart.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)
      const created = harnessA.manager.createSession({
        projectPath: '/tmp/proj',
        name: 'echo',
      })
      if (!created.ok) throw new Error('create failed')
      const startedId = created.session.id

      // A second session created but never started: no SDK id.
      const fresh = harnessA.manager.createSession({ projectPath: '/tmp/other' })
      if (!fresh.ok) throw new Error('create failed')

      await harnessA.manager.send(startedId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-resume-me'))
      await flush()
      // Turn still in flight: the persisted row says working.
      expect(dbA.getChatSession(startedId)?.status).toBe('working')
      closeDispatchers()
      dbA.close()

      // "Restart": fresh db handle, registry, and manager on the same file.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
      const registryB = harnessB.registry

      const restored = registryB.get(startedId)
      expect(restored).toMatchObject({
        id: startedId,
        name: 'echo',
        kind: 'chat',
        projectPath: '/tmp/proj',
        status: 'waiting',
        agentType: 'claude',
      })
      expect(dbB.getChatSession(startedId)).toMatchObject({
        sdkSessionId: 'sdk-resume-me',
        status: 'waiting',
      })
      expect(harnessB.manager.getSdkSessionIds().has('sdk-resume-me')).toBe(
        true
      )

      // The never-started session restored too, with no SDK id.
      expect(registryB.get(fresh.session.id)).toMatchObject({
        kind: 'chat',
        status: 'waiting',
      })
      expect(dbB.getChatSession(fresh.session.id)?.sdkSessionId).toBeNull()

      // Continuing the started session resumes the stored SDK conversation
      // (resume needs the transcript on disk — see the resume gate).
      writeTranscript('sdk-resume-me', '[]')
      await harnessB.manager.send(startedId, 'continue')
      expect(harnessB.handles[0]!.options.resume).toBe('sdk-resume-me')
      // The fresh session starts with no resume.
      await harnessB.manager.send(fresh.session.id, 'begin')
      expect(harnessB.handles[1]!.options.resume).toBeUndefined()

      // Chat sessions coexist with terminal ones in the same registry.
      registryB.replaceSessions([
        {
          id: 'term-1',
          name: 't',
          tmuxWindow: 'agentboard:1',
          projectPath: '/tmp/proj',
          status: 'waiting',
          lastActivity: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          source: 'external',
        },
      ])
      const all = registryB.getAll()
      expect(all.filter((s) => s.kind === 'chat')).toHaveLength(2)
      expect(all.find((s) => s.id === 'term-1')).toBeDefined()
      closeDispatchers()
      dbB.close()
    })

    test('create records name provenance and a restart restores it unchanged', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'name-source.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)

      const named = harnessA.manager.createSession({
        projectPath: '/tmp/proj',
        name: 'show-chat-rate-limits',
      })
      if (!named.ok) throw new Error('create failed')
      expect(named.session.name).toBe('show-chat-rate-limits')
      expect(named.session.nameSource).toBe('manual')

      const unnamed = harnessA.manager.createSession({ projectPath: '/tmp/other' })
      if (!unnamed.ok) throw new Error('create failed')
      expect(unnamed.session.nameSource).toBe('placeholder')

      expect(dbA.getChatSession(named.session.id)?.nameSource).toBe('manual')
      expect(dbA.getChatSession(unnamed.session.id)?.nameSource).toBe(
        'placeholder'
      )
      closeDispatchers()
      dbA.close()

      // "Restart": fresh db handle, registry, and manager on the same file.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
      const restoredNamed = harnessB.registry.get(named.session.id)
      const restoredUnnamed = harnessB.registry.get(unnamed.session.id)
      expect(restoredNamed?.name).toBe('show-chat-rate-limits')
      expect(restoredNamed?.nameSource).toBe('manual')
      expect(restoredUnnamed?.nameSource).toBe('placeholder')
      expect(dbB.getChatSession(named.session.id)?.nameSource).toBe('manual')
      closeDispatchers()
      dbB.close()
    })
  })

  describe('transcript history and resume', () => {
    const MATCHED_TRANSCRIPT = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-10-04T10:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-10-04T10:00:01.000Z',
        message: {
          id: 'msg_1',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-10-04T10:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-10-04T10:00:03.000Z',
        message: {
          id: 'msg_2',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ].join('\n')

    /** A tool that died holding an approval: no tool_result was ever written. */
    const PENDING_REQUEST_TRANSCRIPT = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-04T12:00:00.000Z',
      message: {
        id: 'msg_1',
        content: [
          {
            type: 'tool_use',
            id: 'call_pending',
            name: 'Bash',
            input: { command: 'rm -rf /' },
          },
        ],
      },
    })

    function seedRecord(sdkSessionId: string | null): string {
      const sessionId = `chat-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      db.insertChatSession({
        sessionId,
        name: 'seed',
        projectPath: '/tmp/proj',
        sdkSessionId,
        status: 'waiting',
        createdAt: now,
        lastActivityAt: now,
      })
      return sessionId
    }

    test('getHistory replays a stored transcript into read-only events', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-hist', MATCHED_TRANSCRIPT)
      const sessionId = seedRecord('sdk-hist')
      const fresh = seedRecord(null)
      const { manager } = await createHarness(db)

      const history = manager.getHistory(sessionId)
      expect(history?.status).toBe('ok')
      expect(history?.events.map((e) => e.type)).toEqual([
        'user_message',
        'tool_call',
        'tool_result',
        'assistant_text',
      ])
      for (const event of history?.events ?? []) {
        expect(event.sequence).toBe(0)
      }

      // Never-started sessions have no SDK id and replay as empty.
      expect(manager.getHistory(fresh)).toEqual({ status: 'ok', events: [], cwd: null })
      expect(manager.getHistory('chat-none')).toBeNull()
    })

    test('missing transcript yields a history-unavailable fallback', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const sessionId = seedRecord('sdk-vanished')
      const { manager } = await createHarness(db)

      const history = manager.getHistory(sessionId)
      expect(history?.status).toBe('missing')
      expect(history?.events.map((e) => e.type)).toEqual(['notice'])
      if (history?.events[0]?.type === 'notice') {
        expect(history.events[0].text).toContain('History unavailable')
      }
    })

    test('failed resume preserves the stored id and starts no fresh conversation', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const dbPath = path.join(tempDir, 'resume-fail.db')
      const dbA = initDatabase({ path: dbPath })
      const harnessA = await createHarness(dbA)
      const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      const sessionId = created.session.id
      await harnessA.manager.send(sessionId, 'one')
      harnessA.handles[0]!.push(initMessage('sdk-ghost'))
      await flush()
      expect(dbA.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-ghost')
      closeDispatchers()
      dbA.close()

      // Restart with no transcript on disk for the stored SDK id.
      const dbB = initDatabase({ path: dbPath })
      const harnessB = await createHarness(dbB)
      const result = await harnessB.manager.send(sessionId, 'continue')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('transcript')
        expect(result.error).toContain('sdk-ghost')
      }
      // Nothing spawned: the message must not reach a fresh conversation.
      expect(harnessB.handles).toHaveLength(0)
      // The row and its SDK id survive so a restored transcript can resume.
      expect(dbB.getChatSession(sessionId)?.sdkSessionId).toBe('sdk-ghost')
      expect(harnessB.manager.getHistory(sessionId)?.status).toBe('missing')

      // Restoring the transcript makes the same id resume again.
      writeTranscript('sdk-ghost', MATCHED_TRANSCRIPT)
      await harnessB.manager.send(sessionId, 'continue')
      expect(harnessB.handles[0]!.options.resume).toBe('sdk-ghost')
      closeDispatchers()
      dbB.close()
    })

    test('parser failure with an existing transcript still permits resume', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-ugly', 'not json\n{still not json')
      const sessionId = seedRecord('sdk-ugly')
      const { manager, handles } = await createHarness(db)

      expect(manager.getHistory(sessionId)?.status).toBe('unparseable')

      // The SDK reads the file itself: an unparseable-but-present transcript
      // must not block resume the way a missing one does.
      const result = await manager.send(sessionId, 'keep going')
      expect(result.ok).toBe(true)
      expect(handles[0]!.options.resume).toBe('sdk-ugly')
    })

    test('restart cancellation of pending requests shows in restored history', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      writeTranscript('sdk-pending', PENDING_REQUEST_TRANSCRIPT)
      const sessionId = seedRecord('sdk-pending')
      const { manager } = await createHarness(db)

      // Restored session, no live driver: the dead request is reconstructed
      // and immediately marked cancelled (design D7).
      const history = manager.getHistory(sessionId)
      expect(history?.events.map((e) => e.type)).toEqual([
        'tool_call',
        'approval_request',
        'request_resolved',
      ])
      expect(history?.events[1]).toMatchObject({ requestId: 'call_pending' })
      expect(history?.events[2]).toMatchObject({
        requestId: 'call_pending',
        outcome: 'cancelled',
      })
      expect(manager.getPendingRequests(sessionId)).toEqual([])
    })

    test('worker bodies read the subagent transcript beside the session', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const parent = writeTranscript('sdk-workers', MATCHED_TRANSCRIPT)
      const subagents = path.join(parent.replace(/\.jsonl$/, ''), 'subagents')
      fs.mkdirSync(subagents, { recursive: true })
      fs.writeFileSync(path.join(subagents, 'agent-a1.meta.json'),
        JSON.stringify({ toolUseId: 'toolu_spawn_1' }))
      fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), JSON.stringify({
        type: 'user', uuid: 'w1', isSidechain: true,
        timestamp: '2026-10-04T10:00:00.000Z',
        message: { role: 'user', content: 'Map the workspace' },
      }) + '\n')
      const sessionId = seedRecord('sdk-workers')
      const { manager } = await createHarness(db)

      const body = manager.getWorkerTranscript(sessionId, 'toolu_spawn_1')
      expect(body.status).toBe('ok')
      expect(body.events.map((e) => e.type)).toEqual(['user_message'])
      expect(manager.getWorkerTranscript(sessionId, 'toolu_other').status)
        .toBe('unavailable')
      expect(manager.getWorkerTranscript('no-such-chat', 'toolu_spawn_1').status)
        .toBe('unavailable')
    })
  })

  test('approval policy: starts manual, switches live, refuses invalid changes', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, registry, events } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect(created.session.approvalPolicy).toBe('manual')

    expect(manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    expect(registry.get(id)?.approvalPolicy).toBe('auto')
    expect(db.getChatSession(id)?.approvalPolicy).toBe('auto')
    // Repeat is a no-op success that emits no second notice.
    expect(manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    const notices = events
      .map((entry) => entry.event)
      .filter((event) => event.type === 'notice')
    expect(notices).toHaveLength(1)
    expect((notices[0] as { text: string }).text).toBe('Auto-approve on')
    // The notice is part of the snapshot a later attach receives.
    expect(
      manager.getSnapshot(id)?.events.some(
        (event) =>
          event.type === 'notice' &&
          (event as { text: string }).text === 'Auto-approve on'
      )
    ).toBe(true)

    // Unknown sessions and unsupported values refuse without side effects.
    expect(manager.setApprovalPolicy('chat-missing', 'auto')).toMatchObject({ ok: false })
    expect(
      manager.setApprovalPolicy(id, 'yolo' as unknown as 'auto')
    ).toMatchObject({ ok: false })
    expect(db.getChatSession(id)?.approvalPolicy).toBe('auto')

    // Archived sessions refuse; restoring keeps the stored policy.
    manager.archive(id)
    expect(manager.setApprovalPolicy(id, 'manual')).toMatchObject({ ok: false })
    expect(db.getChatSession(id)?.approvalPolicy).toBe('auto')
    manager.restore(id)
    expect(registry.get(id)?.approvalPolicy).toBe('auto')
    manager.kill(id)
  })

  test('approval policy survives a backend restart', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const dbPath = path.join(tempDir, 'policy-restart.db')
    const dbA = initDatabase({ path: dbPath })
    const harnessA = await createHarness(dbA)
    const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    harnessA.manager.setApprovalPolicy(created.session.id, 'auto')
    harnessA.manager.shutdown()
    closeDispatchers()
    dbA.close()

    const dbB = initDatabase({ path: dbPath })
    try {
      const registryB = new SessionRegistry()
      await managedManager({
        isDirectory: anyDirectory,
        db: dbB,
        registry: registryB,
        onEvent: () => {},
      })
      expect(registryB.get(created.session.id)?.approvalPolicy).toBe('auto')
    } finally {
      closeDispatchers()
      dbB.close()
    }
  })

  test('switching to auto grants a pending approval and the next request', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    const { manager, handles, events } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await manager.send(id, 'go')
    await flush()
    const controller = new AbortController()
    const approval = handles[0]!.options.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: controller.signal, toolUseID: 'toolu_1', requestId: 'sdk-req-1' }
    )
    await flush()
    expect(
      events.some(({ event }) => event.type === 'approval_request')
    ).toBe(true)

    expect(manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    await expect(approval).resolves.toEqual({ behavior: 'allow' })
    // A second tool use arrives after the switch: granted without a card.
    const next = handles[0]!.options.canUseTool!(
      'Write',
      { file_path: '/tmp/x', content: 'x' },
      { signal: controller.signal, toolUseID: 'toolu_2', requestId: 'sdk-req-2' }
    )
    await expect(next).resolves.toEqual({ behavior: 'allow' })
    const policyResolutions = events
      .map((entry) => entry.event)
      .filter(
        (event): event is Extract<ChatEvent, { type: 'request_resolved' }> =>
          event.type === 'request_resolved'
      )
      .filter((event) => event.decidedBy === 'policy')
    expect(policyResolutions).toHaveLength(2)
    expect(manager.getSnapshot(id)?.pendingRequests).toEqual([])
    manager.kill(id)
  })
  test('a live session adopts generated titles while unclaimed and never after a manual rename', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect(created.session.nameSource).toBe('placeholder')
    const transcript = writeTranscript(
      'title-session',
      JSON.stringify({ type: 'ai-title', aiTitle: 'first title', sessionId: 'title-session' }) + '\n'
    )
    await harness.manager.send(id, 'hello')
    // The init message carries the SDK session id; the title tail starts with
    // it and adopts the transcript's current title.
    harness.handles[0]!.push(initMessage('title-session'))
    await waitForCondition(
      () => db.getChatSession(id)?.name === 'first title'
    )
    expect(harness.registry.get(id)?.nameSource).toBe('auto')
    // A later title replaces an auto name (design D2).
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: 'ai-title', aiTitle: 'better title', sessionId: 'title-session' }) + '\n'
    )
    await waitForCondition(
      () => db.getChatSession(id)?.name === 'better title'
    )
    expect(db.getChatSession(id)?.nameSource).toBe('auto')
    // A user rename pins the name: later titles never touch it (design D1).
    expect(harness.manager.rename(id, 'my own name').ok).toBe(true)
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: 'ai-title', aiTitle: 'too late', sessionId: 'title-session' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(id)?.name).toBe('my own name')
    expect(db.getChatSession(id)?.nameSource).toBe('manual')
    expect(harness.registry.get(id)?.name).toBe('my own name')
    harness.manager.shutdown()
  })

  test('no title tail outlives kill, archive, or shutdown', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // Kill: the session is gone, so nothing adopts the appended title.
    const killHarness = await createHarness(db)
    const killCreated = killHarness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!killCreated.ok) throw new Error(killCreated.error)
    const killId = killCreated.session.id
    writeTranscript(
      'title-kill',
      JSON.stringify({ type: 'ai-title', aiTitle: 'kill title', sessionId: 'title-kill' }) + '\n'
    )
    await killHarness.manager.send(killId, 'hello')
    killHarness.handles[0]!.push(initMessage('title-kill'))
    await waitForCondition(
      () => db.getChatSession(killId)?.name === 'kill title'
    )
    killHarness.manager.kill(killId)
    fs.appendFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-kill.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'post-kill', sessionId: 'title-kill' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(killId)).toBeNull()
    killHarness.manager.shutdown()

    // Archive: the record stays, the tail does not follow later writes.
    const archiveHarness = await createHarness(db)
    const archiveCreated = archiveHarness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!archiveCreated.ok) throw new Error(archiveCreated.error)
    const archiveId = archiveCreated.session.id
    writeTranscript(
      'title-archive',
      JSON.stringify({ type: 'ai-title', aiTitle: 'archive title', sessionId: 'title-archive' }) + '\n'
    )
    await archiveHarness.manager.send(archiveId, 'hello')
    archiveHarness.handles[0]!.push(initMessage('title-archive'))
    await waitForCondition(
      () => db.getChatSession(archiveId)?.name === 'archive title'
    )
    expect(archiveHarness.manager.archive(archiveId).ok).toBe(true)
    fs.appendFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-archive.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'post-archive', sessionId: 'title-archive' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(archiveId)?.name).toBe('archive title')
    archiveHarness.manager.shutdown()

    // Shutdown: every tail ends with the server.
    const shutdownHarness = await createHarness(db)
    const shutdownCreated = shutdownHarness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!shutdownCreated.ok) throw new Error(shutdownCreated.error)
    const shutdownId = shutdownCreated.session.id
    writeTranscript(
      'title-shutdown',
      JSON.stringify({ type: 'ai-title', aiTitle: 'shutdown title', sessionId: 'title-shutdown' }) + '\n'
    )
    await shutdownHarness.manager.send(shutdownId, 'hello')
    shutdownHarness.handles[0]!.push(initMessage('title-shutdown'))
    await waitForCondition(
      () => db.getChatSession(shutdownId)?.name === 'shutdown title'
    )
    shutdownHarness.manager.shutdown()
    fs.appendFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-shutdown.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'post-shutdown', sessionId: 'title-shutdown' }) + '\n'
    )
    await flush(10)
    expect(db.getChatSession(shutdownId)?.name).toBe('shutdown title')
  })

  test('a transcript that appears long after the SDK id still arms the title tail', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // The agent starts on attach with no prompt, so the SDK id arrives before
    // any transcript exists — and a later send reuses the driver without
    // re-arming. The locator must therefore outlive its early retries. The
    // wait has to pass the old three-retry budget (2s+4s+2s = 6s) to prove
    // the tail survives it; the locate interval is shrunk so the new code
    // picks the file up promptly instead of backing off to 15s.
    const harness = await createHarness(db, anyDirectory, undefined, 20)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'hello')
    // SDK id known, transcript not yet written: the placeholder stands.
    harness.handles[0]!.push(initMessage('title-late'))
    await flush(10)
    expect(db.getChatSession(id)?.nameSource).toBe('placeholder')
    await new Promise((resolve) => setTimeout(resolve, 6_500))
    // The first message finally persists a transcript carrying a title.
    writeTranscript(
      'title-late',
      JSON.stringify({ type: 'ai-title', aiTitle: 'late title', sessionId: 'title-late' }) + '\n'
    )
    await waitForCondition(() => db.getChatSession(id)?.name === 'late title')
    expect(db.getChatSession(id)?.nameSource).toBe('auto')
    harness.manager.shutdown()
  }, 15_000)

  test('a restored session adopts its transcript title as a catch-up, dormant ones only on attach', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // A pre-feature session (migrated to placeholder) whose conversation
    // already carries a generated title: restorePersisted adopts it without
    // anyone opening the chat.
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'chat-preexisting',
      name: 'sure-mark',
      projectPath: '/tmp/proj',
      sdkSessionId: 'title-restore',
      status: 'waiting',
      createdAt: now,
      lastActivityAt: now,
      nameSource: 'placeholder',
    })
    writeTranscript(
      'title-restore',
      JSON.stringify({ type: 'ai-title', aiTitle: 'restored title', sessionId: 'title-restore' }) + '\n'
    )
    const restored = await createHarness(db)
    expect(restored.registry.get('chat-preexisting')?.name).toBe('restored title')
    expect(restored.registry.get('chat-preexisting')?.nameSource).toBe('auto')
    restored.manager.shutdown()

    // A dormant session whose transcript gains a title later adopts nothing
    // (no tail until it goes live)...
    const later = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'chat-dormant',
      name: 'pure-bell',
      projectPath: '/tmp/proj',
      sdkSessionId: 'title-dormant',
      status: 'waiting',
      createdAt: later,
      lastActivityAt: later,
      nameSource: 'placeholder',
    })
    writeTranscript('title-dormant', '')
    const dormant = await createHarness(db)
    expect(dormant.registry.get('chat-dormant')?.name).toBe('pure-bell')
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-dormant.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'attached later', sessionId: 'title-dormant' }) + '\n'
    )
    await flush(10)
    expect(dormant.registry.get('chat-dormant')?.name).toBe('pure-bell')
    // ...and adopts on the first attach (the spawn arms the tail, whose
    // catch-up read picks the title up).
    expect((await dormant.manager.start('chat-dormant')).ok).toBe(true)
    await waitForCondition(
      () => db.getChatSession('chat-dormant')?.name === 'attached later'
    )
    expect(dormant.registry.get('chat-dormant')?.nameSource).toBe('auto')
    dormant.manager.shutdown()
  })

  test('outbound audit rows land over the real store, id minted, outcome joined (CC round 3)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    expect((await manager.send(created.session.id, 'go')).ok).toBe(true)
    handles[0]!.push(initMessage('sdk-audit'))
    await flush()
    // Fire the driver's registered audit hooks as the SDK process would.
    const pre = handles[0]!.options.hooks?.PreToolUse?.[0]?.hooks[0]
    const post = handles[0]!.options.hooks?.PostToolUse?.[0]?.hooks[0]
    if (!pre || !post) throw new Error('audit hooks not registered')
    const hookInput = {
      tool_name: 'Bash',
      tool_input: { command: 'curl -d x https://example.internal/hook' },
      tool_use_id: 'tu-audit-1',
    }
    await pre({ ...hookInput, hook_event_name: 'PreToolUse' } as never, undefined, { signal: new AbortController().signal })
    await post({ ...hookInput, tool_response: 'ok', duration_ms: 9, hook_event_name: 'PostToolUse' } as never, undefined, { signal: new AbortController().signal })
    // The deferred writes (setImmediate) run before the next timer tick.
    await flush()
    const store = new OutboundStore(db.db)
    // /tmp/proj is no repository, so the row carries its plain-directory team.
    const page = store.page({ teamId: '/tmp/proj' })
    expect(page.rows).toHaveLength(1)
    const row = page.rows[0]!
    expect(row).toMatchObject({
      sessionId: created.session.id,
      tool: 'Bash',
      toolUseId: 'tu-audit-1',
      command: 'curl -d x https://example.internal/hook',
      rule: 'http-send',
      verdict: 'violation',
      destination: 'host:example.internal',
      classifierVersion: 3,
      cwd: '/tmp/proj',
    })
    // No injected id generator: the row id is minted, not 'obc-undefined'.
    expect(row.id).toMatch(/^obc-[0-9a-f-]{36}$/)
    const outcomes = store.outcomesOf(created.session.id, 'tu-audit-1')
    expect(outcomes).toEqual([{ outcome: 'completed', detail: null }])
    manager.shutdown()
  })
})

/**
 * Last-known identity (team-message-threads D3): creation and every rename
 * path keep `team_session_directory` current, and kill or archive never write
 * there — the row is what still names a participant after the session is gone.
 */
describe('ChatSessionManager team session directory', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatdir-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
  })

  /** The durable row, including the write timestamp a no-op must not move. */
  function directoryRow(sessionId: string) {
    return db.db.prepare(
      'SELECT name, group_id, updated_at FROM team_session_directory WHERE session_id = ?'
    ).get(sessionId) as { name: string; group_id: string | null; updated_at: string } | null
  }

  test('create records the session name and group once its team is known', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Export button', groupId: 'devs' })
    if (!created.ok) throw new Error(created.error)
    await waitForCondition(() => directoryRow(created.session.id) !== null)
    expect(directoryRow(created.session.id)).toMatchObject({
      name: 'Export button', group_id: 'devs',
    })
    manager.shutdown()
  })

  test('a generated title rename re-records the name', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    expect(directoryRow(id)!.name).toBe(created.session.name)

    writeTranscript(
      'dir-title',
      JSON.stringify({ type: 'ai-title', aiTitle: 'adopted title', sessionId: 'dir-title' }) + '\n'
    )
    await harness.manager.send(id, 'hello')
    harness.handles[0]!.push(initMessage('dir-title'))
    await waitForCondition(() => directoryRow(id)?.name === 'adopted title')
    expect(directoryRow(id)!.group_id).toBeNull()
    harness.manager.shutdown()
  })

  test('a manual rename re-records the name and pins it against later titles', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj', name: 'Placeholder' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)

    expect(harness.manager.rename(id, 'My own name').ok).toBe(true)
    expect(directoryRow(id)!.name).toBe('My own name')

    writeTranscript(
      'dir-manual',
      JSON.stringify({ type: 'ai-title', aiTitle: 'too late', sessionId: 'dir-manual' }) + '\n'
    )
    await harness.manager.send(id, 'hello')
    harness.handles[0]!.push(initMessage('dir-manual'))
    await flush(10)
    expect(directoryRow(id)!.name).toBe('My own name')
    harness.manager.shutdown()
  })

  test('repeated renames overwrite the recorded entry rather than adding rows', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'First' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    for (const name of ['Second', 'Third']) {
      expect(manager.rename(id, name).ok).toBe(true)
    }
    expect(directoryRow(id)!.name).toBe('Third')
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_session_directory').get()).toEqual({ n: 1 })
    manager.shutdown()
  })

  test('kill leaves the last known identity in place and writes nothing new', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Doomed helper', groupId: 'devs' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    expect(manager.rename(id, 'Renamed helper').ok).toBe(true)
    const before = directoryRow(id)!
    expect(before.name).toBe('Renamed helper')

    expect(manager.kill(id)).toBe(true)
    await flush(6)
    expect(directoryRow(id)).toEqual(before)
    manager.shutdown()
  })

  test('archive leaves the last known identity in place and writes nothing new', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Parked work', groupId: 'qa' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    const before = directoryRow(id)!

    expect(manager.archive(id).ok).toBe(true)
    await flush(6)
    expect(directoryRow(id)).toEqual(before)
    manager.shutdown()
  })
})

describe('ChatSessionManager activity', () => {
  let tempDir: string
  let db: SessionDatabase
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-activity-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('snapshot mid-phase reports the phase and a growing elapsed time', async () => {
    const { manager, handles, activities } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'hello')
    handles[0]!.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      parent_tool_use_id: null,
      uuid: 'p-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(activities.map((entry) => entry.activity?.phase)).toEqual([
      'requesting',
      'thinking',
    ])

    await new Promise((resolve) => setTimeout(resolve, 25))
    const snapshot = manager.getSnapshot(id)!
    expect(snapshot.activity).toMatchObject({ phase: 'thinking' })
    expect(snapshot.activity!.elapsedMs).toBeGreaterThanOrEqual(20)

    // A later snapshot of the same phase keeps counting, not restarting.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(manager.getSnapshot(id)!.activity!.elapsedMs).toBeGreaterThanOrEqual(40)

    // Turn end clears it: the driver's null reaches the sink and the snapshot.
    handles[0]!.push({
      type: 'result',
      subtype: 'success',
      result: '',
      num_turns: 1,
      total_cost_usd: 0,
    } as unknown as SDKMessage)
    await flush()
    expect(activities.at(-1)).toEqual({ sessionId: id, activity: null })
    expect(manager.getSnapshot(id)!.activity).toBeNull()
    manager.kill(id)
  })

  test('idle, archived, and dead sessions report no activity', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id

    // Idle: never sent a turn.
    expect(manager.getSnapshot(id)!.activity).toBeNull()

    // Archived mid-phase: the row must not survive the archive.
    await manager.send(id, 'hello')
    handles[0]!.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} },
      },
      parent_tool_use_id: null,
      uuid: 'p-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.getSnapshot(id)!.activity).toMatchObject({
      phase: 'preparing_tool',
    })
    manager.archive(id)
    expect(manager.getSnapshot(id)!.activity).toBeNull()

    // Restored and restarted: the new turn reports until the driver dies.
    manager.restore(id)
    const resent = await manager.send(id, 'again')
    expect(resent.ok).toBe(true)
    expect(handles).toHaveLength(2)
    handles[1]!.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      parent_tool_use_id: null,
      uuid: 'p-2',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.getSnapshot(id)!.activity).toMatchObject({ phase: 'thinking' })

    // A crashed driver clears the activity with its turn.
    handles[1]!.query.close()
    await flush()
    expect(manager.getSnapshot(id)!.activity).toBeNull()
    manager.kill(id)
  })
})

describe('ChatSessionManager usage', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-usage-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })
  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function rateLimitEvent(fields: Record<string, unknown>): SDKMessage {
    return {
      type: 'rate_limit_event',
      rate_limit_info: fields,
      uuid: 'rl-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage
  }

  const PROBE_EVENT = rateLimitEvent({
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.2237, resetsAt: Date.parse('2026-10-07T18:11:04.000Z') / 1000 },
      seven_day: { utilization: 0.1712, resetsAt: Date.parse('2026-10-12T09:00:00.000Z') / 1000 },
    },
  })

  const FULL_PULL = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 22.37, resets_at: '2026-10-07T18:11:04.000Z' },
      seven_day: { utilization: 17.12, resets_at: '2026-10-12T09:00:00.000Z' },
    },
  }

  test('pushed reports are stored per provider, shared by its sessions, and snapshotted', async () => {
    const { manager, handles, usage } = await createHarness(db)
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    // Neither report nor verdict: the snapshot carries no usage.
    expect(manager.getSnapshot(first.session.id)!.usage).toBeNull()

    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    // The fake query has no usage control, so the spawn records the
    // no-data verdict first (broadcast as null).
    handles[0]!.push(PROBE_EVENT)
    await flush()

    expect(usage).toHaveLength(2)
    expect(usage[0]).toEqual({ providerId: 'claude', report: null })
    expect(usage[1]).toMatchObject({ providerId: 'claude' })
    expect(usage[1].report?.windows.map((window) => window.key)).toEqual([
      'five_hour',
      'seven_day',
    ])
    // The second session of the same profile sees the same report.
    expect(manager.getSnapshot(first.session.id)!.usage).toBe(usage[1].report)
    expect(manager.getSnapshot(second.session.id)!.usage).toBe(usage[1].report)
    expect(manager.profileIdOf(first.session.id)).toBe('default')

    // A later, windowless push keeps the windows and updates the status.
    handles[0]!.push(rateLimitEvent({ status: 'rejected' }))
    await flush()
    const held = manager.getSnapshot(first.session.id)!.usage!
    expect(held.status).toBe('limited')
    expect(held.windows.map((window) => window.key)).toEqual([
      'five_hour',
      'seven_day',
    ])
  })

  test('parked work pauses its session (with reason and resume time) until it is unparked', async () => {
    const { manager, registry } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    const store = manager.mailbox.store
    const mail = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'work' })
    store.claim(mail.id, id); store.markPushed(mail.id); store.markDelivered(mail.id)
    const resume = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'resume', deliverAt: '2099-01-01T00:00:00.000Z' })
    store.park(mail.id, '2099-01-01T00:00:00.000Z', resume.id)
    expect(registry.get(id)?.parked).toEqual({ messageId: mail.id, until: '2099-01-01T00:00:00.000Z', profileId: 'glm', reason: 'Provider limit on glm' })
    store.unpark(mail.id)
    expect(registry.get(id)?.parked).toBeNull()
  })

  test('cancelling a holder\'s only parked message clears its paused state, and an archived holder stays archived', async () => {
    const { manager, registry } = await createHarness(db)
    const parkWork = (id: string) => {
      const store = manager.mailbox.store
      const mail = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'work' })
      store.claim(mail.id, id); store.markPushed(mail.id); store.markDelivered(mail.id)
      const resume = store.enqueue({ teamId: 't', toKind: 'session', toId: id, fromSession: id, fromGroup: null, originPath: '/tmp/proj', body: 'resume', deliverAt: '2099-01-01T00:00:00.000Z' })
      store.park(mail.id, '2099-01-01T00:00:00.000Z', resume.id)
      return { mail, resume }
    }
    const live = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    const archived = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!live.ok || !archived.ok) throw new Error('create failed')
    const liveWork = parkWork(live.session.id)
    const archivedWork = parkWork(archived.session.id)
    expect(manager.archive(archived.session.id).ok).toBe(true)
    expect(registry.get(live.session.id)?.parked).not.toBeNull()

    const store = manager.mailbox.store
    expect(store.cancel(liveWork.mail.id, { kind: 'human' })).toBe(true)
    expect(store.cancel(archivedWork.mail.id, { kind: 'human' })).toBe(true)
    expect(registry.get(live.session.id)?.parked).toBeNull()
    expect(registry.get(archived.session.id)?.parked).toBeNull()
    expect(registry.get(archived.session.id)?.archivedAt).toBeTruthy()
    expect(db.getChatSession(archived.session.id)?.archivedAt).toBeTruthy()
    expect(store.get(archivedWork.resume.id)?.state).toBe('cancelled')
    // Nothing pends for the live holder either, so group mail may reach it again.
    expect(store.parkedBy(live.session.id)).toEqual([])
  })

  test('limit failures are recorded against the session profile and group', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    handles[0]!.push({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 100,
      error_status: 429, error: 'rate_limit', uuid: 'r-uuid', session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.limitEvents.forProfile('glm')).toMatchObject([
      { profileId: 'glm', sessionId: created.session.id, groupId: null, kind: 'rate_limit', final: false, status: 429 },
    ])
    expect(manager.limitEvents.forProfile('default')).toEqual([])
  })

  test('the final event records the provider and the rejected report window', async () => {
    fs.mkdirSync(path.join(tempDir, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, '.kawai', 'providers.json'), JSON.stringify({
      zai: {
        label: 'Z.AI',
        models: { glm: { label: 'GLM', model: 'opus' }, 'glm-flash': { label: 'GLM Flash', model: 'sonnet' } },
      },
    }))
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    const reset = Math.floor(Date.now() / 1000) + 2400
    handles[0]!.push({
      type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day_opus' },
    } as unknown as SDKMessage)
    handles[0]!.push({
      type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, session_id: 'sdk-1', uuid: 'a-uuid',
      message: { id: 'msg_err2', role: 'assistant', content: [{ type: 'text', text: 'API Error: 429 quota' }] },
    } as unknown as SDKMessage)
    await flush()
    expect(manager.limitEvents.forProfile('glm')).toEqual([{
      id: expect.any(String), profileId: 'glm', sessionId: created.session.id, groupId: null, at: expect.any(String),
      kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 quota',
      resetsAt: new Date(reset * 1000).toISOString(), providerId: 'zai', window: 'seven_day_opus',
    }])
    manager.shutdown()
  })

  test("a zone-less reset in the error text is read in the profile's limitResetTimeZone", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    const project = path.join(tempDir, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'glm-cn': { label: 'GLM CN', limitResetTimeZone: 'Asia/Shanghai' },
    }))
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: project, claudeProfileId: 'glm-cn' })
    if (!created.ok) throw new Error(created.error)
    await manager.send(created.session.id, 'hello')
    handles[0]!.push({
      type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, session_id: 'sdk-1', uuid: 'a-uuid',
      message: { id: 'msg_err', role: 'assistant', content: [{ type: 'text', text: 'API Error: [1308][Your limit will reset at 2026-10-13 17:17:00]' }] },
    } as unknown as SDKMessage)
    await flush()
    expect(manager.limitEvents.forProfile('glm-cn')).toMatchObject([
      { final: true, resetsAt: '2026-10-13T09:17:00.000Z' },
    ])
    manager.shutdown()
  })

  test('an assistant usage_report is stored for the session profile provider', async () => {
    // glm maps to zai in a pinned catalog: the report is held per provider,
    // whatever host catalog the suite would otherwise read.
    const catalog = path.join(tempDir, 'catalog-glm')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(catalog, '.kawai', 'providers.json'), JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {} } } }))
    fs.writeFileSync(path.join(catalog, '.kawai', 'profiles.json'), JSON.stringify({ glm: { label: 'GLM' } }))
    const { manager, handles, usage } = await createHarness(db, anyDirectory, undefined, undefined, undefined, undefined, undefined, catalog)
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    handles[0]!.push({
      type: 'assistant',
      message: {
        id: 'msg_usage',
        content: [{ type: 'text', text: 'Usage report' }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'u-uuid',
      session_id: 'sdk-1',
      usage_report: {
        rate_limits: {
          limits: [
            { kind: 'session', percent: 22.4, resets_at: null, severity: 'normal' },
          ],
        },
      },
    } as unknown as SDKMessage)
    await flush()
    expect(usage).toHaveLength(2)
    expect(usage[0]).toEqual({ providerId: 'zai', report: null }) // spawn verdict
    expect(usage[1]).toMatchObject({ providerId: 'zai' })
    expect(usage[1].report?.windows).toHaveLength(1)
    expect(manager.getSnapshot(created.session.id)!.usage).toBe(usage[1].report)
  })

  test('the pull fallback fills usage before any push and only once per provider', async () => {
    const { manager, handles, usage } = await createHarness(
      db,
      anyDirectory,
      async (opts) => ({ ...FULL_PULL, opts })
    )
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    await flush()
    expect(handles[0]!.usageCalls).toEqual([{ skipBehaviors: true }])
    expect(usage).toHaveLength(1)
    expect(usage[0].report?.windows).toHaveLength(2)
    expect(manager.getSnapshot(first.session.id)!.usage).toBe(usage[0].report)

    // A second session of the same profile spawns later: no second pull.
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(second.session.id, 'hi')
    await flush()
    const calls = handles.flatMap((handle) => handle.usageCalls)
    expect(calls).toHaveLength(1)
  })

  test('a no-data pull suppresses later pulls until a push replaces the verdict', async () => {
    const { manager, handles, usage } = await createHarness(
      db,
      anyDirectory,
      async () => ({ rate_limits_available: false, rate_limits: null })
    )
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error('create failed')
    await manager.send(first.session.id, 'hello')
    await flush()
    // The verdict broadcasts as null and keeps the snapshot empty.
    expect(usage).toEqual([{ providerId: 'claude', report: null }])
    expect(manager.getSnapshot(first.session.id)!.usage).toBeNull()

    // Another session of the profile spawns: the verdict skips the pull.
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!second.ok) throw new Error('create failed')
    await manager.send(second.session.id, 'again')
    await flush()
    expect(handles.flatMap((handle) => handle.usageCalls)).toHaveLength(1)

    // A pushed report replaces the verdict and reaches the snapshot.
    handles[1]!.push(PROBE_EVENT)
    await flush()
    const held = manager.getSnapshot(second.session.id)!.usage!
    expect(held.windows.map((window) => window.key)).toEqual([
      'five_hour',
      'seven_day',
    ])
    expect(usage.at(-1)!.report).toBe(held)
  })

  test('usage does not survive a manager restart (memory only)', async () => {
    const dbPath = path.join(tempDir, 'usage-restart.db')
    const dbA = initDatabase({ path: dbPath })
    const harnessA = await createHarness(dbA, anyDirectory, async () => FULL_PULL)
    const created = harnessA.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await harnessA.manager.send(created.session.id, 'hello')
    await flush()
    expect(harnessA.manager.getSnapshot(created.session.id)!.usage).not.toBeNull()
    harnessA.manager.shutdown()
    closeDispatchers()
    dbA.close()

    const dbB = initDatabase({ path: dbPath })
    const harnessB = await createHarness(dbB, anyDirectory, async () => FULL_PULL)
    expect(harnessB.manager.getSnapshot(created.session.id)!.usage).toBeNull()
    // ...and the fresh store pulls again on the next spawn.
    await harnessB.manager.send(created.session.id, 'resume')
    await flush()
    expect(harnessB.handles[0]!.usageCalls).toHaveLength(1)
    harnessB.manager.shutdown()
    closeDispatchers()
    dbB.close()
  })
})

describe('ChatSessionManager context usage', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalHome = process.env.HOME
  const originalAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-context-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    // Pinned like the main describe: a real ~/.kawai must not leak into
    // launch resolution — and neither may an operator-level auto-compact
    // window (an agent dev shell carries one), or the profile-window
    // fallback would outrank the report thresholds these tests assert.
    process.env.HOME = tempDir
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalAutoCompact !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalAutoCompact
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('the snapshot prefers the fresher in-memory reading over the stored column', async () => {
    const seed = await createHarness(db)
    const created = seed.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    // A reading persisted at an earlier boundary, before a restart.
    const stale = { usedTokens: 90_000, thresholdTokens: 200_000, percentage: 45, at: '2026-10-10T10:00:00.000Z' }
    db.updateChatSession(id, { contextUsage: stale })

    const harness = await createHarness(db)
    expect(harness.manager.getSnapshot(id)!.contextUsage).toEqual(stale)

    await harness.manager.send(id, 'turn')
    harness.handles[0]!.push(assistantUsage(120_000, 'msg_1'))
    harness.handles[0]!.push(resultWithWindow())
    await flush()
    expect(harness.manager.getSnapshot(id)!.contextUsage).toMatchObject({ usedTokens: 120_000 })

    // Mid-turn of the next turn: in-memory is fresher than the column, and
    // the snapshot prefers it (design D5).
    await harness.manager.send(id, 'second turn')
    harness.handles[0]!.push(assistantUsage(130_000, 'msg_2'))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 120_000 })
    expect(harness.manager.getSnapshot(id)!.contextUsage).toMatchObject({ usedTokens: 130_000 })
    harness.manager.shutdown()
  })

  test('a multi-request turn writes the reading at its boundary, not per frame', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'long turn')
    const fake = harness.handles[0]!

    // Three requests mid-turn: none reaches the database (no boundary yet).
    fake.push(assistantUsage(40_000, 'msg_1'))
    fake.push(assistantUsage(60_000, 'msg_2'))
    fake.push(assistantUsage(80_000, 'msg_3'))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toBeNull()

    // The result reveals the window and ends the turn: exactly one write
    // lands, carrying the last reading.
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000, thresholdTokens: 200_000 })

    // A second turn publishes live frames (the threshold is known now)...
    await harness.manager.send(id, 'second turn')
    fake.push(assistantUsage(85_000, 'msg_4'))
    fake.push(assistantUsage(95_000, 'msg_5'))
    await flush()
    expect(harness.contextUsage.length).toBeGreaterThanOrEqual(3)
    // ...but the stored value stays at the last boundary until the next one.
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 95_000 })
    harness.manager.shutdown()
  })

  test('compaction and driver death write the reading too', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(80_000, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })

    // Compaction is a write point: the adopted size lands immediately.
    fake.push(compactBoundary(12_000))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 12_000 })

    // A later frame publishes live without touching the column; driver
    // death is the final write point, so the last live value survives.
    fake.push(assistantUsage(30_000, 'msg_2'))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 12_000 })
    fake.query.close()
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 30_000 })
    harness.manager.shutdown()
  })

  test('a late threshold correction persists without waiting for another boundary', async () => {
    // The turn-boundary probe resolves after turn_completed has already
    // written the reading; the correction itself must reach the database, or
    // an abrupt restart would restore a different percentage than the one
    // last displayed.
    let threshold = 200_000
    let probes = 0
    let finishBoundaryProbe: (() => void) | undefined
    const report = () => ({
      categories: [], totalTokens: 0, maxTokens: 200_000, rawMaxTokens: 200_000,
      percentage: 0, gridRows: [], model: 'claude-sonnet-4-5', memoryFiles: [],
      mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
      autoCompactThreshold: threshold,
    })
    const harness = await createHarness(db, anyDirectory, undefined, undefined, () => {
      probes += 1
      // Attach answers at once; the boundary probe resolves late.
      if (probes === 1) return Promise.resolve(report())
      return new Promise((resolve) => {
        finishBoundaryProbe = () => resolve(report())
      })
    })
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(157_900, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 157_900, thresholdTokens: 200_000 })

    threshold = 100_000
    expect(finishBoundaryProbe).toBeDefined()
    finishBoundaryProbe!()
    await waitForCondition(() => db.getChatSession(id)?.contextUsage?.thresholdTokens === 100_000)
    // No further turn or event: the correction wrote the re-scaled reading.
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 157_900, thresholdTokens: 100_000, percentage: 157.9 })
    harness.manager.shutdown()
  })

  test('a conversation reset clears the reading and persists the clear', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(80_000, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })

    fake.push({
      type: 'conversation_reset',
      trigger: 'plan_mode_exit',
      new_conversation_id: 'fresh',
      uuid: 'reset-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    // The stored column goes too: a restart must not resurrect the old
    // conversation's occupancy.
    expect(db.getChatSession(id)!.contextUsage).toBeNull()
    expect(harness.manager.getSnapshot(id)!.contextUsage).toBeNull()
    expect(harness.contextUsage.at(-1)?.usage).toBeNull()
    harness.manager.shutdown()
  })

  test('compaction persists on the notice kind, not its display text', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(80_000, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })

    // The driver tags the compact_boundary notice with kind: 'compacted';
    // that tag — not the string 'Context compacted' — is what makes this
    // write happen. The published reading is dropped to post_tokens first.
    fake.push(compactBoundary(12_000))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 12_000 })
    const notice = harness.events
      .map((entry) => entry.event)
      .find((event) => event.type === 'notice')
    expect(notice).toMatchObject({ type: 'notice', kind: 'compacted' })
    harness.manager.shutdown()
  })
})

describe('ChatSessionManager model', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalHome = process.env.HOME
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-model-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('a reported model persists immediately, snapshots, and pushes once', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    // Before the first report the snapshot carries an explicit null.
    expect(harness.manager.getSnapshot(id)!.model).toBeNull()

    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(initMessage('sdk-model-1', 'claude-sonnet-5-5'))
    await flush()
    // No turn boundary yet, but the write is immediate (design D5): model
    // changes are rare, so they never wait for one.
    expect(db.getChatSession(id)!.model).toBe('claude-sonnet-5-5')
    expect(harness.manager.getSnapshot(id)!.model).toBe('claude-sonnet-5-5')
    expect(harness.models).toEqual([{ sessionId: id, model: 'claude-sonnet-5-5' }])

    // An unchanged model on the next turn never re-fires the sink.
    fake.push(resultWithWindow())
    await flush()
    await harness.manager.send(id, 'second')
    fake.push(initMessage('sdk-model-1', 'claude-sonnet-5-5'))
    await flush()
    expect(harness.models).toHaveLength(1)
    harness.manager.shutdown()
  })

  test('the snapshot falls back to the stored column after a restart', async () => {
    const seed = await createHarness(db)
    const created = seed.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await seed.manager.send(id, 'turn')
    seed.handles[0]!.push(initMessage('sdk-model-1', 'claude-sonnet-5-5'))
    seed.handles[0]!.push(resultWithWindow())
    await flush()
    // The restarted manager resumes from the SDK transcript, which must exist.
    writeTranscript('sdk-model-1', '[]')
    seed.manager.shutdown()

    const harness = await createHarness(db)
    expect(harness.manager.getSnapshot(id)!.model).toBe('claude-sonnet-5-5')

    // A /model switch after the restart updates record, row, and snapshot.
    await harness.manager.send(id, 'switched')
    harness.handles[0]!.push(initMessage('sdk-model-1', 'sonnet'))
    await flush()
    expect(db.getChatSession(id)!.model).toBe('sonnet')
    expect(harness.manager.getSnapshot(id)!.model).toBe('sonnet')
    harness.manager.shutdown()
  })
})

describe('ChatSessionManager worker sidecar', () => {
  let tempDir: string
  let db: SessionDatabase
  let sidecarDir: string
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatworkers-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    sidecarDir = path.join(tempDir, 'chat-workers')
    // Same isolation contract as the main describe: auth pinned to a key,
    // CLI config and home inside the temp dir so nothing leaks in.
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** The Agent spawn + task_started prefix (design D1) on the fake stream. */
  async function spawnWorker(
    handle: FakeHandle,
    toolUseId: string,
    taskId: string,
    description: string
  ): Promise<void> {
    handle.push({
      type: 'assistant',
      message: {
        id: `msg_${toolUseId}`,
        content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: `uuid-${toolUseId}`,
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    handle.push({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      subagent_type: 'Explore',
      spawn_depth: 1,
      task_type: 'local_agent',
    } as unknown as SDKMessage)
    await flush()
  }

  /** task_notification settle frame for one worker. */
  async function settleWorker(
    handle: FakeHandle,
    toolUseId: string,
    taskId: string,
    status: 'completed' | 'failed',
    summary: string
  ): Promise<void> {
    handle.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: toolUseId,
      status,
      output_file: '/tmp/subagent.jsonl',
      summary,
    } as unknown as SDKMessage)
    await flush()
  }

  /** A fresh store over the same directory, as a restart would build. */
  const reopenedStore = () => new ChatWorkerStore({ dir: sidecarDir })

  test('settled workers round-trip through the sidecar and the snapshot', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-1'))
    await spawnWorker(handle, 'toolu_w1', 'task_1', 'Map the workspace')
    await spawnWorker(handle, 'toolu_w2', 'task_2', 'Index the API')
    await settleWorker(handle, 'toolu_w1', 'task_1', 'completed', 'Mapped 14 files')
    await settleWorker(handle, 'toolu_w2', 'task_2', 'failed', 'endpoint down')
    // The sink saw every roster publish (workers design D2): spawn, fill,
    // and settle for each worker.
    expect(harness.workers.map(entry => entry.workers)).toHaveLength(6)
    harness.manager.shutdown()

    // Restart: a fresh store over the same directory recovers the rows.
    const restored = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, reopenedStore()
    )
    expect(restored.manager.getSnapshot(id)!.workers.map(({ elapsedMs: _e, ...row }) => row))
      .toEqual([
        {
          workerId: 'toolu_w1',
          taskId: 'task_1',
          agentType: 'Explore',
          description: 'Map the workspace',
          depth: 1,
          status: 'completed',
          live: false,
          summary: 'Mapped 14 files',
        },
        {
          workerId: 'toolu_w2',
          taskId: 'task_2',
          agentType: 'Explore',
          description: 'Index the API',
          depth: 1,
          status: 'failed',
          live: false,
          summary: 'endpoint down',
        },
      ])
    restored.manager.shutdown()
  })

  test('a restarted session keeps recovered outcomes when its agent starts again', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-3'))
    await spawnWorker(handle, 'toolu_w1', 'task_1', 'Map the workspace')
    await settleWorker(handle, 'toolu_w1', 'task_1', 'completed', 'Mapped 14 files')
    harness.manager.shutdown()

    // Restart: the fresh driver is seeded with the recovered rows, so a new
    // spawn appends to the roster instead of replacing it — and the sidecar
    // keeps both, where a publish from an empty roster would lose the old
    // outcome on disk too. Resume needs the transcript to exist.
    writeTranscript('sdk-workers-3', `${JSON.stringify({ type: 'user', uuid: 'u1' })}\n`)
    const restored = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, reopenedStore()
    )
    const sent = await restored.manager.send(id, 'research again')
    if (!sent.ok) throw new Error(sent.error)
    await flush()
    const nextHandle = restored.handles[0]!
    nextHandle.push(initMessage('sdk-workers-3'))
    await spawnWorker(nextHandle, 'toolu_w2', 'task_2', 'Index the API')
    expect(
      restored.manager.getSnapshot(id)!.workers.map((worker) => worker.workerId)
    ).toEqual(['toolu_w1', 'toolu_w2'])
    await waitForCondition(() => {
      const rows = reopenedStore().read(id)
      return rows.some(worker => worker.workerId === 'toolu_w1') &&
        rows.some(worker => worker.workerId === 'toolu_w2')
    })
    restored.manager.shutdown()
  })

  test('a worker still running at an abrupt stop is kept and recovered as stopped', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-2'))
    await spawnWorker(handle, 'toolu_run', 'task_run', 'Map the workspace')
    // The sidecar holds the running row before anything settles (D6: the
    // write happens at spawn, not at settle — the crash gap).
    await waitForCondition(() =>
      store.read(id).some(worker => worker.status === 'running')
    )
    // A reconnect mid-run receives the running roster from the live driver
    // (workers design D2), elapsed computed fresh at snapshot time.
    expect(harness.manager.getSnapshot(id)!.workers).toMatchObject([
      { workerId: 'toolu_run', status: 'running', live: true },
    ])
    // Abrupt stop: no shutdown settlement, as a crash would leave things.
    const recovered: ChatWorker[] = []
    const restored = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      queryFactory: fakeQueryFactory([]),
      workerStore: reopenedStore(),
      onWorkers: (_sessionId, workers) => recovered.push(...workers),
    })
    const snapshot = restored.getSnapshot(id)!
    expect(snapshot.workers).toMatchObject([
      { workerId: 'toolu_run', status: 'stopped', live: false },
    ])
    // The corrected roster is rewritten so the file and the rows agree.
    await waitForCondition(() =>
      reopenedStore().read(id).every(worker => worker.status === 'stopped')
    )
    restored.shutdown()
    expect(recovered).toEqual([])
  })

  test('a worker roster change on a pending release re-runs the dispatch cycle (member-release D2/D3)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const harness = await createHarness(db, anyDirectory)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-release'))
    await spawnWorker(handle, 'toolu_rel', 'task_rel', 'Map the workspace')
    expect(harness.manager.hasLiveWorkers(id)).toBe(true)
    db.db.prepare(`INSERT INTO team_member_releases (session_id, task_id, team_id, reason, requested_by_kind, requested_at)
      VALUES (?, 'task-1', 'team-1', 'task done', 'human', ?)`).run(id, new Date().toISOString())
    let notified = 0
    harness.manager.dispatcher.notify = () => { notified += 1 }
    await settleWorker(handle, 'toolu_rel', 'task_rel', 'completed', 'Mapped')
    expect(harness.manager.hasLiveWorkers(id)).toBe(false)
    expect(notified).toBeGreaterThan(0)
    harness.manager.shutdown()
  })

  test('kill removes the sidecar with the session', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-3'))
    await spawnWorker(handle, 'toolu_kill', 'task_kill', 'Map the workspace')
    await waitForCondition(() => store.read(id).length === 1)
    harness.manager.kill(id)
    await waitForCondition(
      () => !fs.existsSync(path.join(sidecarDir, `${id}.json`))
    )
    expect(reopenedStore().read(id)).toEqual([])
  })
})

describe('ChatSessionManager notifications', () => {
  let tempDir: string
  let db: SessionDatabase
  const originals = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  }

  beforeEach(() => {
    jest.useRealTimers()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatnotify-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Same isolation as the main describe: the default profile's credentials
    // check reads a config dir this block owns, never the operator's login.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })

  afterEach(() => {
    jest.useRealTimers()
    for (const [name, value] of Object.entries(originals)) {
      if (value !== undefined) process.env[name] = value
      else delete process.env[name]
    }
    closeDispatchers()
    testManagers.clear()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Manager harness capturing notification pushes. */
  async function noticeHarness() {
    const handles: FakeHandle[] = []
    const pushes: Array<{ sessionId: string; notifications: ChatNotification[] }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      profileCatalogHome: tempDir,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onNotifications: (sessionId, notifications) =>
        pushes.push({ sessionId, notifications }),
      queryFactory: fakeQueryFactory(handles),
    })
    return { manager, handles, pushes }
  }

  /**
   * Drain the driver's stream delivery under fake timers: the spawn and
   * frame-delivery paths are microtasks, so rounds of awaited microtask
   * ticks suffice without advancing the clock.
   */
  async function drain(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }

  function writeCredentials(fields: Record<string, unknown>): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    fs.mkdirSync(configDir, { recursive: true })
    const filePath = path.join(configDir, '.credentials.json')
    fs.writeFileSync(filePath, JSON.stringify(fields))
    return filePath
  }

  /** Credentials with a refresh token expiring `daysFromNow` (access 1h older). */
  function expiringCredentials(daysFromNow: number): Record<string, unknown> {
    const at = Date.now() + daysFromNow * 24 * 60 * 60 * 1000
    return {
      claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: at - 3_600_000, refreshTokenExpiresAt: at },
    }
  }

  /** A system/notification frame off the fake stream. */
  function notifyFrame(overrides: Record<string, unknown> = {}): SDKMessage {
    return {
      type: 'system',
      subtype: 'notification',
      key: 'model-context-window',
      text: 'Context low',
      priority: 'high',
      color: 'warning',
      uuid: 'notification-uuid',
      session_id: 'sdk-1',
      ...overrides,
    } as unknown as SDKMessage
  }

  /** A started session with a live (fake) driver to push frames into. */
  async function startedSession(
    manager: InstanceType<typeof ChatSessionManager>,
    handles: FakeHandle[],
    text = 'hello'
  ): Promise<string> {
    // The auth gate needs a credentials file to exist; a field-less one
    // authenticates (existsSync) without producing an account notice.
    if (!fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'))) {
      writeCredentials({})
    }
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    await manager.send(created.session.id, text)
    await drain()
    return created.session.id
  }

  test('an agent notice replaces a same-key notice and never leaks across sessions', async () => {
    const { manager, handles, pushes } = await noticeHarness()
    const first = await startedSession(manager, handles)
    const second = await startedSession(manager, handles, 'second')
    handles[0]!.push(notifyFrame({ text: 'first copy' }))
    await drain()
    handles[0]!.push(notifyFrame({ text: 'second copy' }))
    await drain()
    // Same-key replacement: only the newer text is held.
    expect(manager.getSnapshot(first)!.notifications).toHaveLength(1)
    expect(manager.getSnapshot(first)!.notifications[0]).toMatchObject({
      key: 'model-context-window',
      source: 'agent',
      severity: 'warning',
      text: 'second copy',
    })
    // Session B shows nothing of session A's notices.
    expect(manager.getSnapshot(second)!.notifications).toEqual([])
    expect(pushes.every((push) => push.sessionId === first)).toBe(true)
  })

  test('a timed notice expires after its timeout; an untimed one persists', async () => {
    jest.useFakeTimers()
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ timeout_ms: 15_000 }))
    handles[0]!.push(notifyFrame({ key: 'error-compacting-conversation', text: 'Error compacting conversation', color: 'error', priority: 'immediate', timeout_ms: undefined }))
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(2)

    jest.advanceTimersByTime(14_999)
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(2)
    jest.advanceTimersByTime(1)
    await drain()
    // The timed notice is gone; the untimed one stays until closed.
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.key)).toEqual([
      'error-compacting-conversation',
    ])
    expect(pushes.at(-1)!.notifications).toEqual(manager.getSnapshot(id)!.notifications)
  })

  test('an expiring replacement is not removed by its predecessor timer', async () => {
    jest.useFakeTimers()
    const { manager, handles } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ timeout_ms: 5_000 }))
    await drain()
    jest.advanceTimersByTime(3_000)
    handles[0]!.push(notifyFrame({ timeout_ms: 30_000 }))
    await drain()
    jest.advanceTimersByTime(5_000)
    await drain()
    // The old 5s timer fired but the replacement (armed at +3s for 30s)
    // survives it; it only goes at +33s.
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.key)).toEqual([
      'model-context-window',
    ])
    jest.advanceTimersByTime(28_000)
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
  })

  test('archive clears agent notices but keeps the account notice', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame())
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(2)

    expect(manager.archive(id)).toEqual({ ok: true })
    // The archived chat shows the account notice only (design D4).
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.source)).toEqual(['account'])
    expect(pushes.at(-1)!.notifications).toEqual(manager.getSnapshot(id)!.notifications)
  })

  test('kill clears notices with the session and a restart begins clean', async () => {
    const { manager, handles } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame())
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(1)

    manager.kill(id)
    expect(manager.getSnapshot(id)).toBeNull()

    // A crashed driver's notices do not survive its respawn.
    const fresh = await startedSession(manager, handles, 'again')
    expect(manager.getSnapshot(fresh)!.notifications).toEqual([])
  })

  test('an unexpected exit clears untimed notices; the same session respawn starts clean', async () => {
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ timeout_ms: undefined }))
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toHaveLength(1)

    // The process exits on its own. The session keeps its dead driver, and
    // the next send respawns inside the same driver object — no new
    // construction, so only the process-end callback clears the notices
    // the crashed process emitted.
    handles[0]!.query.close()
    await drain()
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
    expect(pushes.at(-1)!.notifications).toEqual([])

    await manager.send(id, 'after the crash')
    await drain()
    expect(handles).toHaveLength(2)
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
  })

  test('the snapshot carries the account notice computed on attach', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager } = await noticeHarness()
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const snapshot = manager.getSnapshot(created.session.id)!
    expect(snapshot.notifications).toHaveLength(1)
    expect(snapshot.notifications[0]).toMatchObject({
      key: 'login-expiry',
      source: 'account',
      severity: 'warning',
      text: 'Your login expires in 2 days',
      hint: 'run /login in a Claude terminal to renew',
    })
  })

  test('a credentialed provider session shows no host-login expiry notice', async () => {
    writeCredentials(expiringCredentials(1.4))
    writeCredentialedProviderCatalog(tempDir)
    process.env.OR2_KEY = 'or-sentinel'
    try {
      const { manager } = await noticeHarness()
      const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'or2-opus' })
      if (!created.ok) throw new Error(created.error)
      expect(manager.getSnapshot(created.session.id)!.notifications).toEqual([])
      // A host-login session on the same server still sees it.
      const host = manager.createSession({ projectPath: '/tmp/proj' })
      if (!host.ok) throw new Error(host.error)
      expect(manager.getSnapshot(host.session.id)!.notifications.map((n) => n.key)).toEqual(['login-expiry'])
    } finally {
      delete process.env.OR2_KEY
    }
  })

  test('two sessions sharing a credentials path both update on a change', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager, pushes } = await noticeHarness()
    const first = manager.createSession({ projectPath: '/tmp/proj' })
    const second = manager.createSession({ projectPath: '/tmp/proj' })
    if (!first.ok) throw new Error(first.error)
    if (!second.ok) throw new Error(second.error)
    // Both attach: both map to the same (default) credentials path.
    manager.getSnapshot(first.session.id)
    manager.getSnapshot(second.session.id)
    expect(manager.getSnapshot(first.session.id)!.notifications).toHaveLength(1)
    expect(manager.getSnapshot(second.session.id)!.notifications).toHaveLength(1)

    // The user renews: the slow-timer recheck pushes the empty list to both.
    writeCredentials(expiringCredentials(30))
    manager.recheckAccountNotices([first.session.id, second.session.id])
    const cleared = pushes.filter((push) => push.notifications.length === 0)
    expect(cleared.map((push) => push.sessionId).sort()).toEqual(
      [first.session.id, second.session.id].sort()
    )
    expect(manager.getSnapshot(first.session.id)!.notifications).toEqual([])
  })

  test('a profile the catalog cannot resolve yields no account notice', async () => {
    // A persisted row survives a restart even when its profile entry is gone;
    // the refresh must map it to null instead of failing the snapshot.
    const ghost = {
      sessionId: 'chat-ghost',
      name: 'ghost',
      projectPath: '/tmp/proj',
      sdkSessionId: null,
      claudeProfileId: 'vanished',
      approvalPolicy: 'manual' as const,
      nameSource: 'manual' as const,
      groupId: null,
      status: 'waiting' as const,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    }
    db.insertChatSession(ghost)
    writeCredentials(expiringCredentials(1.4))
    const { manager } = await noticeHarness()
    const snapshot = manager.getSnapshot('chat-ghost')!
    expect(snapshot.notifications).toEqual([])
  })

  test('an unreadable or expired login yields no notice', async () => {
    const { manager } = await noticeHarness()
    writeCredentials({})
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    writeCredentials(expiringCredentials(-0.5))
    expect(manager.getSnapshot(created.session.id)!.notifications).toEqual([])
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{torn')
    expect(manager.getSnapshot(created.session.id)!.notifications).toEqual([])
  })

  test('dismissNotification removes the key and pushes the new list; unknown keys are a no-op', async () => {
    const { manager, handles, pushes } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame())
    await drain()
    expect(pushes).toHaveLength(1)

    expect(manager.dismissNotification(id, 'missing-key')).toEqual({ ok: true })
    expect(pushes).toHaveLength(1)

    expect(manager.dismissNotification(id, 'model-context-window')).toEqual({ ok: true })
    expect(manager.getSnapshot(id)!.notifications).toEqual([])
    expect(pushes).toHaveLength(2)
    expect(pushes[1]!.notifications).toEqual([])

    // Account keys never pass the server-side dismiss.
    writeCredentials(expiringCredentials(1.4))
    manager.getSnapshot(id)
    expect(manager.dismissNotification(id, 'login-expiry')).toEqual({ ok: true })
    expect(manager.getSnapshot(id)!.notifications.map((notice) => notice.source)).toEqual(['account'])

    expect(manager.dismissNotification('missing-session', 'k').ok).toBe(false)
  })

  test('snapshot ordering: priority first, then newest, account ahead on ties', async () => {
    writeCredentials(expiringCredentials(1.4))
    const { manager, handles } = await noticeHarness()
    const id = await startedSession(manager, handles)
    handles[0]!.push(notifyFrame({ key: 'low-note', text: 'meh', priority: 'low', color: undefined }))
    await drain()
    handles[0]!.push(notifyFrame({ key: 'urgent-note', text: 'now', priority: 'immediate', color: 'error' }))
    await drain()
    const keys = manager.getSnapshot(id)!.notifications.map((notice) => notice.key)
    // immediate agent, then the account notice (high), then the low agent.
    expect(keys).toEqual(['urgent-note', 'login-expiry', 'low-note'])
  })
})

describe('ChatSessionManager background-task roster (background tasks D2)', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatbgtasks-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  })

  test('a live session publishes its roster and snapshots the fresh projection', async () => {
    const { manager, handles, backgroundTasks } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run things')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'call_1',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    // The sink saw the full-set publish...
    expect(backgroundTasks.at(-1)?.tasks).toMatchObject([
      { taskId: 'b1', kind: 'shell', description: 'dev server', status: 'running', live: true },
    ])
    // ...and a reconnecting client's snapshot carries the same roster.
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b1', status: 'running', live: true },
    ])
    handle.push({
      type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'call_1',
      status: 'completed', summary: 'done (exit code 0)', uuid: 'u2', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(backgroundTasks.at(-1)?.tasks).toMatchObject([
      { taskId: 'b1', status: 'completed', live: false, summary: 'done (exit code 0)' },
    ])
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b1', status: 'completed' },
    ])
  })

  test('a settling task on a pending release re-runs the dispatch cycle (member-release D2/D3)', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run things')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b9', tool_use_id: 'call_9',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.hasRunningBackgroundTasks(id)).toBe(true)
    db.db.prepare(`INSERT INTO team_member_releases (session_id, task_id, team_id, reason, requested_by_kind, requested_at)
      VALUES (?, 'task-1', 'team-1', 'task done', 'human', ?)`).run(id, new Date().toISOString())
    let notified = 0
    manager.dispatcher.notify = () => { notified += 1 }
    handle.push({
      type: 'system', subtype: 'task_notification', task_id: 'b9', tool_use_id: 'call_9',
      status: 'completed', summary: 'done (exit code 0)', uuid: 'u2', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.hasRunningBackgroundTasks(id)).toBe(false)
    expect(notified).toBeGreaterThan(0)
    manager.shutdown()
  })

  test('a member spawned for an already-closed task is marked pending release by its creation (member-release D1)', async () => {
    const { manager } = await createHarness(db)
    const t = manager.tasks.store.create({ teamId: 'team-1', title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
    manager.tasks.store.setStatus(t.id, 'done')
    const created = manager.createSession({ projectPath: '/tmp/proj', spawned: true, taskId: t.id })
    if (!created.ok) throw new Error('create failed')
    // Same tick as the insert: no await sits between persisting the session and its mark.
    const row = db.db.prepare('SELECT task_id FROM team_member_releases WHERE session_id = ?').get(created.session.id)
    expect(row).toEqual({ task_id: t.id })
    manager.shutdown()
  })

  test('process end frees a pending member: the stopped roster re-checks readiness and the next pass archives it (member-release D3)', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', spawned: true })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'start a dev server')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b-end', tool_use_id: 'call_end',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    // The turn ends; the shell keeps running, so only D3's task condition holds the member.
    handle.push({ type: 'result', subtype: 'success', result: 'started', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    db.db.prepare(`INSERT INTO team_member_releases (session_id, task_id, team_id, reason, requested_by_kind, requested_at)
      VALUES (?, 'task-1', 'team-1', 'task done', 'human', ?)`).run(id, new Date().toISOString())
    manager.dispatcher.release()
    manager.dispatcher.notify()
    await manager.dispatcher.settled()
    expect(manager.isArchived(id)).toBe(false)
    // The process ends (EOF): the driver settles the shell as stopped and
    // publishes that roster; nothing else asks the dispatcher to look again.
    handle.query.close()
    await waitForCondition(() => manager.getSnapshot(id)!.backgroundTasks[0]?.status === 'stopped')
    await manager.dispatcher.settled()
    await waitForCondition(() => manager.isArchived(id))
    manager.shutdown()
  })

  test('a turn ending while a shell is live leaves the session waiting (D7)', async () => {
    const { manager, handles, registry } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'start a dev server')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b3', tool_use_id: 'call_3',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    handle.push({
      type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b3' }], uuid: 'u4', session_id: 's',
    } as unknown as SDKMessage)
    // The turn completes; the shell keeps running.
    handle.push({
      type: 'result', subtype: 'success', result: 'started', uuid: 'u5', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(registry.get(id)?.status).toBe('waiting')
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b3', status: 'running', live: true },
    ])
  })

  test('an archived session keeps its last roster, settled as stopped', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run things')
    handles[0]!.push({
      type: 'system', subtype: 'task_started', task_id: 'b2', task_type: 'local_bash',
      description: 'sleep', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    await manager.archive(id)
    // Archived read-only: archiving ended the process, so the running task
    // settles as stopped, and the last roster still answers the snapshot.
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b2', status: 'stopped', live: false },
    ])
  })

  test('a process crash persists stopped tasks through archive and restore', async () => {
    const store = new ChatTaskStore({ dir: path.join(tempDir, 'chat-tasks-crash') })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store,
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'start a background task')
    handles[0]!.push({
      type: 'system', subtype: 'task_started', task_id: 'b-crash', tool_use_id: 'c1',
      task_type: 'local_bash', is_backgrounded: true, uuid: 'u1', session_id: 's',
    } as unknown as SDKMessage)
    await waitForCondition(() => store.read(id).some(task => task.status === 'running'))

    // An unexpected EOF marks the driver dead before it publishes process_end.
    handles[0]!.query.close()
    await waitForCondition(() => manager.getSnapshot(id)!.backgroundTasks[0]?.status === 'stopped')
    const stopped = manager.getSnapshot(id)!.backgroundTasks[0]!
    expect(stopped.live).toBe(false)
    expect(stopped.endedAtMs).toBeDefined()
    await waitForCondition(() => store.read(id)[0]?.status === 'stopped')
    expect(store.read(id)[0]?.endedAtMs).toBe(stopped.endedAtMs)

    // Recreating the driver must seed the stopped records, not the old running ones.
    expect(manager.archive(id)).toEqual({ ok: true })
    expect(manager.restore(id)).toEqual({ ok: true })
    await manager.send(id, 'continue after the crash')
    expect(manager.getSnapshot(id)!.backgroundTasks).toEqual([stopped])
    manager.shutdown()
  })

  test('restart keeps a settled outcome and recovers a running task as stopped', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks')
    const store = () => new ChatTaskStore({ dir: taskDir })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store(),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run two tasks')
    const handle = handles[0]!
    // One task settles before the restart; the other is still running.
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-done', tool_use_id: 'c1', task_type: 'local_bash', description: 'quick', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_notification', task_id: 'b-done', tool_use_id: 'c1', status: 'completed', summary: 'done (exit code 0)', output_file: '/tmp/claude-1000/x/tasks/b-done.output', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-live', tool_use_id: 'c2', task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u3', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).length === 2)
    // Abrupt stop, as a crash would leave things.
    const restored = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory([]), taskStore: store(),
    })
    expect(restored.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b-done', status: 'completed', summary: 'done (exit code 0)', live: false },
      { taskId: 'b-live', status: 'stopped', live: false },
    ])
    // The corrected roster is rewritten so the file and the rows agree, and
    // the recorded output path survives for the tail reader (D3).
    await waitForCondition(() => store().read(id).every(task => task.status !== 'running'))
    expect(store().read(id)).toMatchObject([
      { taskId: 'b-done', outputFile: '/tmp/claude-1000/x/tasks/b-done.output' },
      { taskId: 'b-live', status: 'stopped' },
    ])
    restored.shutdown()
  })

  test('kill removes the task sidecar with the session', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks-kill')
    const store = () => new ChatTaskStore({ dir: taskDir })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store(),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run one task')
    handles[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'b-kill', task_type: 'local_bash', is_backgrounded: true, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).length === 1)
    manager.kill(id)
    await waitForCondition(() => !fs.existsSync(path.join(taskDir, `${id}.json`)))
    expect(store().read(id)).toEqual([])
  })

  test('a resume keeps recovered output paths through later roster writes', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks-resume')
    const store = () => new ChatTaskStore({ dir: taskDir })
    const first: FakeHandle[] = []
    const managerA = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(first), taskStore: store(),
    })
    const created = managerA.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await managerA.send(id, 'run a task')
    first[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'b-old', tool_use_id: 'c1', task_type: 'local_bash', description: 'old task', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    first[0]!.push({ type: 'system', subtype: 'task_notification', task_id: 'b-old', tool_use_id: 'c1', status: 'completed', summary: 'done before restart', output_file: '/tmp/claude-1000/x/tasks/b-old.output', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).some(entry => entry.outputFile !== undefined))
    // Restart: the persisted row recovers at boot...
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store(),
    })
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b-old', status: 'completed', summary: 'done before restart' },
    ])
    // ...and a resume spawns a driver seeded from the server-side records:
    // a new task's roster publish must not rewrite the old one without its
    // recorded output path.
    await manager.send(id, 'another turn')
    handles[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'b-new', tool_use_id: 'c9', task_type: 'local_bash', description: 'new task', is_backgrounded: true, uuid: 'u9', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).some(entry => entry.taskId === 'b-new'))
    expect(store().read(id)).toMatchObject([
      { taskId: 'b-old', outputFile: '/tmp/claude-1000/x/tasks/b-old.output', summary: 'done before restart' },
      { taskId: 'b-new', description: 'new task' },
    ])
    manager.shutdown()
  })

  test('readTaskOutput prefers the live query and coalesces concurrent asks', async () => {
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'hi')
    // The fake query grows the undeclared control (runtime shape only).
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    ;(handles[0]!.query as unknown as {
      getTaskOutput?: (taskId: string) => Promise<{ output: string; total_bytes: number; truncated: boolean }>
    }).getTaskOutput = async (taskId: string) => {
      calls += 1
      await gate
      return { output: `tail of ${taskId}`, total_bytes: 42, truncated: false }
    }
    const first = manager.readTaskOutput(id, 'b1')
    const second = manager.readTaskOutput(id, 'b1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    release!()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(a).toEqual({ state: 'ok', output: 'tail of b1', totalBytes: 42, truncated: false })
    expect(b).toEqual(a)
    // A throwing control falls back (here: to unavailable — no file record).
    ;(handles[0]!.query as unknown as { getTaskOutput?: unknown }).getTaskOutput = async () => {
      throw new Error('control exploded')
    }
    await expect(manager.readTaskOutput(id, 'b2')).resolves.toEqual({ state: 'unavailable' })
  })

  test('readTaskOutput falls back to the recorded output file', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks-fallback')
    fs.mkdirSync(path.join(taskDir, 'tasks'), { recursive: true })
    const file = path.join(taskDir, 'tasks', 'b-file.output')
    fs.writeFileSync(file, 'shell-a-done\n')
    const store = () => new ChatTaskStore({ dir: path.join(tempDir, 'chat-tasks-store') })
    await store().write('chat-fb', [{
      taskId: 'b-file', kind: 'shell', status: 'completed', summary: 'done',
      outputFile: file, startedAtMs: 1, endedAtMs: 2,
    }])
    // No session, no live driver: the sidecar record answers.
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory([]), taskStore: store(),
    })
    await expect(manager.readTaskOutput('chat-fb', 'b-file')).resolves.toEqual({
      state: 'ok', output: 'shell-a-done\n', totalBytes: 13, truncated: false,
    })
    // A record whose file is gone, and an unknown task: unavailable.
    await store().write('chat-fb', [{ taskId: 'b-gone', kind: 'shell', status: 'completed', startedAtMs: 1, outputFile: path.join(taskDir, 'tasks', 'b-gone.output') }])
    await expect(manager.readTaskOutput('chat-fb', 'b-gone')).resolves.toEqual({ state: 'unavailable' })
    await expect(manager.readTaskOutput('chat-fb', 'b-unknown')).resolves.toEqual({ state: 'unavailable' })
    // A path outside the recorded layout is never read, even if it exists.
    const outside = path.join(tempDir, 'outside.output')
    fs.writeFileSync(outside, 'secret')
    await store().write('chat-fb', [{ taskId: 'b-bad', kind: 'shell', status: 'completed', startedAtMs: 1, outputFile: outside }])
    await expect(manager.readTaskOutput('chat-fb', 'b-bad')).resolves.toEqual({ state: 'unavailable' })
  })

  test('stopBackgroundTask stops one live task; the settle rides the roster, the turn is untouched', async () => {
    const handles: FakeHandle[] = []
    const events: Array<{ sessionId: string; event: ChatEvent }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: (sessionId, event) => events.push({ sessionId, event }),
      queryFactory: fakeQueryFactory(handles),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    // A turn is in flight (no result yet) while two tasks run.
    await manager.send(id, 'run two')
    const handle = handles[0]!
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-stop', task_type: 'local_bash', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-keep', task_type: 'local_bash', is_backgrounded: true, uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    const stopped: string[] = []
    ;(handle.query as unknown as { stopTask?: (taskId: string) => Promise<void> }).stopTask = async (taskId: string) => {
      stopped.push(taskId)
    }
    await manager.stopBackgroundTask(id, 'b-stop')
    expect(stopped).toEqual(['b-stop'])
    // The CLI's settle: one notification, only for the stopped task.
    handle.push({ type: 'system', subtype: 'task_notification', task_id: 'b-stop', status: 'stopped', summary: 'Sleep', uuid: 'u3', session_id: 's' } as unknown as SDKMessage)
    await flush()
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b-stop', status: 'stopped', live: false },
      { taskId: 'b-keep', status: 'running', live: true },
    ])
    // No transcript error, and the in-flight turn never ended.
    expect(events.some(({ event }) => event.type === 'error')).toBe(false)
    expect(events.some(({ event }) => event.type === 'turn_completed')).toBe(false)
  })

  test('stopBackgroundTask refuses archived sessions and ended or unknown tasks, without a transcript error', async () => {
    const handles: FakeHandle[] = []
    const events: Array<{ sessionId: string; event: ChatEvent }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: (sessionId, event) => events.push({ sessionId, event }),
      queryFactory: fakeQueryFactory(handles),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run one')
    const handle = handles[0]!
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-done', task_type: 'local_bash', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_notification', task_id: 'b-done', status: 'completed', summary: 'done', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    const stopped: string[] = []
    ;(handle.query as unknown as { stopTask?: (taskId: string) => Promise<void> }).stopTask = async (taskId: string) => {
      stopped.push(taskId)
    }
    // Ended task, and one the roster never knew.
    await manager.stopBackgroundTask(id, 'b-done')
    await manager.stopBackgroundTask(id, 'b-unknown')
    expect(stopped).toEqual([])
    // Archive ends the process: even a row the roster still holds as live
    // (none here after settle) could not be stopped.
    await manager.archive(id)
    await manager.stopBackgroundTask(id, 'b-done')
    expect(stopped).toEqual([])
    expect(events.some(({ event }) => event.type === 'error')).toBe(false)
  })
})

describe('ChatSessionManager provider usage pull', () => {
  let tempDir: string
  let db: SessionDatabase
  const original = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-zai-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
    // The provider routing comes from getProviderEnv per test, never from
    // the machine's real environment.
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_AUTH_TOKEN
  })

  afterEach(() => {
    if (original.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = original.apiKey
    if (original.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original.configDir
    if (original.home === undefined) delete process.env.HOME
    else process.env.HOME = original.home
    if (original.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = original.baseUrl
    if (original.authToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = original.authToken
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** The 2026-10-12 quota capture, first at 2% and then at 50% after a refresh. */
  const CAPTURE = (percentage: number) => ({
    code: 200,
    msg: 'Operation successful',
    data: {
      limits: [{ type: 'TIME_LIMIT', percentage, nextResetTime: 1793701399997 }],
      level: 'pro',
    },
    success: true,
  })

  const SDK_PULL = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 22.37, resets_at: '2026-10-07T18:11:04.000Z' },
    },
  }

  interface ProviderHarness {
    manager: ChatSessionManager
    handles: FakeHandle[]
    usage: Array<{ providerId: string; report: ChatUsageReport | null }>
    fetchCalls: Array<{ url: string; auth?: string }>
  }

  async function createProviderHarness(
    providerEnv: Record<string, string>,
    responses: Array<Response>,
    catalogHome?: string,
    refreshMs = 50
  ): Promise<ProviderHarness> {
    const fetchCalls: Array<{ url: string; auth?: string }> = []
    const canned = [...responses]
    const providerUsageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      fetchCalls.push({ url: String(input), auth: headers.Authorization })
      const next = canned.shift() ?? canned[canned.length - 1]
      if (!next) throw new Error('no canned response left')
      return next
    }) as unknown as typeof fetch
    const handles: FakeHandle[] = []
    const usage: Array<{ providerId: string; report: ChatUsageReport | null }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onUsage: (providerId, report) => usage.push({ providerId, report }),
      queryFactory: fakeQueryFactory(handles, () => Promise.resolve(SDK_PULL)),
      ...(Object.keys(providerEnv).length > 0 ? { getProviderEnv: () => providerEnv } : {}),
      ...(catalogHome ? { profileCatalogHome: catalogHome } : {}),
      providerUsageFetch,
      providerUsageRefreshMs: refreshMs,
    })
    return { manager, handles, usage, fetchCalls }
  }

  test('a profile with no base URL is never probed; the SDK pull answers', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness({}, [])
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()

    expect(fetchCalls).toEqual([])
    // The fake query's usage control answered; no provider request was made.
    expect(handles[0]!.usageCalls).toHaveLength(1)
    expect(usage.some((entry) => entry.report?.source === 'pull')).toBe(true)
  })

  test('a path-prefixed provider records usage on attach without a prompt or SDK pull', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2))]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toEqual([
      { url: 'https://zai.test/api/monitor/usage/quota/limit', auth: 'sk-glm-token' },
    ])
    // Exactly one broadcast — the provider report; the host-login SDK pull
    // never ran.
    expect(usage).toHaveLength(1)
    expect(usage[0]!.report?.source).toBe('provider')
    expect(usage[0]!.report?.windows[0]).toMatchObject({ key: 'zai:time_limit', percentUsed: 2 })
    expect(handles[0]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(created.session.id)!.usage?.source).toBe('provider')
    expect(manager.getSnapshot(created.session.id)!.usage?.windows[0]).toMatchObject({ key: 'zai:time_limit', percentUsed: 2 })
    expect(manager.getSnapshot(created.session.id)!.status).toBe('waiting')
  })

  test('profiles share a provider: one pull serves sibling models', async () => {
    // glm and glm-flash are models of zai in this pinned catalog; the
    // sibling sessions share one pull, one report, and one refresh cadence
    // (providers-and-workers 5.1).
    const catalog = path.join(tempDir, 'catalog')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {}, 'glm-flash': {} } } })
    )
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'profiles.json'),
      JSON.stringify({
        glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' } },
        'glm-flash': { label: 'GLM Flash', env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' } },
      })
    )
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2))],
      catalog,
      // No cadence tick inside the test: the counts below are claim-driven.
      3_600_000
    )
    const first = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!first.ok) throw new Error(first.error)
    const second = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm-flash' })
    if (!second.ok) throw new Error(second.error)
    await manager.start(first.session.id)
    await flush()

    // Exactly one provider pull — the second profile's claim resolves to the
    // same already-routed provider.
    expect(fetchCalls).toHaveLength(1)
    expect(usage).toHaveLength(1)
    expect(usage[0]!.providerId).toBe('zai')
    expect(usage[0]!.report?.source).toBe('provider')

    // The sibling session attaches: no second claim, no SDK pull, and its
    // own snapshot reads the provider's report under its own profile id.
    await manager.start(second.session.id)
    await flush()
    expect(fetchCalls).toHaveLength(1)
    expect(handles[1]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(second.session.id)!.usage?.source).toBe('provider')
    expect(manager.getSnapshot(second.session.id)!.usage?.windows[0]).toMatchObject({ key: 'zai:time_limit', percentUsed: 2 })
  })

  test.each([401, 403, 1001])('a provider auth code %s records no data and skips the SDK pull', async code => {
    const { manager, handles, usage } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse({ code, msg: 'Authentication refused', success: false })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()

    expect(usage).toEqual([{ providerId: 'claude', report: null }])
    expect(handles[0]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(created.session.id)!.usage).toBeNull()
  })

  test('a base URL without the endpoint falls back to the host-login SDK pull', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://other-gateway.test' },
      [new Response('nope', { status: 404 })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()

    expect(fetchCalls).toHaveLength(1) // probed exactly once
    expect(handles[0]!.usageCalls).toHaveLength(1) // then the SDK pull ran
    expect(usage.some((entry) => entry.report?.source === 'pull')).toBe(true)
  })

  test.each([
    { code: 500, msg: '404 NOT_FOUND' },
    { code: 500, msg: 'upstream unavailable' },
    { code: 9999, msg: 'unknown failure' },
  ])('a non-auth quota envelope $code/$msg permits the SDK pull without retrying the probe', async body => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic' },
      [jsonResponse({ success: false, ...body })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://zai.test/api/monitor/usage/quota/limit')
    expect(handles[0]!.usageCalls).toHaveLength(1)
    expect(usage.some(entry => entry.report?.source === 'provider')).toBe(false)
    expect(manager.getSnapshot(created.session.id)!.usage?.source).toBe('pull')

    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()
    expect(fetchCalls).toHaveLength(1)
    expect(handles[0]!.usageCalls).toHaveLength(1)
  })

  test('a routed profile refreshes on the cadence without a turn', async () => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2)), jsonResponse(CAPTURE(50))]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()
    expect(usage[0]!.report?.windows[0]).toMatchObject({ percentUsed: 2 })

    // No turn runs; the timer re-pulls and the new percentage replaces the old.
    await waitForCondition(() => usage.length >= 2)
    expect(usage[1]!.report?.windows[0]).toMatchObject({ percentUsed: 50 })
    expect(manager.getSnapshot(created.session.id)!.usage?.windows[0]).toMatchObject({
      percentUsed: 50,
    })
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)
    expect(fetchCalls.every(call => call.url === 'https://zai.test/api/monitor/usage/quota/limit' && call.auth === 'sk-glm-token')).toBe(true)
    expect(handles[0]!.usageCalls).toEqual([])
  })

  test('a session on another profile keeps the provider fresh after the first archives', async () => {
    // glm and glm-flash share zai (providers-and-workers 5.2): archiving the
    // glm session must not stop the pulls while the glm-flash session lives,
    // and archiving the last one does.
    const catalog = path.join(tempDir, 'catalog-fresh')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {}, 'glm-flash': {} } } })
    )
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'profiles.json'),
      JSON.stringify({
        glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' } },
        'glm-flash': { label: 'GLM Flash', env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' } },
      })
    )
    const { manager, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2)), jsonResponse(CAPTURE(50)), jsonResponse(CAPTURE(77))],
      catalog
    )
    const first = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!first.ok) throw new Error(first.error)
    const second = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm-flash' })
    if (!second.ok) throw new Error(second.error)
    await manager.start(first.session.id)
    await manager.start(second.session.id)
    await flush()

    await manager.archive(first.session.id)
    // The glm-flash session alone keeps the cadence alive: a fresh pull
    // lands after the archive.
    await waitForCondition(() => fetchCalls.length >= 3)
    await flush()
    expect(usage.at(-1)!.report?.windows[0]).toMatchObject({ percentUsed: 77 })
    expect(manager.getSnapshot(second.session.id)!.usage?.windows[0]).toMatchObject({ percentUsed: 77 })

    // With no live session of the provider left, the cadence stops.
    await manager.archive(second.session.id)
    const settled = fetchCalls.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fetchCalls).toHaveLength(settled)
  })

  test('the refresh pull resolves through a live session, never an archived or driverless sibling\'s', async () => {
    // Invariant (providers-and-workers 5.2): the refresh cadence picks its
    // pull target from a LIVE session of the provider — a record that is
    // neither archived nor without a started driver — never from an earlier
    // sibling's record. Project-level provider overlays make the targets
    // observable: zai's base URL is overlaid to zai-archived in the dead
    // siblings' project, while the live session's project keeps the harness
    // default (zai-live). Catalog files never carry credentials, so the
    // pull's base URL is the pin.
    const catalog = path.join(tempDir, 'catalog-live-target')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { label: 'Z.AI', models: { glm: {}, 'glm-flash': {} } } })
    )
    const projA = path.join(tempDir, 'projA')
    fs.mkdirSync(path.join(projA, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(projA, '.kawai', 'providers.json'),
      JSON.stringify({ zai: { env: { ANTHROPIC_BASE_URL: 'https://zai-archived.test/api/anthropic' } } })
    )
    const { manager, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai-live.test/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-live' },
      [jsonResponse(CAPTURE(2)), jsonResponse(CAPTURE(50)), jsonResponse(CAPTURE(77)), jsonResponse(CAPTURE(88))],
      catalog
    )
    // Insertion order matters: the dead siblings sit before the live one,
    // so a resolver that ignores liveness picks an archived target.
    const archived = manager.createSession({ projectPath: projA, claudeProfileId: 'glm' })
    if (!archived.ok) throw new Error(archived.error)
    const driverless = manager.createSession({ projectPath: projA, claudeProfileId: 'glm' })
    if (!driverless.ok) throw new Error(driverless.error)
    const live = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm-flash' })
    if (!live.ok) throw new Error(live.error)
    await manager.start(archived.session.id)
    await manager.start(live.session.id)
    await flush()

    await manager.archive(archived.session.id)
    // Archive deletes the driver today, and the archivedAt filter is what
    // keeps the pull correct if that ever stops holding: reinstate a stale
    // driver entry artificially to pin the filter's own semantics. The stub
    // answers the dispatch pass's eligibility probe so it stays inert.
    ;(manager as unknown as { drivers: Map<string, unknown> }).drivers.set(archived.session.id, {
      getPendingRequests: () => [],
      interrupt() {},
      deliver() {},
    })
    // Every pull from here on runs after the archive: all must resolve the
    // live session's endpoint, not a dead sibling's. (Each started session's
    // own start pull legitimately used its project's URL, so only the tail
    // asserts.)
    const afterArchive = fetchCalls.length
    await waitForCondition(() => fetchCalls.length >= afterArchive + 2)
    await flush()
    const tail = fetchCalls.slice(afterArchive)
    expect(tail.length).toBeGreaterThanOrEqual(2)
    expect(tail.every(call => call.url === 'https://zai-live.test/api/monitor/usage/quota/limit')).toBe(true)
  })

  test('routing usage sources: a profile maps to its provider, a provider stays un-mapped', async () => {
    // Provider 'glm' holds profile 'glm-air' beside provider 'zai' holding
    // profile 'glm' (providers-and-workers D14): the router's profile source
    // re-maps a profile to its provider's report, while the provider source
    // reads by provider id and must not re-map it back to zai.
    const catalog = path.join(tempDir, 'catalog-usage-keys')
    fs.mkdirSync(path.join(catalog, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(catalog, '.kawai', 'providers.json'),
      JSON.stringify({
        zai: { label: 'Z.AI', models: { glm: {} } },
        glm: { label: 'GLM', models: { 'glm-air': {} } },
      })
    )
    const { manager } = await createProviderHarness({}, [], catalog, 3_600_000)
    const store = (manager as unknown as {
      usageLimits: { record(id: string, report: ChatUsageReport): void }
    }).usageLimits
    const at = '2026-10-12T12:00:00.000Z'
    store.record('zai', { status: 'allowed', windows: [{ key: 'zai:time_limit', label: 'zai', percentUsed: 61, resetsAt: null }], receivedAt: at, source: 'provider' })
    store.record('glm', { status: 'warning', windows: [{ key: 'glm:time_limit', label: 'glm', percentUsed: 12, resetsAt: null }], receivedAt: at, source: 'provider' })
    const sources = (manager as unknown as {
      teamMail: { router: { options: {
        usageOf(id: string): ChatUsageReport | null
        providerUsageOf(id: string): ChatUsageReport | null
      } } }
    }).teamMail.router.options
    expect(sources.usageOf('glm')?.windows[0]).toMatchObject({ key: 'zai:time_limit' })
    expect(sources.usageOf('glm-air')?.windows[0]).toMatchObject({ key: 'glm:time_limit' })
    expect(sources.providerUsageOf('glm')?.windows[0]).toMatchObject({ key: 'glm:time_limit' })
    expect(sources.providerUsageOf('zai')?.windows[0]).toMatchObject({ key: 'zai:time_limit' })
  })

  test.each([
    { code: 500, msg: '404 NOT_FOUND' },
    { code: 1001, msg: 'Authentication refused' },
    { code: 500, msg: 'upstream unavailable' },
  ])('a failed provider refresh $code/$msg keeps the held report and never pulls the SDK', async body => {
    const { manager, handles, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic' },
      [jsonResponse(CAPTURE(2)), jsonResponse({ success: false, ...body })]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    expect(await manager.start(created.session.id)).toEqual({ ok: true })
    await flush()
    const held = manager.getSnapshot(created.session.id)!.usage
    expect(held?.source).toBe('provider')

    await waitForCondition(() => fetchCalls.length >= 2)
    await flush()
    expect(manager.getSnapshot(created.session.id)!.usage).toEqual(held)
    expect(usage).toHaveLength(1)
    expect(handles[0]!.usageCalls).toEqual([])
  })

  test('archiving the last live session stops the pulls', async () => {
    const { manager, usage, fetchCalls } = await createProviderHarness(
      { ANTHROPIC_BASE_URL: 'https://zai.test', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
      [jsonResponse(CAPTURE(2))]
    )
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)
    const beforeArchive = fetchCalls.length

    await manager.archive(created.session.id)
    // Several cadences pass: the tick clears the timer without a request,
    // and the held report stays visible.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fetchCalls).toHaveLength(beforeArchive)
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(created.session.id)!.usage?.source).toBe('provider')
  })

  /** A fetch the test resolves manually, to hold a pull in flight. */
  function deferredFetch(): {
    impl: typeof fetch
    deferreds: Array<(response: Response) => void>
  } {
    const deferreds: Array<(response: Response) => void> = []
    const impl = (async () =>
      new Promise<Response>((resolve) => {
        deferreds.push(resolve)
      })) as unknown as typeof fetch
    return { impl, deferreds }
  }

  async function createManualHarness(providerUsageFetch: typeof fetch) {
    const handles: FakeHandle[] = []
    const usage: Array<{ providerId: string; report: ChatUsageReport | null }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onUsage: (providerId, report) => usage.push({ providerId, report }),
      queryFactory: fakeQueryFactory(handles, () => Promise.resolve(SDK_PULL)),
      getProviderEnv: () => ({
        ANTHROPIC_BASE_URL: 'https://zai.test',
        ANTHROPIC_AUTH_TOKEN: 'sk-glm-token',
      }),
      providerUsageFetch,
      providerUsageRefreshMs: 25,
    })
    return { manager, usage }
  }

  test('an in-flight first pull publishes nothing after shutdown', async () => {
    const { impl, deferreds } = deferredFetch()
    const { manager, usage } = await createManualHarness(impl)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()
    expect(deferreds.length).toBe(1) // the spawn pull is in flight

    manager.shutdown()
    deferreds[0]!(jsonResponse(CAPTURE(2)))
    await flush()
    // The late answer publishes nothing and arms no refresh timer.
    expect(usage).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(deferreds.length).toBe(1)
  })

  test('an in-flight refresh publishes nothing after shutdown', async () => {
    const { impl, deferreds } = deferredFetch()
    const { manager, usage } = await createManualHarness(impl)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await manager.send(created.session.id, 'hello')
    await flush()
    deferreds[0]!(jsonResponse(CAPTURE(2)))
    await flush()
    expect(usage).toHaveLength(1)

    // The next tick's refresh is in flight when the server shuts down.
    await waitForCondition(() => deferreds.length >= 2)
    manager.shutdown()
    deferreds[1]!(jsonResponse(CAPTURE(99)))
    await flush()
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(created.session.id)!.usage?.windows[0]).toMatchObject({
      percentUsed: 2,
    })
  })

  // --------------------------------- OpenRouter usage endpoint (openrouter-provider 2.2)

  const OR_TOKEN = 'sk-or-inference-fake'
  const OR_MGMT = 'sk-or-management-fake'
  const orOriginalWarn = logger.warn

  /** The spike's capped-key capture, under the `data` wrapper OpenRouter's docs declare. */
  const OR_KEY_FIELDS = {
    limit: 0.05,
    limit_remaining: 0.04,
    limit_reset: null,
    budgets: [
      {
        scope: 'key_limit',
        limit_usd: 0.05,
        spend_usd: 0.01,
        remaining_usd: 0.04,
        reset_interval: null,
        resets_at: null,
      },
    ],
    effective_budget: null,
    is_management_key: false,
  }
  const OR_KEY_BODY = { data: OR_KEY_FIELDS }

  function writeOpenRouterCatalog(withBalanceKey: boolean): string {
    const root = path.join(tempDir, 'catalog-openrouter')
    fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.kawai', 'providers.json'),
      JSON.stringify({
        openrouter: {
          label: 'OpenRouter',
          authTokenEnv: 'OPENROUTER_API_KEY',
          ...(withBalanceKey ? { balanceKeyEnv: 'OPENROUTER_MANAGEMENT_KEY' } : {}),
          // A credentialed provider must have a base URL in the trusted tier (D5).
          env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
          models: { 'openrouter-sonnet': {} },
        },
      })
    )
    // The model key in providers.json is the profile; no profiles.json entry
    // (one would be ignored with a warning).
    return root
  }

  /** A harness answering per endpoint path; an Error value makes that request throw, a function is called per pull. */
  async function createOpenRouterHarness(
    responses: Record<string, Response | Error | (() => Response | Error)>,
    withBalanceKey = false,
    refreshMs = 3_600_000
  ): Promise<ProviderHarness> {
    const catalog = writeOpenRouterCatalog(withBalanceKey)
    const fetchCalls: Array<{ url: string; auth?: string }> = []
    const providerUsageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
      const next = responses[new URL(url).pathname]
      const value = typeof next === 'function' ? next() : next
      if (!value) throw new Error(`unexpected request to ${url}`)
      if (value instanceof Error) throw value
      return value
    }) as unknown as typeof fetch
    const handles: FakeHandle[] = []
    const usage: Array<{ providerId: string; report: ChatUsageReport | null }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      onUsage: (providerId, report) => usage.push({ providerId, report }),
      queryFactory: fakeQueryFactory(handles, () => Promise.resolve(SDK_PULL)),
      getProviderEnv: () => ({
        OPENROUTER_API_KEY: OR_TOKEN,
        ...(withBalanceKey ? { OPENROUTER_MANAGEMENT_KEY: OR_MGMT } : {}),
      }),
      profileCatalogHome: catalog,
      providerUsageFetch,
      providerUsageRefreshMs: refreshMs,
    })
    return { manager, handles, usage, fetchCalls }
  }

  function startOpenRouterSession(manager: ChatSessionManager): string {
    const created = manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'openrouter-sonnet' })
    if (!created.ok) throw new Error(created.error)
    return created.session.id
  }

  test('an OpenRouter session start pulls /api/v1/key with the session key, never the quota endpoint', async () => {
    const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness({
      '/api/v1/key': jsonResponse(OR_KEY_BODY),
    })
    const id = startOpenRouterSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${OR_TOKEN}` },
    ])
    expect(usage).toHaveLength(1)
    expect(usage[0]!.providerId).toBe('openrouter')
    expect(usage[0]!.report?.source).toBe('provider')
    expect(usage[0]!.report?.windows[0]).toMatchObject({
      key: 'openrouter:key_limit',
      label: 'Key cap · $0.04 left',
      percentUsed: 20,
    })
    // The host-login SDK pull never ran.
    expect(handles[0]!.usageCalls).toEqual([])
    const snapshot = manager.getSnapshot(id)!
    expect(snapshot.usage?.source).toBe('provider')
    expect(snapshot.status).toBe('waiting')
  })

  test.each([401, 403])('a key pull refused with %s records no data and never shows the host plan', async status => {
    const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness({
      '/api/v1/key': jsonResponse({ error: 'bad key' }, status),
    })
    const id = startOpenRouterSession(manager)
    await manager.send(id, 'hello')
    await flush()

    expect(usage).toEqual([{ providerId: 'openrouter', report: null }])
    expect(handles[0]!.usageCalls).toEqual([])
    expect(manager.getSnapshot(id)!.usage).toBeNull()
    // Even after the refusal the host-login pull stays suppressed.
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    expect(fetchCalls).toHaveLength(1)
    expect(handles[0]!.usageCalls).toEqual([])
  })

  test.each([
    ['a 404', jsonResponse({ error: 'no route' }, 404)],
    ['a server error', jsonResponse({ error: 'boom' }, 500)],
    ['a foreign body', jsonResponse({ hello: true })],
    ['a transport error', new Error('offline')],
  ])('a failing key endpoint (%s) records no data and keeps the host-login pull suppressed', async (_name, response) => {
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    logger.warn = (event: string, data?: Record<string, unknown>) => {
      warnings.push({ event, data })
    }
    try {
      const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness({
        '/api/v1/key': response,
      })
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await flush()

      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0]!.url).toBe('https://openrouter.ai/api/v1/key')
      expect(usage).toEqual([{ providerId: 'openrouter', report: null }])
      expect(handles[0]!.usageCalls).toEqual([])
      expect(manager.getSnapshot(id)!.usage).toBeNull()
      // The failure log (both outcomes land here) names the host and status,
      // never the key (openrouter-provider 2.2).
      const failures = warnings.filter(entry => entry.event === 'chat_openrouter_key_pull_failed')
      expect(failures.length).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(warnings).includes(OR_TOKEN)).toBe(false)
    } finally {
      logger.warn = orOriginalWarn
    }
  })

  test('a balance key pulls credits with the management value and merges the credits meter', async () => {
    const { manager, usage, fetchCalls } = await createOpenRouterHarness(
      {
        '/api/v1/key': jsonResponse(OR_KEY_BODY),
        '/api/v1/credits': jsonResponse({ data: { total_credits: 40, total_usage: 15.57 } }),
      },
      true
    )
    const id = startOpenRouterSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()

    expect(fetchCalls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${OR_TOKEN}` },
      { url: 'https://openrouter.ai/api/v1/credits', auth: `Bearer ${OR_MGMT}` },
    ])
    expect(usage[0]!.report?.windows.map(window => window.key)).toEqual([
      'openrouter:key_limit',
      'openrouter:credits',
    ])
    expect(usage[0]!.report?.windows[1]).toMatchObject({ label: 'Credits · $24.43 left' })
  })

  test('a credits refusal drops only the credits meter and logs once per value, never the key', async () => {
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    logger.warn = (event: string, data?: Record<string, unknown>) => {
      warnings.push({ event, data })
    }
    try {
      const { manager, usage, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': jsonResponse(OR_KEY_BODY),
          '/api/v1/credits': jsonResponse({ error: 'Only management keys' }, 403),
        },
        true,
        25
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await flush()
      expect(usage[0]!.report?.windows.map(window => window.key)).toEqual(['openrouter:key_limit'])
      const refusals = warnings.filter(entry => entry.event === 'chat_openrouter_credits_refused')
      expect(refusals).toHaveLength(1)
      expect(refusals[0]!.data).toMatchObject({ providerId: 'openrouter' })
      expect(JSON.stringify(warnings).includes(OR_MGMT)).toBe(false)
      expect(JSON.stringify(warnings).includes(OR_TOKEN)).toBe(false)
      // A later refresh carrying the same value does not log again.
      await waitForCondition(() => fetchCalls.length >= 4)
      expect(warnings.filter(entry => entry.event === 'chat_openrouter_credits_refused')).toHaveLength(1)
    } finally {
      logger.warn = orOriginalWarn
    }
  })

  test('a pulled remaining amount feeds the credit-cooldown overlay (openrouter-provider D8)', async () => {
    let remaining = 0.04
    const keyBody = () =>
      jsonResponse({ data: { ...OR_KEY_FIELDS, limit_remaining: remaining, budgets: [{ ...OR_KEY_FIELDS.budgets[0], remaining_usd: remaining }] } })
    const { manager } = await createOpenRouterHarness({ '/api/v1/key': keyBody }, false, 25)
    manager.limitEvents.record({
      profileId: 'openrouter-sonnet',
      sessionId: 'sdk-or',
      groupId: null,
      kind: 'billing_error',
      final: true,
      status: 402,
      message: 'API Error: 402 out of credit',
      resetsAt: null,
      providerId: 'openrouter',
      window: 'credit',
    })
    const id = startOpenRouterSession(manager)
    // Out of credit with no reset known: the profile cools.
    expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    // The first post-event pull (0.04 left) only sets the overlay's baseline.
    expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
    // A later pull reporting more left than the baseline ends the cooldown early.
    remaining = 0.05
    await waitForCondition(
      () => manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until === null,
      2_000
    )
  })

  test('agent reports are not kept for an own-endpoint provider', async () => {
    const { manager, handles, usage } = await createOpenRouterHarness({
      '/api/v1/key': jsonResponse(OR_KEY_BODY),
    })
    const id = startOpenRouterSession(manager)
    expect(await manager.start(id)).toEqual({ ok: true })
    await flush()
    expect(usage).toHaveLength(1)
    handles[0]!.push({
      type: 'assistant',
      message: {
        id: 'msg_usage',
        content: [{ type: 'text', text: 'Usage report' }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'u-uuid',
      session_id: 'sdk-1',
      usage_report: {
        rate_limits: {
          limits: [{ kind: 'session', percent: 22.4, resets_at: null, severity: 'normal' }],
        },
      },
    } as unknown as SDKMessage)
    handles[0]!.push({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1793701399 } },
      },
      uuid: 'rl-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    // Neither report replaced the pull's own data.
    expect(usage).toHaveLength(1)
    expect(manager.getSnapshot(id)!.usage?.windows[0]).toMatchObject({ key: 'openrouter:key_limit' })
  })

  test('a topped-up balance appears through the scheduled pull without a turn', async () => {
    jest.useFakeTimers()
    try {
      let remaining = 0.04
      const { manager, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () =>
            jsonResponse({ data: { ...OR_KEY_FIELDS, limit_remaining: remaining, budgets: [{ ...OR_KEY_FIELDS.budgets[0], remaining_usd: remaining }] } }),
        },
        false,
        600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      expect(manager.getSnapshot(id)!.usage?.windows[0]).toMatchObject({ label: 'Key cap · $0.04 left' })

      // The owner tops up; the next 10-minute cadence tick shows it — no turn ran.
      remaining = 0.03
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(manager.getSnapshot(id)!.usage?.windows[0]).toMatchObject({ label: 'Key cap · $0.03 left' })
    } finally {
      jest.useRealTimers()
    }
  })

  test('archiving the last live session stops the OpenRouter pulls', async () => {
    jest.useFakeTimers()
    try {
      const { manager, usage, fetchCalls } = await createOpenRouterHarness(
        { '/api/v1/key': jsonResponse(OR_KEY_BODY) },
        false,
        600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      // One cadence tick pulls; archiving stops every later one.
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)

      await manager.archive(id)
      jest.advanceTimersByTime(600_000)
      await drainNow()
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(usage).toHaveLength(2)
      expect(manager.getSnapshot(id)!.usage?.source).toBe('provider')
    } finally {
      jest.useRealTimers()
    }
  })

  test('a failed first pull still arms the cadence; the next tick shows the meters', async () => {
    jest.useFakeTimers()
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    logger.warn = (event: string, data?: Record<string, unknown>) => {
      warnings.push({ event, data })
    }
    try {
      let healthy = false
      const { manager, handles, usage, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () =>
            healthy ? jsonResponse(OR_KEY_BODY) : jsonResponse({ error: 'boom' }, 503),
        },
        false,
        600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      // The transient failure records no data and is logged once…
      expect(fetchCalls).toHaveLength(1)
      expect(usage).toEqual([{ providerId: 'openrouter', report: null }])
      expect(manager.getSnapshot(id)!.usage).toBeNull()
      expect(warnings.filter(entry => entry.event === 'chat_openrouter_key_pull_failed')).toHaveLength(1)
      // …but the provider is routed: the next cadence tick recovers the meters.
      healthy = true
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(usage[1]?.report?.windows[0]).toMatchObject({ label: 'Key cap · $0.04 left' })
      // The host-login pull stays suppressed through both outcomes.
      expect(handles[0]!.usageCalls).toEqual([])
    } finally {
      logger.warn = orOriginalWarn
      jest.useRealTimers()
    }
  })

  test('a pull whose credits meter dropped out does not end a credit cooldown (probe B)', async () => {
    jest.useFakeTimers()
    try {
      let creditsStatus = 200
      let creditsUsed = 39.99
      const { manager, fetchCalls } = await createOpenRouterHarness(
        {
          '/api/v1/key': () => jsonResponse(OR_KEY_BODY),
          '/api/v1/credits': () =>
            creditsStatus === 200
              ? jsonResponse({ data: { total_credits: 40, total_usage: creditsUsed } })
              : jsonResponse({ error: 'boom' }, creditsStatus),
        },
        true,
        600_000
      )
      manager.limitEvents.record({
        profileId: 'openrouter-sonnet',
        sessionId: 'sdk-or',
        groupId: null,
        kind: 'billing_error',
        final: true,
        status: 402,
        message: 'API Error: 402 out of credit',
        resetsAt: null,
        providerId: 'openrouter',
        window: 'credit',
      })
      // The frozen fake clock stamps the event and the first pull's reading
      // at one millisecond; move the clock so the event strictly precedes the
      // first post-event reading (the overlay ignores such a reading).
      jest.advanceTimersByTime(1)
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      // The complete first pull (key $0.04, credits $0.01 left) only sets the overlay's baseline.
      expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
      // The credits meter drops out: the key's larger $0.04 must not read as credit returning.
      creditsStatus = 502
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(4)
      expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).not.toBeNull()
      // A later complete pull reading more left than the baseline still ends it.
      creditsStatus = 200
      creditsUsed = 30
      jest.advanceTimersByTime(600_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(6)
      expect(manager.limitEvents.cooldownFor('openrouter-sonnet', 'openrouter').until).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  const costFrame = (cost: number): SDKMessage => ({
    type: 'stream_event',
    event: { type: 'message_delta', delta: {}, usage: { cost } },
    parent_tool_use_id: null,
    uuid: `se-${Math.random()}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage)

  /** Microtask rounds: promise chains settle without real timers (fake-timer tests). */
  async function drainNow(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }

  test('several quick costed turns cause one extra pull about 30 s after the first', async () => {
    jest.useFakeTimers()
    try {
      const { manager, handles, fetchCalls } = await createOpenRouterHarness(
        { '/api/v1/key': jsonResponse(OR_KEY_BODY) },
        false,
        3_600_000
      )
      const id = startOpenRouterSession(manager)
      expect(await manager.start(id)).toEqual({ ok: true })
      await drainNow()
      expect(fetchCalls).toHaveLength(1)

      // Three turns carrying a provider cost complete within 20 seconds.
      const costedTurn = async () => {
        expect(await manager.send(id, 'costly work')).toEqual({ ok: true })
        handles[0]!.push(costFrame(0.002))
        handles[0]!.push(resultWithWindow())
        await drainNow()
      }
      await costedTurn()
      jest.advanceTimersByTime(10_000)
      await costedTurn()
      jest.advanceTimersByTime(10_000)
      await costedTurn()
      await drainNow()

      // One pull lands about 30 s after the first costed turn.
      jest.advanceTimersByTime(30_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)
      expect(fetchCalls[1]!.url).toBe('https://openrouter.ai/api/v1/key')

      // A turn within a minute of that pull schedules nothing more.
      await costedTurn()
      jest.advanceTimersByTime(60_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(2)

      // A turn after the minute has passed schedules the next one.
      await costedTurn()
      jest.advanceTimersByTime(30_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(3)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a costed turn on a quota-serving provider schedules no extra pull', async () => {
    jest.useFakeTimers()
    try {
      const { manager, handles, fetchCalls } = await createProviderHarness(
        { ANTHROPIC_BASE_URL: 'https://zai.test', ANTHROPIC_AUTH_TOKEN: 'sk-glm-token' },
        [jsonResponse(CAPTURE(2))],
        undefined,
        3_600_000
      )
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      expect(await manager.start(created.session.id)).toEqual({ ok: true })
      await drainNow()
      expect(fetchCalls).toHaveLength(1)
      expect(await manager.send(created.session.id, 'costly work')).toEqual({ ok: true })
      handles[0]!.push(costFrame(0.002))
      handles[0]!.push(resultWithWindow())
      await drainNow()
      jest.advanceTimersByTime(60_000)
      await drainNow()
      expect(fetchCalls).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  describe('history window (chat-history-window 2.2)', () => {
    /** Turns at 100 h, 50 h, and 3 h ago; the oldest carries a tool pair. */
    function multiDayTranscript(): string {
      const at = (hoursAgo: number) =>
        new Date(Date.parse('2026-10-18T12:00:00.000Z') - hoursAgo * 3_600_000).toISOString()
      const lines = [
        { type: 'user', uuid: 'u-100', timestamp: at(100), message: { role: 'user', content: 'oldest question' } },
        { type: 'assistant', uuid: 'a-100', timestamp: at(100), message: { id: 'm-100', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-old', name: 'Bash', input: { command: 'echo' } }] } },
        { type: 'user', uuid: 'u-100r', timestamp: at(100), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-old', content: 'out' }] } },
        { type: 'assistant', uuid: 'a-100t', timestamp: at(99), message: { id: 'm-100t', role: 'assistant', content: [{ type: 'text', text: 'oldest answer' }] } },
        { type: 'user', uuid: 'u-50', timestamp: at(50), message: { role: 'user', content: 'middle question' } },
        { type: 'assistant', uuid: 'a-50', timestamp: at(50), message: { id: 'm-50', role: 'assistant', content: [{ type: 'text', text: 'middle answer' }] } },
        { type: 'user', uuid: 'u-3', timestamp: at(3), message: { role: 'user', content: 'recent question' } },
        { type: 'assistant', uuid: 'a-3', timestamp: at(3), message: { id: 'm-3', role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] } },
      ]
      return lines.map(line => JSON.stringify(line)).join('\n')
    }

    /** A restarted manager whose stored sdk id replays the multi-day transcript. */
    async function restartedManager() {
      const first = await createHarness(db)
      const created = first.manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error('create failed')
      await first.manager.send(created.session.id, 'seed')
      first.handles[0]!.push(initMessage('sdk-hist-window'))
      await flush()
      first.manager.shutdown()
      writeTranscript('sdk-hist-window', multiDayTranscript())
      const restarted = await createHarness(db)
      return { manager: restarted.manager, handles: restarted.handles, sessionId: created.session.id }
    }

    const userTexts = (snapshot: { events: ChatEvent[] }): string[] =>
      snapshot.events.filter((event): event is Extract<ChatEvent, { type: 'user_message' }> => event.type === 'user_message').map(event => event.text)

    test('a snapshot carries only the last 24 hours of a multi-day memo', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, sessionId } = await restartedManager()
      const snapshot = manager.getSnapshot(sessionId)!
      expect(userTexts(snapshot)).toEqual(['recent question'])
      expect(snapshot.historyHasOlder).toBe(true)
      expect(snapshot.historyStartId).toBe(snapshot.events[0]!.id)
      expect(snapshot.historyStartId).toMatch(/^hist-/)
      // The window is unchanged for a caller that sends no historyFrom.
      expect(manager.getSnapshot(sessionId, {})!.events).toEqual(snapshot.events)
    })

    test('historyFrom widens a reconnect snapshot to the held unit', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, sessionId } = await restartedManager()
      const narrow = manager.getSnapshot(sessionId)!
      // The client's oldest held event is the middle turn's replayed opener.
      const widened = manager.getSnapshot(sessionId, { historyFrom: 'hist-u-50' })!
      expect(userTexts(widened)).toEqual(['middle question', 'recent question'])
      expect(widened.historyStartId).toBe('hist-u-50')
      expect(widened.historyHasOlder).toBe(true)
      // An id the server no longer has falls back to the default window.
      const fallback = manager.getSnapshot(sessionId, { historyFrom: 'hist-gone' })!
      expect(fallback.events).toEqual(narrow.events)
      expect(fallback.historyStartId).toBe(narrow.historyStartId)
    })

    test('a pending approval rides a windowed snapshot; live events append', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, sessionId } = await restartedManager()
      expect(await manager.start(sessionId)).toEqual({ ok: true })
      const handle = handles[0]!
      await manager.send(sessionId, 'probe')
      handle.push({ type: 'assistant', uuid: 'live-1', message: { id: 'm-live', role: 'assistant', content: [{ type: 'text', text: 'working now' }] } } as unknown as SDKMessage)
      await flush()
      const pending = handle.options.canUseTool!('Bash', { command: 'echo now' }, {
        signal: new AbortController().signal, toolUseID: 'toolu-live', requestId: 'request-live',
      })
      await flush()
      const snapshot = manager.getSnapshot(sessionId)!
      // Requests are whole whatever the window did to the events.
      expect(snapshot.pendingRequests).toHaveLength(1)
      const requestId = snapshot.pendingRequests[0]!.requestId
      // Old memo turns stay out; the live turn is in; the live tail is not cut.
      expect(snapshot.events.some(event => event.type === 'user_message' && (event as { text: string }).text === 'oldest question')).toBe(false)
      expect(snapshot.events.some(event => event.type === 'assistant_text' && (event as { text: string }).text === 'working now')).toBe(true)
      expect(snapshot.throughSequence).toBeGreaterThan(0)
      expect(snapshot.historyHasOlder).toBe(true)
      expect(manager.resolveApproval(sessionId, requestId, 'allow').ok).toBe(true)
      await pending
      manager.shutdown()
    })

    test('an archived chat windows and pages without starting an agent', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, handles, sessionId } = await restartedManager()
      manager.archive(sessionId)
      const snapshot = manager.getSnapshot(sessionId)!
      expect(snapshot.historyHasOlder).toBe(true)
      const page = manager.getHistoryPage(sessionId, snapshot.historyStartId!)!
      expect(page.stale).toBe(false)
      expect(userTexts(page)).toEqual(['middle question'])
      expect(handles).toHaveLength(0)
      expect(manager.getSnapshot(sessionId, {})).not.toBeNull()
    })

    test('getHistoryPage pages back day by day, resolves tool anchors, reports stale', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
      const { manager, sessionId } = await restartedManager()
      const snapshot = manager.getSnapshot(sessionId)!
      // The 24 hours before the recent turn hold no turns, so one use still
      // loads the middle turn (the gap rule).
      const first = manager.getHistoryPage(sessionId, snapshot.historyStartId!)!
      expect(userTexts(first)).toEqual(['middle question'])
      expect(first.hasOlder).toBe(true)
      // The next page reaches the oldest turn; nothing older remains.
      const second = manager.getHistoryPage(sessionId, first.events[0]!.id)!
      expect(userTexts(second)).toEqual(['oldest question'])
      expect(second.hasOlder).toBe(false)
      // A search anchor inside the oldest turn pulls the whole page back.
      const anchored = manager.getHistoryPage(sessionId, snapshot.historyStartId!, 'tool:toolu-old')!
      expect(userTexts(anchored)).toEqual(['oldest question', 'middle question'])
      expect(anchored.hasOlder).toBe(false)
      // An unknown beforeId is stale with no events; unknown sessions none.
      expect(manager.getHistoryPage(sessionId, 'hist-drifted')).toEqual({ events: [], hasOlder: false, stale: true })
      expect(manager.getHistoryPage('chat-missing', 'hist-u-3')).toBeNull()
    })
  })
})

// Server entry point and composition root: Hono routes, the WebSocket
// protocol (sessions, chat, terminal streaming), log-content caching, remote
// session merge, and update wiring all start here.
import { createClaudeProfileRoutes, profileRequestError } from './routes/claudeProfiles'
import { createTeamGroupRoutes } from './routes/teamGroups'
import type { Server, ServerWebSocket } from 'bun'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Hono, type Context } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { createPasteFileRoutes } from './routes/pasteFile'
import { createChatProviderEnvStore } from './routes/chatProviderEnv'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { BUILD_VERSION } from './version'
import { startUpdateChecker } from './updates/updateChecker'
import { installUpdate } from './updates/updateInstaller'
import { detectRestartContext, restartAfterInstall } from './updates/updateRestart'
import {
  initDatabase,
  resolveDataDir,
} from './db'
import { LogPoller } from './logPoller'
import { toAgentSession } from './agentSessions'
import { ChatSessionManager } from './chat/ChatSessionManager'
import { ChatConnections, type ChatConnection } from './chat/ChatConnections'
import { ChatWireLogs } from './chat/ChatWireLogs'
import { ChatWorkerStore } from './chat/chatWorkerStore'
import { chatFixtureEnabled, fixtureQueryFactory } from './chat/developmentFixture'
import { parseApprovalPolicy } from './chat/approvalPolicy'
import {
  createTerminalProxy,
  resolveTerminalMode,
  TerminalProxyError,
} from './terminal'
import type { ITerminalProxy } from './terminal'
import { TerminalOutputCoalescer } from './terminal/outputCoalescer'
import { resolveProjectPath } from './paths'
import {
  HISTORY_MAX_AGE_MIN_HOURS,
  HISTORY_MAX_AGE_MAX_HOURS,
  type ClientMessage,
  type ServerMessage,
  type TerminalErrorCode,
  type DirectoryListing,
  type DirectoryErrorResponse,
  type Session,
  type TerminalSession,
} from '../shared/types'
import { isTerminalSession } from '../shared/types'
import { logger, logLevel } from './logger'
import {
  SessionRefreshWorkerClient,
} from './sessionRefreshWorkerClient'
import { TmuxTimeoutError } from './tmuxTimeout'
import {
  MAX_FIELD_LENGTH,
  isValidSessionId,
  isValidTmuxTarget,
} from './validators'
import {
  parseCreateChangeWorktreePayload,
  parseCreateWorktreePayload,
} from '../shared/workspaceValidation'
import { deepestPathMatch } from '../shared/workspace'
import { canonicalizePath } from './git/repositoryResolution'
import { createWorktree } from './git/createWorktree'
import { createChangeWorktree } from './git/createChangeWorktree'
import { WorkspaceCoordinator } from './workspace/workspaceCoordinator'
import { WorkspaceWatcher, createNodeWatcherHost } from './workspace/workspaceWatcher'
import { composeAutoStartCommand } from './applyCommand'
import { readLogLineWindow } from './logContent'
import { SessionRefreshLoop } from './refresh/SessionRefreshLoop'
import type { WSData } from './ws/wsTypes'
import { handleKill } from './sessions/kill'
import { handleRename } from './sessions/rename'
import { handleSessionHibernate } from './sessions/hibernate'
import { handleMoveToHistory } from './sessions/moveToHistory'
import { handleSessionWake } from './sessions/wake'
import type { SessionOpsContext } from './sessions/context'
import { stampLocalSession } from './sessionStamp'
import { readTmuxCapture } from './tmuxCapture'
import { RemoteSessionService } from './remote/RemoteSessionService'
import { SshTerminalProxy } from './terminal/SshTerminalProxy'
import { normalizeCapturedHistory } from './terminal/tmuxText'
import {
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'

function checkPortAvailable(port: number): void {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    // Use -sTCP:LISTEN to only match processes actually listening on the port,
    // not stale/closed connections from other processes (e.g. Playwright/Chrome)
    result = Bun.spawnSync(['lsof', '-i', `:${port}`, '-sTCP:LISTEN', '-t'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return
  }
  const pids = result.stdout?.toString().trim() ?? ''
  if (pids) {
    const pidList = pids.split('\n').filter(Boolean)
    const pid = pidList[0]
    // Get process name
    let processName = 'unknown'
    try {
      const nameResult = Bun.spawnSync(['ps', '-p', pid, '-o', 'comm='], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      processName = nameResult.stdout?.toString().trim() || 'unknown'
    } catch {
    }
    logger.error('port_in_use', { port, pid, processName })
    process.exit(1)
  }
}

function getTailscaleIp(): string | null {
  // Try common Tailscale CLI paths (standalone CLI, then Mac App Store bundle)
  const tailscalePaths = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ]

  for (const tsPath of tailscalePaths) {
    try {
      const result = Bun.spawnSync([tsPath, 'ip', '-4'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (result.exitCode === 0) {
        const ip = result.stdout.toString().trim()
        if (ip) return ip
      }
    } catch {
      // Try next path
    }
  }
  return null
}

function pruneOrphanedWsSessions(): void {
  if (!config.pruneWsSessions) {
    return
  }

  const prefix = `${config.tmuxSession}-ws-`
  if (!prefix) {
    return
  }

  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(
      ['tmux', ...withTmuxUtf8Flag([
        'list-sessions',
        '-F',
        buildTmuxFormat(['#{session_name}', '#{session_attached}']),
      ])],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      }
    )
    if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
      logger.warn('ws_session_prune_skipped', {
        reason: 'tmux_timeout',
        timeoutMs: config.tmuxTimeoutMs,
      })
      return
    }
  } catch {
    return
  }

  if (result.exitCode !== 0) {
    return
  }

  const output = result.stdout?.toString() ?? ''
  if (!output) {
    return
  }
  const lines = splitTmuxLines(output)
  let pruned = 0

  for (const line of lines) {
    const parts = splitTmuxFields(line, 2)
    if (!parts) continue
    const [name, attachedRaw] = parts
    if (!name || !name.startsWith(prefix)) continue
    const attached = Number.parseInt(attachedRaw ?? '', 10)
    if (Number.isNaN(attached) || attached > 0) continue
    try {
      const killResult = Bun.spawnSync(['tmux', 'kill-session', '-t', name], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      })
      if (killResult.signalCode === 'SIGTERM' || killResult.exitCode === null) {
        continue
      }
      if (killResult.exitCode === 0) {
        pruned += 1
      }
    } catch {
      // Ignore kill errors
    }
  }

  if (pruned > 0) {
    logger.info('ws_sessions_pruned', { count: pruned })
  }
}

const MAX_DIRECTORY_ENTRIES = 200

function createConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

checkPortAvailable(config.port)
ensureTmux()
const resolvedTerminalMode = resolveTerminalMode()
logger.info('terminal_mode_resolved', {
  configured: config.terminalMode,
  resolved: resolvedTerminalMode,
})

const app = new Hono()
const db = initDatabase()

// Read mouse mode setting from DB (default: true)
const TMUX_MOUSE_MODE_KEY = 'tmux_mouse_mode'
const storedMouseMode = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
const initialMouseMode = storedMouseMode === null ? true : storedMouseMode === 'true'

// Read history max age hours setting from DB (default: 24). Keep the DB key
// stable so existing settings survive the rename from Inactive to History.
const HISTORY_MAX_AGE_HOURS_KEY = 'inactive_max_age_hours'
const storedHistoryMaxAgeHours = db.getAppSetting(HISTORY_MAX_AGE_HOURS_KEY)
let runtimeHistoryMaxAgeHours = storedHistoryMaxAgeHours !== null
  ? Number(storedHistoryMaxAgeHours)
  : config.historySessionMaxAgeHours
if (!Number.isFinite(runtimeHistoryMaxAgeHours) || runtimeHistoryMaxAgeHours < 1) {
  runtimeHistoryMaxAgeHours = 24
}

// Read prefer-window-name setting from DB. The env var
// (AGENTBOARD_PREFER_WINDOW_NAME, already folded into config) is only the
// initial default; once set from the UI the stored value wins.
const PREFER_WINDOW_NAME_KEY = 'prefer_window_name'
const storedPreferWindowName = db.getAppSetting(PREFER_WINDOW_NAME_KEY)
if (storedPreferWindowName !== null) {
  config.preferWindowName = storedPreferWindowName === 'true'
}

// Read the global terminal color setting from DB. Enabled by default so an
// ambient NO_COLOR on the Agentboard process does not flatten every managed
// terminal. Once saved from the UI, the persisted value wins.
const TERMINAL_COLORS_ENABLED_KEY = 'terminal_colors_enabled'
const storedTerminalColorsEnabled = db.getAppSetting(TERMINAL_COLORS_ENABLED_KEY)
if (storedTerminalColorsEnabled !== null) {
  config.terminalColorsEnabled = storedTerminalColorsEnabled === 'true'
}

// Chat provider environment: the Settings override wins over
// AGENTBOARD_CHAT_ENV; read live by the chat manager at each SDK spawn.
const chatProviderEnv = createChatProviderEnvStore(db, config.chatProviderEnv)

const sessionManager = new SessionManager(undefined, {
  displayNameExists: (name, excludeSessionId) => db.displayNameExists(name, excludeSessionId),
  mouseMode: initialMouseMode,
  terminalColorsEnabled: config.terminalColorsEnabled,
})
// Ensure the base tmux session exists so listing/orphan logic has a real
// session to read from. SessionManager creates it with a placeholder window
// (filtered out of listings) when missing.
try {
  const ensureResult = sessionManager.ensureSession()
  // One-time: if an older agentboard booted the tmux daemon with leaked
  // launch env (NODE_ENV=production etc.), scrub it so new windows are clean.
  // Startup only — never per refresh tick (each unset is a tmux spawn).
  const scrubbedEnvVars = sessionManager.scrubLeakedGlobalEnvironment()
  if (scrubbedEnvVars.length > 0) {
    logger.info('tmux_global_env_scrubbed', { vars: scrubbedEnvVars })
  }
  if (ensureResult.canPruneWsSessions) {
    pruneOrphanedWsSessions()
  } else {
    logger.warn('ws_session_prune_skipped', {
      reason: 'session_group_lookup_unavailable',
    })
  }
} catch (error) {
  logger.warn('startup_ensure_session_failed', {
    message: error instanceof Error ? error.message : String(error),
  })
}

const registry = new SessionRegistry()

const sockets = new Set<ServerWebSocket<WSData>>()
const CLIPBOARD_BUFFER_POLL_MS = 750
const CLIPBOARD_BUFFER_MAX_BYTES = 512 * 1024
const CLIPBOARD_BUFFER_ARM_MS = 5000
const SGR_MOUSE_INPUT_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[<(\\d+);\\d+;\\d+[Mm]`,
  'g'
)

interface TmuxBufferSummary {
  name: string
  created: number
  size: number
  // Monotonic index parsed from tmux's automatic buffer name (buffer0001,
  // buffer0002, …); -1 for explicitly named buffers. Used as the recency
  // tiebreaker when buffer_created collides at whole-second resolution.
  order: number
  key: string
}

// Remote session service: poller, host statuses, SSH/tmux control plane,
// and the optimistic protection/tombstone/override maps (see remote/).
const remote = new RemoteSessionService({ registry, broadcast, send })

// Always-on raw protocol capture for the chat debug view, beside the DB.
const chatWireLogs = new ChatWireLogs({ dir: path.join(resolveDataDir(), 'chat-wire') })
// Worker-outcome sidecars for restart recovery (workers design D6), likewise
// beside the DB; kill removes a session's file with its record.
const chatWorkerStore = new ChatWorkerStore({ dir: path.join(resolveDataDir(), 'chat-workers') })
// SDK-driven chat sessions own their transcripts; log discovery must not
// surface those files as extra sessions (design D6).
const chatSessionManager = new ChatSessionManager({
  registry,
  db,
  onEvent: (sessionId, event) => chatConnections.publish(sessionId, event),
  onMailboxChange: (teamId, message) => chatConnections.publishMailbox(teamId, message),
  onCommandState: (sessionId, state) => chatConnections.publishCommandState(sessionId, state),
  onActivity: (sessionId, activity) => chatConnections.publishActivity(sessionId, activity),
  onContextUsage: (sessionId, usage) => chatConnections.publishContextUsage(sessionId, usage),
  onUsage: (profileId, report) => chatConnections.publishUsage(profileId, report),
  onWorkers: (sessionId, workers) => chatConnections.publishWorkers(sessionId, workers),
  getProviderEnv: chatProviderEnv.current,
  wireLogs: chatWireLogs,
  workerStore: chatWorkerStore,
  // Scoped workspace discovery after the agent moves (worktree tracking D2);
  // the closure runs only once a live agent reports a new cwd, by which time
  // the coordinator below exists.
  requestWorkspaceRefresh: (projectPath) => {
    fireAndForget(
      workspaceCoordinatorInstance.requestRefresh(projectPath),
      'workspaceChatCwdRefresh'
    )
  },
  ...(chatFixtureEnabled ? { queryFactory: fixtureQueryFactory, authCheck: () => true } : {}),
})
const chatConnections = new ChatConnections(chatSessionManager, chatWireLogs, message => broadcast(message))
if (chatFixtureEnabled && !registry.getAll().some(session => session.name === 'Chat fixture')) {
  const fixture = chatSessionManager.createSession({ projectPath: process.cwd(), name: 'Chat fixture' })
  if (fixture.ok) void chatSessionManager.send(fixture.session.id, 'Show an approval')
}
const chatPeers = new WeakMap<ServerWebSocket<WSData>, ChatConnection>()
function chatPeer(ws: ServerWebSocket<WSData>): ChatConnection {
  let peer = chatPeers.get(ws)
  if (!peer) {
    peer = { send: (message) => send(ws, message) }
    chatPeers.set(ws, peer)
  }
  return peer
}

const sessionRefreshWorker = new SessionRefreshWorkerClient()
const lastUserMessageWorker = new SessionRefreshWorkerClient()

const refresh = new SessionRefreshLoop({
  db,
  registry,
  sessionManager,
  sessionRefreshWorker,
  lastUserMessageWorker,
  broadcast: (message) => broadcast(message),
  mergeRemoteSessions: (sessions) => remote.mergeSessions(sessions),
  historyMaxAgeHours: () => runtimeHistoryMaxAgeHours,
})
// Session operation handlers (kill/rename/hibernate/wake/move-to-history)
// share this context; see src/server/sessions/.
const sessionOps: SessionOpsContext = {
  registry,
  db,
  sessionManager,
  refresh,
  chatSessionManager,
  broadcast,
  send,
  runRemoteTmux: (host, args) => remote.runTmux(host, args),
  remoteSessionNameOverrides: remote.remoteSessionNameOverrides,
  remoteSessionTombstones: remote.remoteSessionTombstones,
}

const logPoller = new LogPoller(db, registry, {
  onSessionOrphaned: (sessionId, supersededBy) => {
    refresh.updateDormantAgentSessions()
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({ type: 'session-orphaned', session: toAgentSession(session), supersededBy })
    }
  },
  onSessionActivated: (sessionId, window) => {
    refresh.updateDormantAgentSessions()
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({
        type: 'session-activated',
        session: toAgentSession(session),
        window,
      })
    }
  },
  onOrphanSessionsDiscovered: () => {
    refresh.updateDormantAgentSessions()
  },
  isLastUserMessageLocked: (tmuxWindow) => refresh.isLastUserMessageLocked(tmuxWindow),
  maxLogsPerPoll: config.logPollMax,
  rgThreads: config.rgThreads,
  matchProfile: config.logMatchProfile,
  matchWorker: config.logMatchWorker,
  getChatSdkSessionIds: () => chatSessionManager.getSdkSessionIds(),
})



refresh.logStartupState()
refresh.start()

// Update discovery: one checker per process, silent on every failure. The
// first check rides startup; later changes push to connected clients so the
// header chip can appear without a reload.
const updateChecker = startUpdateChecker({
  onChange: update => broadcast({ type: 'update-state', update }),
})

// Event loop lag monitor — detects when spawnSync or other blocking work
// starves the event loop, causing typing lag and slow WebSocket delivery.
if (logLevel === 'debug') {
  const EL_CHECK_MS = 500
  let elLastTick = performance.now()
  setInterval(() => {
    const now = performance.now()
    const lagMs = Math.round(now - elLastTick - EL_CHECK_MS)
    elLastTick = now
    if (lagMs > 100) {
      const [load1, load5, load15] = os.loadavg()
      logger.debug('event_loop_lag', {
        lagMs,
        load1: Math.round(load1 * 100) / 100,
        load5: Math.round(load5 * 100) / 100,
        load15: Math.round(load15 * 100) / 100,
        cpus: os.cpus().length,
      })
    }
  }, EL_CHECK_MS)
}


registry.on('session-update', (session) => {
  broadcast({ type: 'session-update', session })
})

registry.on('sessions', (sessions) => {
  broadcast({ type: 'sessions', sessions })
})

registry.on('session-removed', (sessionId) => {
  broadcast({ type: 'session-removed', sessionId })
})

registry.on('agent-sessions', ({ active, hibernating, history }) => {
  broadcast({ type: 'agent-sessions', active, hibernating, history })
})

registry.on('agent-sessions-active', (active) => {
  broadcast({ type: 'agent-sessions-active', active })
})

// Workspace discovery seeds: live local session paths plus persisted active,
// hibernating, and history agent-session paths. Remote sessions never seed
// local Git discovery (see design.md non-goals).
function collectWorkspaceSeeds(): string[] {
  const seeds = new Set<string>()
  for (const session of registry.getAll()) {
    if (session.remote || !session.projectPath) continue
    seeds.add(session.projectPath)
  }
  const agentSessions = registry.getAgentSessions()
  for (const group of [agentSessions.active, agentSessions.hibernating, agentSessions.history]) {
    for (const agentSession of group) {
      if (agentSession.host || !agentSession.projectPath) continue
      seeds.add(agentSession.projectPath)
    }
  }
  return [...seeds]
}

const workspaceCoordinatorInstance = new WorkspaceCoordinator({
  getSeeds: () => collectWorkspaceSeeds(),
  broadcast: (snapshot) => {
    broadcast({ type: 'workspace-snapshot', snapshot })
    workspaceWatcherInstance?.updateTargets(snapshot)
  },
})

// Filesystem watches for Git/OpenSpec metadata plus periodic reconciliation;
// watches are latency optimization, reconciliation is correctness (§4.3).
const workspaceWatcherInstance = new WorkspaceWatcher({
  host: createNodeWatcherHost(fsSync),
  onPathsChanged: (paths) => {
    fireAndForget(workspaceCoordinatorInstance.refreshPaths(paths), 'workspaceWatchRefresh')
  },
  onReconcile: () => {
    fireAndForget(workspaceCoordinatorInstance.reconcile(), 'workspaceReconcile')
  },
})

function refreshWorkspaceSeeds(): void {
  fireAndForget(workspaceCoordinatorInstance.requestRefresh(), 'workspaceSeedRefresh')
}

registry.on('sessions', () => refreshWorkspaceSeeds())
registry.on('agent-sessions', () => refreshWorkspaceSeeds())
refreshWorkspaceSeeds()

app.post('/api/client-log', async (c) => {
  try {
    const body = await c.req.json() as { level?: string; event: string; data?: Record<string, unknown> }
    const level = body.level === 'warn' || body.level === 'error' || body.level === 'info' ? body.level : 'debug'
    logger[level]('client_' + body.event, body.data)
  } catch {
    // ignore malformed
  }
  return c.json({ ok: true })
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/sessions', (c) => c.json(registry.getAll()))

app.get('/api/session-preview/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid session id' }, 400)
  }

  const DEFAULT_LIMIT = 200
  const MAX_LIMIT = 500
  // Treat a missing OR empty `?limit=` as absent — `'' ?? DEFAULT` keeps '', and
  // Number('') is 0, which would otherwise collapse the window to a single line.
  const limitQuery = c.req.query('limit')
  const rawLimit = limitQuery === undefined || limitQuery === ''
    ? DEFAULT_LIMIT
    : Number(limitQuery)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_LIMIT

  const record = db.getSessionById(sessionId)
  if (!record) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const logPath = record.logFilePath
  if (!logPath) {
    return c.json({ error: 'No log file for session' }, 404)
  }

  try {
    const stats = await fs.stat(logPath)
    if (!stats.isFile()) {
      return c.json({ error: 'Log file not found' }, 404)
    }

    const beforeLineQuery = c.req.query('beforeLine')
    // Missing or empty means "latest window"; a non-numeric value falls back to
    // the same (selectLineWindow treats a non-finite cursor as the end).
    const rawBeforeLine = beforeLineQuery === undefined || beforeLineQuery === ''
      ? Number.POSITIVE_INFINITY
      : Number(beforeLineQuery)
    const beforeByteQuery = c.req.query('beforeByte')
    const rawBeforeByte = beforeByteQuery === undefined || beforeByteQuery === ''
      ? undefined
      : Number(beforeByteQuery)
    const beforeByte = rawBeforeByte !== undefined && Number.isFinite(rawBeforeByte)
      ? Math.max(0, Math.trunc(rawBeforeByte))
      : undefined
    const lineWindow = await readLogLineWindow(
      logPath,
      stats,
      limit,
      rawBeforeLine,
      beforeByte
    )

    return c.json({
      sessionId,
      displayName: record.displayName,
      projectPath: record.projectPath,
      agentType: record.agentType,
      lastActivityAt: record.lastActivityAt,
      ...lineWindow,
    })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return c.json({ error: 'Log file not found' }, 404)
    }
    return c.json({ error: 'Unable to read log file' }, 500)
  }
})
app.get('/api/directories', async (c) => {
  const requestedPath = c.req.query('path') ?? '~'

  if (requestedPath.length > MAX_FIELD_LENGTH) {
    const payload: DirectoryErrorResponse = {
      error: 'invalid_path',
      message: 'Path too long',
    }
    return c.json(payload, 400)
  }

  const trimmedPath = requestedPath.trim()
  if (!trimmedPath) {
    const payload: DirectoryErrorResponse = {
      error: 'invalid_path',
      message: 'Path is required',
    }
    return c.json(payload, 400)
  }

  const start = Date.now()
  const resolved = resolveProjectPath(trimmedPath)

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(resolved)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path does not exist',
      }
      return c.json(payload, 404)
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Permission denied',
      }
      return c.json(payload, 403)
    }
    const payload: DirectoryErrorResponse = {
      error: 'internal_error',
      message: 'Unable to read directory',
    }
    return c.json(payload, 500)
  }

  if (!stats.isDirectory()) {
    const payload: DirectoryErrorResponse = {
      error: 'not_found',
      message: 'Path is not a directory',
    }
    return c.json(payload, 404)
  }

  let directories: DirectoryListing['directories'] = []
  try {
    const entries = await fs.readdir(resolved, {
      withFileTypes: true,
      encoding: 'utf8',
    })
    directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const name = entry.name.toString()
        return {
          name,
          path: path.join(resolved, name),
        }
      })
      .toSorted((a, b) => {
        const aDot = a.name.startsWith('.')
        const bDot = b.name.startsWith('.')
        if (aDot !== bDot) {
          return aDot ? -1 : 1
        }
        const aLower = a.name.toLowerCase()
        const bLower = b.name.toLowerCase()
        if (aLower < bLower) {
          return -1
        }
        if (aLower > bLower) {
          return 1
        }
        return a.name.localeCompare(b.name)
      })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Permission denied',
      }
      return c.json(payload, 403)
    }
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path does not exist',
      }
      return c.json(payload, 404)
    }
    const payload: DirectoryErrorResponse = {
      error: 'internal_error',
      message: 'Unable to list directory',
    }
    return c.json(payload, 500)
  }

  const truncated = directories.length > MAX_DIRECTORY_ENTRIES
  const limitedDirectories = truncated
    ? directories.slice(0, MAX_DIRECTORY_ENTRIES)
    : directories

  const root = path.parse(resolved).root
  const parent = resolved === root ? null : path.dirname(resolved)
  const response: DirectoryListing = {
    path: resolved,
    parent,
    directories: limitedDirectories,
    truncated,
  }

  const durationMs = Date.now() - start
  logger.debug('directories_request', {
    path: resolved,
    count: limitedDirectories.length,
    truncated,
    durationMs,
  })

  return c.json(response)
})

app.get('/api/server-info', (c) => {
  // For 0.0.0.0, detect Tailscale IP for display (already listening on all interfaces).
  // For localhost, only report if we successfully bound to the Tailscale IP.
  const tsIp = config.hostname === '0.0.0.0' ? getTailscaleIp() : boundTailscaleIp
  return c.json({
    port: config.port,
    tailscaleIp: tsIp,
    protocol: tlsEnabled ? 'https' : 'http',
    // Working directory of the server process; the fallback default project
    // directory for new sessions.
    cwd: process.cwd(),
    // AGENTBOARD_PROJECT_DIR, when set: takes precedence over cwd as the
    // default project directory. An explicit browser setting still wins.
    defaultProjectDir: config.defaultProjectDir,
    // Build version of this server (see ./version), shown in the UI.
    version: BUILD_VERSION,
    // Update availability (see ./updates); `target` is null while current.
    update: updateChecker.getState(),
  })
})

// The update verb (see ./updates): verify → download → swap → restart, driven
// from the discovery state the chip was rendered against. Refusals fail
// closed with the named error and leave the install unchanged.
const UPDATE_RESTART_DELAY_MS = 500
app.post('/api/update/install', async (c) => {
  const release = updateChecker.getRelease()
  if (updateChecker.getState().target === null || release === null) {
    return c.json({ error: 'No update is currently available' }, 409)
  }
  let install
  try {
    install = await installUpdate({ release })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    logger.error('update_install_refused', { message, tag: release.tag })
    return c.json({ error: message }, 500)
  }
  // Respond first: the restart verb may terminate this process (that is its
  // job), and the client must hear the outcome before the connection drops.
  // A source run restarts onto the installed release binary, not this
  // process; under systemd the unit itself is adopted into that install —
  // see restartAfterInstall.
  const context = detectRestartContext()
  const restartTimer = setTimeout(() => {
    void restartAfterInstall(context, install).catch((cause) => {
      // The install landed; only the takeover failed. Keep serving the old
      // build and log loudly — a manual restart picks up the new files.
      logger.error('update_restart_failed', {
        message: cause instanceof Error ? cause.message : String(cause),
        mode: context.mode,
      })
    })
  }, UPDATE_RESTART_DELAY_MS)
  restartTimer.unref?.()
  return c.json({ ok: true, restarting: true })
})

// Tmux mouse mode setting
app.get('/api/settings/tmux-mouse-mode', (c) => {
  const stored = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
  const enabled = stored === null ? true : stored === 'true'
  return c.json({ enabled })
})

app.put('/api/settings/tmux-mouse-mode', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousStored = db.getAppSetting(TMUX_MOUSE_MODE_KEY)
  const previousEnabled = previousStored === null ? true : previousStored === 'true'

  try {
    sessionManager.setMouseMode(body.enabled)
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      return c.json({ error: 'Timed out applying tmux mouse mode' }, 504)
    }
    logger.warn('tmux_mouse_mode_update_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to apply tmux mouse mode' }, 500)
  }

  try {
    db.setAppSetting(TMUX_MOUSE_MODE_KEY, String(body.enabled))
  } catch (error) {
    logger.warn('tmux_mouse_mode_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      sessionManager.setMouseMode(previousEnabled)
    } catch (rollbackError) {
      logger.warn('tmux_mouse_mode_rollback_failed', {
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      })
    }
    return c.json({ error: 'Unable to persist tmux mouse mode' }, 500)
  }

  return c.json({ enabled: body.enabled })
})

// Terminal ANSI color setting
app.get('/api/settings/terminal-colors', (c) => {
  return c.json({ enabled: config.terminalColorsEnabled })
})

app.put('/api/settings/terminal-colors', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousValue = config.terminalColorsEnabled
  try {
    sessionManager.setTerminalColors(body.enabled)
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      return c.json({ error: 'Timed out applying terminal colors' }, 504)
    }
    logger.warn('terminal_colors_update_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to apply terminal colors' }, 500)
  }

  config.terminalColorsEnabled = body.enabled
  try {
    db.setAppSetting(TERMINAL_COLORS_ENABLED_KEY, String(body.enabled))
  } catch (error) {
    config.terminalColorsEnabled = previousValue
    logger.warn('terminal_colors_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      sessionManager.setTerminalColors(previousValue)
    } catch (rollbackError) {
      logger.warn('terminal_colors_rollback_failed', {
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      })
    }
    return c.json({ error: 'Unable to persist terminal colors' }, 500)
  }

  return c.json({ enabled: body.enabled })
})

app.get('/api/settings/prefer-window-name', (c) => {
  return c.json({ enabled: config.preferWindowName })
})

app.put('/api/settings/prefer-window-name', async (c) => {
  let body: { enabled?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400)
  }

  const previousValue = config.preferWindowName
  config.preferWindowName = body.enabled
  try {
    db.setAppSetting(PREFER_WINDOW_NAME_KEY, String(body.enabled))
  } catch (error) {
    // Same contract as tmux-mouse-mode: never leave the runtime value
    // diverging from what will be restored after a restart.
    config.preferWindowName = previousValue
    logger.warn('prefer_window_name_persist_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'Unable to persist prefer window name' }, 500)
  }
  // Connected clients keep their own copy from the open-time server-config
  // message (mobile tab labels read it); rebroadcast so they all converge.
  broadcast({
    type: 'server-config',
    remoteAllowControl: config.remoteAllowControl,
    remoteAllowAttach: config.remoteAllowAttach,
    hostLabel: config.hostLabel,
    preferWindowName: config.preferWindowName,
    clientLogLevel: logLevel,
  })
  // Names are recomputed on refresh; schedule one so the sidebar updates
  // promptly instead of waiting for the next poll tick.
  refresh.scheduleEnterRefresh()
  return c.json({ enabled: body.enabled })
})

// History sessions max age setting. The inactive route is kept as a
// compatibility alias for older clients.
const getHistoryMaxAgeHours = (c: Context) => {
  return c.json({ hours: runtimeHistoryMaxAgeHours })
}

const putHistoryMaxAgeHours = async (c: Context) => {
  try {
    const body = await c.req.json()
    const hours = Number(body.hours)
    if (!Number.isFinite(hours) || hours < HISTORY_MAX_AGE_MIN_HOURS || hours > HISTORY_MAX_AGE_MAX_HOURS) {
      return c.json({ error: `hours must be a number between ${HISTORY_MAX_AGE_MIN_HOURS} and ${HISTORY_MAX_AGE_MAX_HOURS}` }, 400)
    }
    runtimeHistoryMaxAgeHours = hours
    db.setAppSetting(HISTORY_MAX_AGE_HOURS_KEY, String(hours))
    // Re-broadcast agent sessions with new max age
    refresh.updateDormantAgentSessions()
    return c.json({ hours })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
}

app.get('/api/settings/history-max-age-hours', getHistoryMaxAgeHours)
app.put('/api/settings/history-max-age-hours', putHistoryMaxAgeHours)
app.get('/api/settings/inactive-max-age-hours', getHistoryMaxAgeHours)
app.put('/api/settings/inactive-max-age-hours', putHistoryMaxAgeHours)

app.route('/api/settings/chat-provider-env', chatProviderEnv.routes)
app.route('/api/chat/profiles', createClaudeProfileRoutes())
app.route('/api/chat/groups', createTeamGroupRoutes())

// Allowed paste-image types; the extension written to /tmp comes from this map,
// never from client-supplied values. Note Bun's multipart parser derives
// File.type from the part filename's extension, not the declared blob type.
const pasteImageExtensionByMime = new Map([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

const macPasteboardSwiftScript = `
import AppKit
import Foundation

let maxBytes = Int(ProcessInfo.processInfo.environment["AGENTBOARD_PASTE_IMAGE_MAX_BYTES"] ?? "") ?? 0
let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"]

func emit(path: String?, isImage: Bool) {
  let payload: [String: Any?] = ["path": path, "isImage": isImage]
  let data = try! JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 })
  print(String(data: data, encoding: .utf8)!)
}

let pasteboard = NSPasteboard.general
let items = pasteboard.pasteboardItems ?? []

for item in items {
  if let fileURLString = item.string(forType: .fileURL),
     let url = URL(string: fileURLString),
     url.isFileURL {
    let path = url.path
    let lowerExt = url.pathExtension.lowercased()
    let hasImageType = item.types.contains(.png) || item.types.contains(.tiff)
    emit(path: path, isImage: hasImageType || imageExtensions.contains(lowerExt))
    exit(0)
  }
}

for item in items {
  if let data = item.data(forType: .png), data.count > 0, (maxBytes <= 0 || data.count <= maxBytes) {
    let path = NSTemporaryDirectory() + "agentboard-paste-" + UUID().uuidString + ".png"
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    emit(path: path, isImage: true)
    exit(0)
  }
}

emit(path: nil, isImage: false)
`

const MAC_PASTEBOARD_TIMEOUT_MS = 10000

function isImageFilePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(filePath)
}

app.route('/api/paste-file', createPasteFileRoutes())

// Image upload endpoint for iOS clipboard paste
app.post('/api/paste-image', async (c) => {
  // Early reject before buffering the multipart body. The header is
  // client-controlled, so image.size below remains the authoritative check.
  const contentLength = Number(c.req.header('content-length'))
  if (Number.isFinite(contentLength) && contentLength > config.pasteImageMaxBytes) {
    return c.json({ error: 'Image too large' }, 413)
  }

  try {
    const formData = await c.req.formData()
    const image = formData.get('image')
    if (!(image instanceof File)) {
      return c.json({ error: 'No image provided' }, 400)
    }
    if (image.size > config.pasteImageMaxBytes) {
      return c.json({ error: 'Image too large' }, 413)
    }
    const ext = pasteImageExtensionByMime.get(image.type)
    if (!ext) {
      return c.json({ error: 'Unsupported image type' }, 415)
    }

    // Generate unique filename in temp directory
    const filename = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const filepath = `/tmp/${filename}`
    await Bun.write(filepath, image)

    return c.json({ path: filepath })
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      500
    )
  }
})

// Get file path from macOS clipboard (for Finder file copies and screenshot apps).
// Browser paste events can hide AppKit pasteboard types such as public.file-url
// and public.png, so this endpoint reads NSPasteboard directly.
app.get('/api/clipboard-file-path', async (c) => {
  if (process.platform !== 'darwin') {
    return c.json({ path: null, isImage: false })
  }
  try {
    // Finder file URLs do not need the Swift interpreter. Resolve them first
    // so cold Swift startup cannot delay ordinary document pastes.
    const fileProc = Bun.spawn(
      ['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'],
      { stdout: 'pipe', stderr: 'pipe', timeout: MAC_PASTEBOARD_TIMEOUT_MS }
    )
    const fileText = await new Response(fileProc.stdout).text()
    const fileExitCode = await fileProc.exited
    const filePath = fileText.trim()
    if (fileExitCode === 0 && filePath.startsWith('/')) {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        c.header('Cache-Control', 'no-store')
        return c.json({ path: filePath, isImage: isImageFilePath(filePath) })
      }
    }

    const proc = Bun.spawn(
      ['swift', '-e', macPasteboardSwiftScript],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: MAC_PASTEBOARD_TIMEOUT_MS,
        env: {
          ...process.env,
          AGENTBOARD_PASTE_IMAGE_MAX_BYTES: String(config.pasteImageMaxBytes),
        },
      }
    )
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode === 0) {
      const payload = JSON.parse(text) as { path?: unknown; isImage?: unknown }
      const filePath = typeof payload.path === 'string' ? payload.path : null
      // Verify the file actually exists
      if (filePath?.startsWith('/')) {
        const file = Bun.file(filePath)
        if (await file.exists()) {
          c.header('Cache-Control', 'no-store')
          return c.json({ path: filePath, isImage: payload.isImage === true })
        }
      }
    }

    return c.json({ path: null, isImage: false })
  } catch {
    return c.json({ path: null, isImage: false })
  }
})

const staticDir = process.env.AGENTBOARD_STATIC_DIR || './dist/client'
app.use('/*', serveStatic({ root: staticDir }))

const tlsEnabled = config.tlsCert && config.tlsKey
const tlsOptions = tlsEnabled
  ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } }
  : {}

function serverFetch(req: Request, server: Server<WSData>) {
  const url = new URL(req.url)
  if (url.pathname === '/ws') {
    const requestIp =
      typeof server.requestIP === 'function' ? server.requestIP(req) : null
    if (
      server.upgrade(req, {
        data: {
          terminal: null,
          currentSessionId: null,
          currentTmuxTarget: null,
          connectionId: createConnectionId(),
          remoteAddress: requestIp?.address ?? null,
          userAgent: req.headers.get('user-agent')?.slice(0, 200) ?? null,
          terminalHost: null,
          terminalAttachSeq: 0,
          lastAttachKey: null,
          lastAttachTs: 0,
          clipboardPollTimer: null,
          clipboardPollInFlight: false,
          lastClipboardBufferKey: null,
          clipboardBufferArmedUntil: 0,
          clipboardArmedAtSec: 0,
          clipboardWatchGen: 0,
          copyModeCheckInFlight: false,
          outputCoalescer: null,
        },
      })
    ) {
      return
    }
    return new Response('WebSocket upgrade failed', { status: 400 })
  }

  return app.fetch(req)
}

const websocketHandlers = {
  idleTimeout: 40,
  sendPings: true,
  // Off by default (design D3): per-frame deflate CPU lands on the
  // keystroke-echo path; AGENTBOARD_WS_DEFLATE=true restores it.
  perMessageDeflate: config.wsPerMessageDeflate,
  open(ws: ServerWebSocket<WSData>) {
    sockets.add(ws)
    // Coalesced terminal-output frames for this connection. `sockets.has(ws)`
    // is the authoritative open predicate — the close handler removes the
    // socket and disposes the coalescer.
    ws.data.outputCoalescer = new TerminalOutputCoalescer({
      send: (payload) => ws.send(payload),
      isOpen: () => sockets.has(ws),
    })
    send(ws, { type: 'sessions', sessions: registry.getAll() })
    send(ws, { type: 'host-status', hosts: remote.getHostStatuses() })
    send(ws, {
      type: 'server-config',
      remoteAllowControl: config.remoteAllowControl,
      remoteAllowAttach: config.remoteAllowAttach,
      hostLabel: config.hostLabel,
      preferWindowName: config.preferWindowName,
      clientLogLevel: logLevel,
    })
    const agentSessions = registry.getAgentSessions()
    send(ws, {
      type: 'agent-sessions',
      active: agentSessions.active,
      hibernating: agentSessions.hibernating,
      history: agentSessions.history,
    })
    const workspaceSnapshot = workspaceCoordinatorInstance.getSnapshot()
    if (workspaceSnapshot) {
      send(ws, { type: 'workspace-snapshot', snapshot: workspaceSnapshot })
    }
    initializePersistentTerminal(ws)
  },
  message(ws: ServerWebSocket<WSData>, message: string | BufferSource) {
    handleMessage(ws, message)
  },
  close(ws: ServerWebSocket<WSData>) {
    const peer = chatPeers.get(ws)
    if (peer) chatConnections.disconnect(peer)
    cleanupTerminals(ws)
    ws.data.outputCoalescer?.dispose()
    ws.data.outputCoalescer = null
    sockets.delete(ws)
  },
}

Bun.serve<WSData>({
  port: config.port,
  hostname: config.hostname,
  ...tlsOptions,
  fetch: serverFetch,
  websocket: websocketHandlers,
})

// When bound to localhost, also listen on the Tailscale interface if available.
// This allows remote access over Tailscale without exposing the LAN interface.
let boundTailscaleIp: string | null = null
if (config.hostname === '127.0.0.1') {
  const detectedIp = getTailscaleIp()
  if (detectedIp) {
    try {
      Bun.serve<WSData>({
        port: config.port,
        hostname: detectedIp,
        ...tlsOptions,
        fetch: serverFetch,
        websocket: websocketHandlers,
      })
      boundTailscaleIp = detectedIp
    } catch (error) {
      logger.warn('tailscale_bind_failed', {
        ip: detectedIp,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

const protocol = tlsEnabled ? 'https' : 'http'
const displayHost = config.hostname === '0.0.0.0' ? 'localhost' : config.hostname
logger.info('server_started', {
  url: `${protocol}://${displayHost}:${config.port}`,
  tailscaleUrl: (() => {
    // For 0.0.0.0, detect Tailscale for display only (already listening on all interfaces).
    // For localhost, only show if we successfully bound to the Tailscale IP.
    const tsIp = boundTailscaleIp ?? (config.hostname === '0.0.0.0' ? getTailscaleIp() : null)
    return tsIp ? `${protocol}://${tsIp}:${config.port}` : null
  })(),
})

if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs, config.logWatchMode)
}
workspaceWatcherInstance.start()
void refresh.completeStartupVerification()

// Cleanup all terminals on server shutdown
async function cleanupAllTerminals() {
  const disposePromises: Promise<void>[] = []
  for (const ws of sockets) {
    if (ws.data.terminal) {
      disposePromises.push(ws.data.terminal.dispose())
      ws.data.terminal = null
    }
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
    ws.data.terminalHost = null
    clearAttachDedup(ws)
  }
  await Promise.allSettled(disposePromises)
  workspaceWatcherInstance.stop()
  logPoller.stop()
  remote.stop()
  chatSessionManager.shutdown()
  db.close()
}

process.on('SIGINT', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

/** Clear attach dedup state so a new/replacement proxy doesn't inherit stale history. */
function clearAttachDedup(ws: ServerWebSocket<WSData>) {
  ws.data.lastAttachKey = null
  ws.data.lastAttachTs = 0
}

function parseTmuxBufferSummaries(output: string): TmuxBufferSummary[] {
  const summaries: TmuxBufferSummary[] = []
  for (const line of splitTmuxLines(output)) {
    const parts = splitTmuxFields(line, 3)
    if (!parts) continue
    const name = parts[0]?.trim()
    const created = Number.parseInt(parts[1] ?? '', 10)
    const size = Number.parseInt(parts[2] ?? '', 10)
    if (!name || !Number.isFinite(created) || !Number.isFinite(size)) continue
    // Only tmux's automatic buffers (buffer0001, buffer0002, …) carry a
    // monotonic index. Explicitly named buffers (e.g. set-buffer -b snippet5)
    // get -1 so their trailing digits don't masquerade as recency.
    const orderMatch = name.match(/^buffer(\d+)$/)
    const order = orderMatch ? Number.parseInt(orderMatch[1], 10) : -1
    summaries.push({
      name,
      created,
      size,
      order,
      key: `${name}:${created}:${size}`,
    })
  }
  // Newest first. tmux's #{buffer_created} is whole-second resolution, so when
  // two buffers share a second, tiebreak by the monotonic automatic-buffer
  // index (buffer0002 newer than buffer0001) rather than size, which carries
  // no recency information.
  summaries.sort((a, b) => b.created - a.created || b.order - a.order || b.size - a.size)
  return summaries
}

async function readLatestTmuxBufferSummary(): Promise<TmuxBufferSummary | null> {
  const stdout = await readTmuxCapture([
    'list-buffers',
    '-F',
    buildTmuxFormat(['#{buffer_name}', '#{buffer_created}', '#{buffer_size}']),
  ])
  if (stdout === null) return null
  return parseTmuxBufferSummaries(stdout)[0] ?? null
}

async function readTmuxBufferText(summary: TmuxBufferSummary): Promise<string | null> {
  if (summary.size <= 0 || summary.size > CLIPBOARD_BUFFER_MAX_BYTES) {
    return null
  }
  const text = await readTmuxCapture(['show-buffer', '-b', summary.name])
  if (text === null) return null
  return text.trim() ? text : null
}

function stopClipboardBufferWatch(ws: ServerWebSocket<WSData>) {
  if (ws.data.clipboardPollTimer !== null) {
    clearInterval(ws.data.clipboardPollTimer)
  }
  // Bump the generation so any in-flight baseline read or poll from the watch
  // we're tearing down can't write back into a later watch on this socket.
  ws.data.clipboardWatchGen += 1
  ws.data.clipboardPollTimer = null
  ws.data.clipboardPollInFlight = false
  ws.data.lastClipboardBufferKey = null
  ws.data.clipboardBufferArmedUntil = 0
  ws.data.clipboardArmedAtSec = 0
}

function startClipboardBufferWatch(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  session: Session
) {
  stopClipboardBufferWatch(ws)

  if (session.remote) {
    return
  }

  const gen = ws.data.clipboardWatchGen
  ws.data.clipboardPollTimer = setInterval(() => {
    fireAndForget(pollClipboardBuffer(ws, sessionId, gen), 'pollClipboardBuffer')
  }, CLIPBOARD_BUFFER_POLL_MS)
  // Establish the baseline asynchronously so a pre-existing buffer isn't offered
  // on the first poll. Skip if this watch was already armed (a copy may have
  // landed before the read resolved — don't watermark the user's own buffer;
  // the created-time gate handles a genuinely pre-existing one) or superseded.
  fireAndForget(
    (async () => {
      const initial = await readLatestTmuxBufferSummary()
      if (
        ws.data.clipboardWatchGen === gen &&
        ws.data.lastClipboardBufferKey === null &&
        ws.data.clipboardBufferArmedUntil === 0
      ) {
        ws.data.lastClipboardBufferKey = initial?.key ?? null
      }
    })(),
    'clipboardBaseline'
  )
}

async function pollClipboardBuffer(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  gen: number
) {
  if (ws.data.clipboardWatchGen !== gen) return
  if (ws.data.clipboardPollInFlight) return
  if (!sockets.has(ws)) return
  if (ws.data.currentSessionId !== sessionId) return

  const session = registry.get(sessionId)
  if (!session || session.remote) return

  ws.data.clipboardPollInFlight = true
  try {
    const latest = await readLatestTmuxBufferSummary()
    // The read yields the event loop, so the watch may have been torn down or
    // the socket may have switched sessions while tmux ran. Re-validate before
    // touching state or offering.
    if (ws.data.clipboardWatchGen !== gen) return
    if (!sockets.has(ws) || ws.data.currentSessionId !== sessionId) return
    if (!latest) {
      ws.data.lastClipboardBufferKey = null
      return
    }
    if (latest.key === ws.data.lastClipboardBufferKey) {
      return
    }

    ws.data.lastClipboardBufferKey = latest.key
    if (Date.now() > ws.data.clipboardBufferArmedUntil) {
      logger.debug('clipboard_buffer_watermarked', {
        sessionId,
        bufferName: latest.name,
        bytes: latest.size,
        connectionId: ws.data.connectionId,
      })
      return
    }

    // Only offer buffers created at/after the arming gesture. A pre-existing or
    // unrelated (cross-window) buffer that becomes "latest" while armed has an
    // older creation time and is skipped, so it can't clobber the clipboard.
    if (latest.created < ws.data.clipboardArmedAtSec) {
      logger.debug('clipboard_buffer_precedes_arm', {
        sessionId,
        bufferName: latest.name,
        createdSec: latest.created,
        armedAtSec: ws.data.clipboardArmedAtSec,
        connectionId: ws.data.connectionId,
      })
      return
    }

    const text = await readTmuxBufferText(latest)
    if (!text) {
      logger.debug('clipboard_buffer_skipped', {
        sessionId,
        bufferName: latest.name,
        bytes: latest.size,
        connectionId: ws.data.connectionId,
      })
      return
    }

    // Re-validate again after the second tmux read before delivering, so we
    // never push a session A offer to a socket that has closed or moved to B.
    if (ws.data.clipboardWatchGen !== gen) return
    if (!sockets.has(ws) || ws.data.currentSessionId !== sessionId) return

    logger.debug('clipboard_buffer_offer', {
      sessionId,
      bufferName: latest.name,
      bytes: latest.size,
      connectionId: ws.data.connectionId,
    })
    send(ws, { type: 'clipboard-offer', sessionId, text, source: 'tmux-buffer' })
    ws.data.clipboardBufferArmedUntil = 0
    ws.data.clipboardArmedAtSec = 0
  } finally {
    // Only release the in-flight guard if the watch is still ours. If it was
    // stopped/restarted mid-poll, stopClipboardBufferWatch already reset the
    // guard for the new generation and we must not clear it out from under it.
    if (ws.data.clipboardWatchGen === gen) {
      ws.data.clipboardPollInFlight = false
    }
  }
}

// Arm the clipboard buffer watch on any left-button mouse event (press, drag,
// or release). This covers every selection style that copies to a tmux paste
// buffer — drag-select, double-click (word) and triple-click (line), which
// emit button-0 events with no motion bit. Bare taps also match, but they
// can't clobber the clipboard: the poll additionally requires the buffer to
// have been created at/after the gesture (see clipboardArmedAtSec), so a tap
// that copies nothing simply never produces an offer.
// SGR encoding: low 2 bits = button (0 = left), bits 6-7 (0xC0) = wheel/extended.
function containsClipboardArmingMouseInput(data: string): boolean {
  SGR_MOUSE_INPUT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SGR_MOUSE_INPUT_RE.exec(data)) !== null) {
    const button = Number(match[1])
    if ((button & 3) === 0 && (button & 0xc0) === 0) {
      return true
    }
  }
  return false
}

function cleanupTerminals(ws: ServerWebSocket<WSData>) {
  stopClipboardBufferWatch(ws)
  if (ws.data.terminal) {
    void ws.data.terminal.dispose()
    ws.data.terminal = null
  }
  ws.data.currentSessionId = null
  ws.data.currentTmuxTarget = null
  ws.data.terminalHost = null
  // Drop output buffered for the detached terminal; the coalescer itself stays
  // alive so a later attach on this still-open socket delivers output again.
  ws.data.outputCoalescer?.clearPending()
  clearAttachDedup(ws)
}

function broadcast(message: ServerMessage) {
  const payload = JSON.stringify(message)
  for (const socket of sockets) {
    // Drain pending terminal output first so a broadcast cannot overtake
    // output already queued for that connection.
    socket.data.outputCoalescer?.flush()
    socket.send(payload)
  }
}

function send(ws: ServerWebSocket<WSData>, message: ServerMessage) {
  const coalescer = ws.data.outputCoalescer
  if (!coalescer) {
    ws.send(JSON.stringify(message))
    return
  }
  if (message.type === 'terminal-output') {
    // Coalesced per connection: one frame per event-loop turn, with every
    // non-output message draining pending output first (see sendOrdered).
    coalescer.enqueue(message.sessionId, message.data)
    return
  }
  coalescer.sendOrdered(message)
}

function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    logger.error('unhandled_async_error', {
      context,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * Actionable error for a project path that disappeared between discovery
 * and submission. Names the owning worktree when one is known from the
 * latest snapshot so the user can tell which group went stale.
 */
function staleProjectPathError(missingPath: string): string {
  const worktreePaths =
    workspaceCoordinatorInstance.getSnapshot()?.repositories.flatMap((repository) =>
      repository.worktrees.map((worktree) => worktree.path)
    ) ?? []
  const owner = deepestPathMatch(canonicalizePath(missingPath), worktreePaths)
  if (owner) {
    return `Worktree no longer exists: ${owner}. It may have been removed outside Agentboard; workspace metadata is refreshing.`
  }
  return `Project path does not exist: ${missingPath}`
}

async function handleCreateWorktree(
  ws: ServerWebSocket<WSData>,
  payload: { repositoryId: string; branch: string; destination: string; launchSession?: boolean }
): Promise<void> {
  // Validated, non-forced git worktree add (§8.3). Refresh + broadcast of the
  // affected repository and launch routing happen in §8.4.
  const result = await createWorktree({
    repositoryId: payload.repositoryId,
    branch: payload.branch,
    destination: payload.destination,
  })
  send(ws, { type: 'workspace-operation-result', result })
  fireAndForget(
    workspaceCoordinatorInstance.requestRefresh(result.ok ? result.path : payload.destination),
    'workspaceRefreshAfterOperation'
  )
}

async function handleCreateChangeWorktree(
  ws: ServerWebSocket<WSData>,
  payload: { repositoryId: string; change: string }
): Promise<void> {
  // Seeded creation (§7.2) with immediate revalidation inside the operation
  // (§7.3): repository identity, destination nonexistence, and branch
  // assignment are re-read from Git right before the non-forced
  // `git worktree add`. The snapshot refreshes after every result — success
  // or failure — so the navigator never shows stale sections.
  const result = await createChangeWorktree({
    repositoryId: payload.repositoryId,
    change: payload.change,
  })
  send(ws, { type: 'workspace-operation-result', result })
  fireAndForget(
    workspaceCoordinatorInstance.requestRefresh(result.ok ? result.path : payload.repositoryId),
    'workspaceRefreshAfterChangeOperation'
  )
}

function handleMessage(
  ws: ServerWebSocket<WSData>,
  rawMessage: string | BufferSource
) {
  const text =
    typeof rawMessage === 'string'
      ? rawMessage
      : new TextDecoder().decode(rawMessage)

  let message: ClientMessage
  try {
    message = JSON.parse(text) as ClientMessage
  } catch {
    send(ws, { type: 'error', message: 'Invalid message payload' })
    return
  }

  switch (message.type) {
    case 'chat-attach':
    case 'chat-detach':
    case 'chat-send':
    case 'chat-interrupt':
    case 'chat-archive':
    case 'chat-restore':
    case 'chat-approval':
    case 'chat-answer':
    case 'chat-set-approval-policy':
    case 'chat-debug-open':
    case 'chat-debug-page':
    case 'chat-debug-close':
    case 'team-mailbox-open':
    case 'team-mailbox-close':
    case 'team-mailbox-cancel':
    case 'team-mailbox-retry':
    case 'team-mailbox-discard':
    case 'chat-worker-transcript':
      fireAndForget(chatConnections.handle(chatPeer(ws), message), 'chatMessage')
      return
    case 'ping':
      send(ws, message.seq != null ? { type: 'pong', seq: message.seq } : { type: 'pong' })
      return
    case 'session-refresh':
      refresh.refreshSessions()
      return
    case 'session-create':
      if (profileRequestError(message)) {
        send(ws, { type: 'error', message: profileRequestError(message)! })
        return
      }
      if (message.kind === 'chat') {
        // parseApprovalPolicy sanitizes the wire value: absent or unknown
        // reads as manual, so older clients are unchanged (design D3).
        const input = {
          projectPath: message.projectPath,
          name: message.name,
          ...(typeof message.cloneFromSessionId === 'string' ? { cloneFromSessionId: message.cloneFromSessionId } : {}),
          claudeProfileId: message.claudeProfileId,
          approvalPolicy: parseApprovalPolicy(message.approvalPolicy),
          ...(typeof message.groupId === 'string' && message.groupId.trim()
            ? { groupId: message.groupId.trim() }
            : {}),
        }
        fireAndForget(chatSessionManager.createAvailableSession(input).then(result => {
          if (result.ok) send(ws, { type: 'session-created', session: result.session })
          else send(ws, { type: 'error', message: result.error })
        }), 'createChatSession')
        return
      }
      if (message.host) {
        fireAndForget(
          remote.handleCreate(
            message.host,
            message.projectPath,
            message.name,
            message.command,
            message.autoStartAgent,
            message.autoStartChange,
            ws
          ),
          'handleRemoteCreate'
        )
      } else {
        try {
          // Compose the selected agent's apply prompt onto the start command
          // as a launch argument; no prompt when agent or change is absent.
          const startCommand = composeAutoStartCommand(
            message.command,
            message.autoStartAgent,
            message.autoStartChange
          )
          if (message.autoStartAgent && startCommand === message.command) {
            logger.info('auto_start_not_composed', {
              reason: 'unrecognized_agent_or_invalid_change',
            })
          }
          const created = stampLocalSession(sessionManager.createWindow(
            message.projectPath,
            message.name,
            startCommand
          ))
          // Add session to registry immediately so terminal can attach
          refresh.noteOptimisticMutation()
          const currentSessions = registry.getAll()
          registry.replaceSessions([created, ...currentSessions])
          refresh.refreshSessions()
          send(ws, { type: 'session-created', session: created })
        } catch (error) {
          // A directory that vanished between discovery and submission —
          // typically a worktree removed outside Agentboard — gets an
          // actionable, worktree-aware error plus a scoped workspace refresh
          // so the stale group reconciles without a page reload (§7.3).
          const resolvedPath = resolveProjectPath(message.projectPath)
          if (resolvedPath && !fsSync.existsSync(resolvedPath)) {
            send(ws, { type: 'error', message: staleProjectPathError(resolvedPath) })
            fireAndForget(
              workspaceCoordinatorInstance.requestRefresh(resolvedPath),
              'workspaceRefreshMissingPath'
            )
          } else {
            send(ws, {
              type: 'error',
              message:
                error instanceof Error ? error.message : 'Unable to create session',
            })
          }
        }
      }
      return
    case 'session-kill':
      fireAndForget(handleKill(sessionOps, message.sessionId, ws, message.source), 'handleKill')
      return
    case 'session-rename':
      fireAndForget(handleRename(sessionOps, message.sessionId, message.newName, ws), 'handleRename')
      return
	    case 'terminal-attach':
	      ws.data.terminalAttachSeq += 1
	      fireAndForget(attachTerminalPersistent(ws, message, ws.data.terminalAttachSeq), 'attachTerminalPersistent')
	      return
	    case 'terminal-detach':
	      detachTerminalPersistent(ws, message.sessionId)
	      return
    case 'terminal-input':
      handleTerminalInputPersistent(ws, message.sessionId, message.data)
      return
    case 'terminal-paste':
      handleTerminalPastePersistent(ws, message.sessionId, message.data)
      return
    case 'terminal-resize':
      handleTerminalResizePersistent(
        ws,
        message.sessionId,
        message.cols,
        message.rows
      )
      return
    case 'tmux-cancel-copy-mode':
      // Exit tmux copy-mode when user starts typing after scrolling
      fireAndForget(handleCancelCopyMode(message.sessionId, ws), 'handleCancelCopyMode')
      return
    case 'tmux-check-copy-mode':
      fireAndForget(handleCheckCopyMode(message.sessionId, ws), 'handleCheckCopyMode')
      return
    case 'session-wake':
      fireAndForget(handleSessionWake(sessionOps, message, ws), 'handleSessionWake')
      return
    case 'session-hibernate':
      handleSessionHibernate(sessionOps, message.sessionId, ws)
      return
    case 'session-move-to-history':
      handleMoveToHistory(sessionOps, message.sessionId, ws)
      return
    case 'workspace-refresh':
      fireAndForget(workspaceCoordinatorInstance.requestRefresh(message.projectPath), 'workspaceRefresh')
      return
    case 'create-worktree': {
      const payload = parseCreateWorktreePayload(message)
      if (!payload) {
        send(ws, { type: 'error', message: 'Invalid create-worktree payload' })
        return
      }
      fireAndForget(handleCreateWorktree(ws, payload), 'handleCreateWorktree')
      return
    }
    case 'create-change-worktree': {
      const payload = parseCreateChangeWorktreePayload(message)
      if (!payload) {
        send(ws, { type: 'error', message: 'Invalid create-change-worktree payload' })
        return
      }
      fireAndForget(handleCreateChangeWorktree(ws, payload), 'handleCreateChangeWorktree')
      return
    }
    default:
      send(ws, { type: 'error', message: 'Unknown message type' })
  }
}

function resolveCopyModeTarget(
  sessionId: string,
  ws: ServerWebSocket<WSData>,
  session: TerminalSession
): string {
  if (ws.data.currentSessionId === sessionId && ws.data.currentTmuxTarget) {
    return ws.data.currentTmuxTarget
  }
  return session.tmuxWindow
}

async function handleCancelCopyMode(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session || !isTerminalSession(session)) return
  if (session.remote && !config.remoteAllowAttach) return

  try {
    // Exit tmux copy-mode quietly. Async spawn: a sync spawnSync here stalls
    // the event loop (and with it keystroke dispatch + terminal streaming)
    // for the full command duration whenever the tmux server is slow.
    // NOTE: async also means a keystroke racing this cancel can reach tmux
    // first (worst case one key consumed by copy-mode navigation) — a race
    // that already existed on the remote path.
    const target = resolveCopyModeTarget(sessionId, ws, session)
    if (session.remote && session.host) {
      await remote.runTmux(session.host, ['send-keys', '-X', '-t', target, 'cancel'])
    } else {
      await readTmuxCapture(['send-keys', '-X', '-t', target, 'cancel'])
    }
  } catch {
    // Ignore errors - copy-mode may not be active
  }
}

async function handleCheckCopyMode(sessionId: string, ws: ServerWebSocket<WSData>) {
  const session = registry.get(sessionId)
  if (!session || !isTerminalSession(session)) return
  if (session.remote && !config.remoteAllowAttach) return
  // The client polls this every 750ms. With a loaded tmux server an async
  // probe can outlast that period; letting a second probe race the first
  // would let an older reply land after a newer one and stale-flip the
  // copy-mode state. Skip instead — the next poll delivers fresh state.
  if (ws.data.copyModeCheckInFlight) return
  ws.data.copyModeCheckInFlight = true

  // A probe can now outlive the attachment it was issued against (session
  // switch, detach, socket close). Capture generation + resolved target before
  // awaiting and discard the reply if either moved — the in-flight guard alone
  // cannot stop a probe for an old attachment from completing after a switch.
  const attachSeq = ws.data.terminalAttachSeq
  const target = resolveCopyModeTarget(sessionId, ws, session)

  try {
    // Query tmux for pane copy-mode status plus fullscreen-app detection:
    //   pane_in_mode  -> tmux copy-mode active
    //   alternate_on  -> pane on the alternate screen buffer
    //   mouse_any_flag-> the in-pane app requested mouse tracking (owns the mouse)
    // Async spawn (readTmuxCapture) rather than Bun.spawnSync: this runs on
    // the main event loop, and a sync spawn blocks keystroke dispatch and
    // terminal-output sends for the full command duration whenever the tmux
    // server is busy serving many windows.
    const fmt = '#{pane_in_mode},#{alternate_on},#{mouse_any_flag}'
    let output: string
    if (session.remote && session.host) {
      const result = await remote.runTmux(session.host, ['display-message', '-p', '-t', target, fmt])
      output = result.stdout?.trim() ?? ''
    } else {
      output = (await readTmuxCapture(['display-message', '-p', '-t', target, fmt]))?.trim() ?? ''
    }
    const [inCopyModeField, altScreenField, appMouseField] = output.split(',')
    const inCopyMode = inCopyModeField === '1'
    const altScreen = altScreenField === '1'
    const appMouse = appMouseField === '1'
    if (!copyModeReplyStillCurrent(ws, sessionId, attachSeq, target)) return
    send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode, altScreen, appMouse })
  } catch {
    // On error, assume not in copy mode and no fullscreen app
    if (!copyModeReplyStillCurrent(ws, sessionId, attachSeq, target)) return
    send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode: false, altScreen: false, appMouse: false })
  } finally {
    ws.data.copyModeCheckInFlight = false
  }
}

/**
 * True when a copy-mode probe's reply still describes the attachment it was
 * issued against: the socket is still open, no new attachment started, and the
 * resolved pane target is unchanged.
 */
function copyModeReplyStillCurrent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  attachSeq: number,
  target: string
): boolean {
  if (!sockets.has(ws)) return false
  if (ws.data.terminalAttachSeq !== attachSeq) return false
  const session = registry.get(sessionId)
  if (!session || !isTerminalSession(session)) return false
  return resolveCopyModeTarget(sessionId, ws, session) === target
}

function initializePersistentTerminal(ws: ServerWebSocket<WSData>) {
  if (ws.data.terminal) {
    return
  }

  const terminal = createPersistentTerminal(ws)
  ws.data.terminal = terminal

  void terminal.start().catch((error) => {
    ws.data.terminal = null
    clearAttachDedup(ws)
    handleTerminalError(ws, null, error, 'ERR_TMUX_ATTACH_FAILED')
  })
}

function createPersistentTerminal(ws: ServerWebSocket<WSData>) {
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = createTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: config.tmuxSession,
    monitorTargets: config.terminalMonitorTargets,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) {
        return
      }
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced (e.g. by SSH proxy)
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (sockets.has(ws)) {
        sendTerminalError(
          ws,
          sessionId,
          'ERR_TMUX_ATTACH_FAILED',
          'tmux client exited',
          true
        )
      }
    },
  })

  return terminal
}

function isTerminalAttachCurrent(ws: ServerWebSocket<WSData>, attachSeq: number): boolean {
  return ws.data.terminalAttachSeq === attachSeq
}

async function ensurePersistentTerminal(
  ws: ServerWebSocket<WSData>,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (!ws.data.terminal) {
    const created = createPersistentTerminal(ws)
    // If a newer attach/detach arrived while creating the proxy, dispose it.
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await created.dispose()
      return null
    }
    ws.data.terminal = created
  }

  const terminal = ws.data.terminal
  try {
    await terminal.start()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return null
    }
    return terminal
  } catch (error) {
    if (ws.data.terminal === terminal) {
      ws.data.terminal = null
      clearAttachDedup(ws)
    }
    throw error
  }
}

async function ensureCorrectProxyType(
  ws: ServerWebSocket<WSData>,
  session: Session,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  const needsSsh = session.remote === true && !!session.host
  const currentHost = ws.data.terminalHost

  // Same type — reuse existing proxy
  if (!needsSsh && !currentHost) {
    return ensurePersistentTerminal(ws, attachSeq)
  }
  if (needsSsh && currentHost === session.host) {
    if (ws.data.terminal) {
      const terminal = ws.data.terminal
      try {
        await terminal.start()
        if (!isTerminalAttachCurrent(ws, attachSeq)) {
          return null
        }
        return terminal
      } catch (error) {
        if (ws.data.terminal === terminal) {
          ws.data.terminal = null
          ws.data.terminalHost = null
          clearAttachDedup(ws)
        }
        throw error
      }
    }
  }

  // Type mismatch — dispose old proxy and create new one
  if (ws.data.terminal) {
    const oldTerminal = ws.data.terminal
    // Clear references BEFORE dispose so the onExit guard sees the proxy was replaced
    // (dispose triggers process exit → onExit callback, which checks ws.data.terminal !== terminal)
    if (isTerminalAttachCurrent(ws, attachSeq) && ws.data.terminal === oldTerminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      clearAttachDedup(ws)
    }
    await oldTerminal.dispose()
  }

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return null
  }

  if (needsSsh) {
    return createAndStartSshProxy(ws, session.host!, attachSeq)
  } else {
    return ensurePersistentTerminal(ws, attachSeq)
  }
}

async function createAndStartSshProxy(
  ws: ServerWebSocket<WSData>,
  host: string,
  attachSeq: number
): Promise<ITerminalProxy | null> {
  const sshOptions = remote.sshOptions()
  const sessionName = `${config.tmuxSession}-ws-${ws.data.connectionId}`

  const terminal = new SshTerminalProxy({
    connectionId: ws.data.connectionId,
    sessionName,
    baseSession: '', // not used for SSH standalone sessions
    host,
    sshOptions,
    commandTimeoutMs: config.remoteTimeoutMs,
    onData: (data) => {
      // Guard: ignore output from proxies that have been replaced.
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      if (!sessionId) return
      send(ws, { type: 'terminal-output', sessionId, data })
    },
    onExit: () => {
      // Guard: skip if this proxy was already replaced
      if (ws.data.terminal !== terminal) return
      const sessionId = ws.data.currentSessionId
      logger.warn('ssh_proxy_onExit', {
        sessionName,
        sessionId,
        host,
        connectionId: ws.data.connectionId,
      })
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
      void terminal.dispose()
      if (sockets.has(ws)) {
        sendTerminalError(ws, sessionId, 'ERR_TMUX_ATTACH_FAILED', 'SSH tmux client exited', true)
      }
    },
  })

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    await terminal.dispose()
    return null
  }

  ws.data.terminal = terminal
  ws.data.terminalHost = host

  try {
    await terminal.start()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      await terminal.dispose()
      return null
    }
    if (ws.data.terminal !== terminal) {
      // Another attach request replaced this proxy while it was starting.
      await terminal.dispose()
      return null
    }
    return terminal
  } catch (error) {
    if (ws.data.terminal === terminal) {
      ws.data.terminal = null
      ws.data.terminalHost = null
      clearAttachDedup(ws)
    }
    throw error
  }
}

async function attachTerminalPersistent(
  ws: ServerWebSocket<WSData>,
  message: Extract<ClientMessage, { type: 'terminal-attach' }>,
  attachSeq: number
) {
  const { sessionId, tmuxTarget, cols, rows } = message

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (!isValidSessionId(sessionId)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid session id', false)
    }
    return
  }

  const session = registry.get(sessionId)
  if (!session) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Session not found', false)
    }
    return
  }
  // Chat sessions have no tmux window to attach a terminal to; the client
  // renders ChatView for them and never sends terminal-attach, but refuse
  // cleanly if one arrives (e.g. stale tab).
  if (!isTerminalSession(session)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Chat sessions have no terminal', false)
    }
    return
  }
  if (session.remote && !config.remoteAllowAttach) {
    const host = session.host ? ` on ${session.host}` : ''
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', `Remote session${host} is read-only`, false)
    }
    return
  }
  stopClipboardBufferWatch(ws)

  const target = tmuxTarget ?? session.tmuxWindow
  if (!isValidTmuxTarget(target)) {
    if (isTerminalAttachCurrent(ws, attachSeq)) {
      sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid tmux target', false)
    }
    return
  }

  const t0 = performance.now()

  let terminal: ITerminalProxy | null = null
  try {
    terminal = await ensureCorrectProxyType(ws, session, attachSeq)
    if (!terminal) return
  } catch (error) {
    if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ws, sessionId, error, 'ERR_TMUX_ATTACH_FAILED')
    }
    return
  }

  const tProxy = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  if (typeof cols === 'number' && typeof rows === 'number') {
    terminal.resize(cols, rows)
  }

  const effectiveTarget = terminal.ensureEffectiveTarget(target)

  // Deduplicate rapid re-attaches to the same session+target (e.g. two
  // terminal-attach messages arriving within ~34ms).  Skip the expensive
  // scrollback capture and just acknowledge readiness.
  const attachKey = `${sessionId}:${effectiveTarget}`
  const now = performance.now()
  const ATTACH_DEDUP_MS = 500

  if (ws.data.lastAttachKey === attachKey &&
      now - ws.data.lastAttachTs < ATTACH_DEDUP_MS) {
    logger.debug('terminal_attach_dedup', {
      sessionId, target, effectiveTarget, attachSeq,
      elapsedMs: Math.round(now - ws.data.lastAttachTs),
      connectionId: ws.data.connectionId,
    })
    try {
      await terminal.switchTo(target)
      if (!isTerminalAttachCurrent(ws, attachSeq)) {
        return
      }
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      startClipboardBufferWatch(ws, sessionId, session)
      send(ws, { type: 'terminal-ready', sessionId })
    } catch (error) {
      if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
        handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
      }
    }
    return
  }

  // Capture scrollback history BEFORE switching to avoid race with live output
  const history = session.remote && session.host
    ? await remote.captureHistoryRemote(effectiveTarget, session.host)
    : await captureTmuxHistory(effectiveTarget)

  const tCapture = performance.now()

  if (!isTerminalAttachCurrent(ws, attachSeq)) {
    return
  }

  try {
    await terminal.switchTo(target, () => {
      if (!isTerminalAttachCurrent(ws, attachSeq)) return
      ws.data.currentSessionId = sessionId
      ws.data.currentTmuxTarget = effectiveTarget
      // Send history in chunks sized to fit TCP's initial congestion window
      // (~14.6KB). On high-latency connections (5G/Tailscale), the first chunk
      // arrives before slow start ramps up, letting the client render partial
      // content immediately instead of waiting for the full payload.
      if (history) {
        const HISTORY_CHUNK_SIZE = 12_000
        const tStr = performance.now()
        let totalBytes = 0
        let chunks = 0
        for (let offset = 0; offset < history.length; offset += HISTORY_CHUNK_SIZE) {
          const chunk = history.slice(offset, offset + HISTORY_CHUNK_SIZE)
          // Routed through send() so history chunks join the coalesced output
          // stream; the terminal-ready acknowledgement drains them first.
          send(ws, { type: 'terminal-output', sessionId, data: chunk })
          totalBytes += Buffer.byteLength(chunk, 'utf8')
          chunks += 1
        }
        const stringifyMs = Math.round(performance.now() - tStr)
        logger.debug('terminal_history_send', {
          sessionId,
          stringifyMs,
          payloadBytes: totalBytes,
          historyChars: history.length,
          chunks,
          connectionId: ws.data.connectionId,
        })
      }
    })
    // Yield to flush WebSocket buffers immediately after sending history.
    // Without this, Bun buffers the ws.send() data and doesn't flush until
    // the event loop is free — which can be seconds if other sync work follows.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const tSwitch = performance.now()
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    ws.data.currentSessionId = sessionId
    ws.data.currentTmuxTarget = effectiveTarget
    // Record dedup key only after successful switch — prevents a second
    // attach from hitting the dedup fast-path while the first is still in flight.
    ws.data.lastAttachKey = attachKey
    ws.data.lastAttachTs = performance.now()
    startClipboardBufferWatch(ws, sessionId, session)
    logger.info('terminal_attach_profile', {
      sessionId,
      target,
      effectiveTarget,
      remote: !!session.remote,
      proxyMs: Math.round(tProxy - t0),
      captureMs: Math.round(tCapture - tProxy),
      switchMs: Math.round(tSwitch - tCapture),
      totalMs: Math.round(tSwitch - t0),
      historyBytes: history?.length ?? 0,
      connectionId: ws.data.connectionId,
    })
    send(ws, { type: 'terminal-ready', sessionId })
  } catch (error) {
    if (!isTerminalAttachCurrent(ws, attachSeq)) {
      return
    }
    logger.warn('terminal_switch_failed', {
      sessionId,
      target,
      effectiveTarget,
      error: error instanceof Error ? error.message : String(error),
      connectionId: ws.data.connectionId,
    })
    if (sockets.has(ws) && isTerminalAttachCurrent(ws, attachSeq)) {
      handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
    }
  }
}

async function captureTmuxHistory(target: string): Promise<string | null> {
  try {
    // Capture only the visible pane so initial attach paints the current view
    // immediately instead of replaying the entire scrollback buffer.
    // Async spawn: this runs on the main event loop during attach, and a sync
    // spawnSync would block keystroke dispatch and output streaming for the
    // full capture duration on text-heavy panes.
    const colorArgs = config.terminalColorsEnabled ? ['-e'] : []
    const output = await readTmuxCapture([
      'capture-pane',
      '-t',
      target,
      '-p',
      '-J',
      ...colorArgs,
    ])
    if (output === null) {
      return null
    }
    // Only return if there's actual content
    if (output.trim().length === 0) {
      return null
    }
    return normalizeCapturedHistory(output)
  } catch {
    return null
  }
}

function detachTerminalPersistent(ws: ServerWebSocket<WSData>, sessionId: string) {
  // Cancel any in-flight attach/switch operations so stale completions don't
  // clobber the newly-selected session.
  ws.data.terminalAttachSeq += 1
  stopClipboardBufferWatch(ws)
  if (ws.data.currentSessionId === sessionId) {
    ws.data.currentSessionId = null
    ws.data.currentTmuxTarget = null
  }
  // Clear dedup so a fast A→B→A switch doesn't skip scrollback for A
  clearAttachDedup(ws)
}

function handleTerminalInputPersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  if (!session?.remote && containsClipboardArmingMouseInput(data)) {
    const now = Date.now()
    ws.data.clipboardBufferArmedUntil = now + CLIPBOARD_BUFFER_ARM_MS
    // No slack: we arm here BEFORE forwarding the input to tmux below, so any
    // buffer this gesture creates is stamped at/after this whole second. A
    // slack would instead let a pre-existing buffer created just before the
    // gesture be mis-offered as the user's copy.
    ws.data.clipboardArmedAtSec = Math.floor(now / 1000)
  }

  ws.data.terminal?.write(data)

  // On Enter key: immediately set "working" status and schedule refresh
  if (data.includes('\r') || data.includes('\n')) {
    if (!session?.remote) {
      refresh.setForceWorking(sessionId)
      refresh.scheduleEnterRefresh()
      refresh.scheduleLastUserMessageCapture(sessionId)
    }
  }
}

function handleTerminalPastePersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  data: string
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  // Pasting stages text in the pane's input; it is NOT a submit, so unlike
  // terminal-input we deliberately skip the Enter/"working" status heuristics.
  ws.data.terminal?.paste(data)
}

function handleTerminalResizePersistent(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  cols: number,
  rows: number
) {
  if (sessionId !== ws.data.currentSessionId) {
    return
  }

  const session = registry.get(sessionId)
  if (session?.remote && !config.remoteAllowAttach) return

  ws.data.terminal?.resize(cols, rows)
}


function sendTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  code: TerminalErrorCode,
  message: string,
  retryable: boolean
) {
  logger.warn('sending_terminal_error', {
    sessionId,
    code,
    message,
    retryable,
    connectionId: ws.data.connectionId,
  })
  send(ws, {
    type: 'terminal-error',
    sessionId,
    code,
    message,
    retryable,
  })
}

function handleTerminalError(
  ws: ServerWebSocket<WSData>,
  sessionId: string | null,
  error: unknown,
  fallbackCode: TerminalErrorCode
) {
  if (error instanceof TerminalProxyError) {
    sendTerminalError(ws, sessionId, error.code, error.message, error.retryable)
    return
  }

  const message =
    error instanceof Error ? error.message : 'Terminal operation failed'
  sendTerminalError(ws, sessionId, fallbackCode, message, true)
}

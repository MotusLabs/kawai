// Server entry point and composition root: Hono routes, the WebSocket
// protocol (sessions, chat, terminal streaming), log-content caching, remote
// session merge, and update wiring all start here.
import { createClaudeProfileRoutes, profileRequestError } from './routes/claudeProfiles'
import { createTeamGroupRoutes } from './routes/teamGroups'
import type { Server, ServerWebSocket } from 'bun'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { createPasteFileRoutes } from './routes/pasteFile'
import { createSettingsRoutes, loadStoredSettings } from './routes/settings'
import { createSessionPreviewRoutes } from './routes/sessionPreview'
import { createDirectoryRoutes } from './routes/directories'
import { createServerInfoRoutes, getTailscaleIp } from './routes/serverInfo'
import { createUpdateInstallRoutes } from './routes/updateInstall'
import { createPasteRoutes } from './routes/paste'
import { createChatProviderEnvStore } from './routes/chatProviderEnv'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { startUpdateChecker } from './updates/updateChecker'
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
import { resolveTerminalMode } from './terminal'
import { TerminalOutputCoalescer } from './terminal/outputCoalescer'
import { resolveProjectPath } from './paths'
import type { ClientMessage } from '../shared/types'
import { logger, logLevel } from './logger'
import {
  SessionRefreshWorkerClient,
} from './sessionRefreshWorkerClient'
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
import { SessionRefreshLoop } from './refresh/SessionRefreshLoop'
import type { WSData } from './ws/wsTypes'
import { ConnectionHub, createConnectionId, fireAndForget } from './ws/ConnectionHub'
import type { ClipboardWatchContext } from './ws/clipboardWatch'
import { handleCancelCopyMode, handleCheckCopyMode, type CopyModeContext } from './ws/copyMode'
import { clearAttachDedup, initializePersistentTerminal } from './ws/terminalProxy'
import {
  attachTerminalPersistent,
  cleanupTerminals,
  detachTerminalPersistent,
  handleTerminalInputPersistent,
  handleTerminalPastePersistent,
  handleTerminalResizePersistent,
  type TerminalAttachContext,
} from './ws/terminalAttach'
import { handleKill } from './sessions/kill'
import { handleRename } from './sessions/rename'
import { handleSessionHibernate } from './sessions/hibernate'
import { handleMoveToHistory } from './sessions/moveToHistory'
import { handleSessionWake } from './sessions/wake'
import type { SessionOpsContext } from './sessions/context'
import { stampLocalSession } from './sessionStamp'
import { RemoteSessionService } from './remote/RemoteSessionService'
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

checkPortAvailable(config.port)
ensureTmux()
const resolvedTerminalMode = resolveTerminalMode()
logger.info('terminal_mode_resolved', {
  configured: config.terminalMode,
  resolved: resolvedTerminalMode,
})

const app = new Hono()
const db = initDatabase()

// Persisted settings: mouse mode and history max age seed runtime state;
// prefer-window-name and terminal colors fold into config (see routes/settings).
const storedSettings = loadStoredSettings(db)
const initialMouseMode = storedSettings.initialMouseMode
let runtimeHistoryMaxAgeHours = storedSettings.historyMaxAgeHours

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

// WebSocket connection hub: open sockets plus the broadcast/send primitives
// every module reaches clients through (see ws/ConnectionHub).
const hub = new ConnectionHub()
const { sockets, broadcast, send } = hub

// Remote session service: poller, host statuses, SSH/tmux control plane,
// and the optimistic protection/tombstone/override maps (see remote/).
const remote = new RemoteSessionService({ registry, broadcast, send })

// Per-socket clipboard buffer watch and tmux copy-mode sync (see ws/).
const clipboardCtx: ClipboardWatchContext = { registry, hub }
const copyModeCtx: CopyModeContext = {
  registry,
  hub,
  runRemoteTmux: (host, args) => remote.runTmux(host, args),
}

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
  onRoutingRulesLoaded: () => chatConnections.publishRoutingRules(),
  onTaskChange: teamId => chatConnections.publishTasks(teamId),
  onCommandState: (sessionId, state) => chatConnections.publishCommandState(sessionId, state),
  onActivity: (sessionId, activity) => chatConnections.publishActivity(sessionId, activity),
  onContextUsage: (sessionId, usage) => chatConnections.publishContextUsage(sessionId, usage),
  onUsage: (profileId, report) => chatConnections.publishUsage(profileId, report),
  onWorkers: (sessionId, workers) => chatConnections.publishWorkers(sessionId, workers),
  onNotifications: (sessionId, notifications) =>
    chatConnections.publishNotifications(sessionId, notifications),
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
// Terminal attach/detach/input over each socket's tmux proxy (see ws/).
const terminalCtx: TerminalAttachContext = {
  hub,
  remote,
  registry,
  refresh,
  clipboard: clipboardCtx,
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

// Account-notice slow recheck (notification strip design D3): every 30
// minutes, re-read the credentials of every session with an attached client,
// so a renewal or a rolled-over day count shows without a reattach. Attach
// and agent start check too; this timer only closes the gap between them.
const ACCOUNT_NOTICE_RECHECK_MS = 30 * 60 * 1000
const accountNoticeTimer = setInterval(() => {
  chatSessionManager.recheckAccountNotices(chatConnections.subscribedSessionIds())
}, ACCOUNT_NOTICE_RECHECK_MS)
accountNoticeTimer.unref?.()

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


hub.wireRegistry(registry)

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

const tlsEnabled = config.tlsCert && config.tlsKey
const tlsOptions = tlsEnabled
  ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } }
  : {}

// When bound to localhost, the server also listens on the Tailscale interface
// if available (see below); server-info reports that address.
let boundTailscaleIp: string | null = null

app.route('/api', createServerInfoRoutes({
  getBoundTailscaleIp: () => boundTailscaleIp,
  tlsEnabled: Boolean(tlsEnabled),
  updateChecker,
}))
app.get('/api/sessions', (c) => c.json(registry.getAll()))

app.route('/api/session-preview', createSessionPreviewRoutes({ db }))
app.route('/api/directories', createDirectoryRoutes())

app.route('/api/update', createUpdateInstallRoutes({ updateChecker }))
app.route('/api/settings', createSettingsRoutes({
  db,
  sessionManager,
  refresh,
  broadcast,
  historyMaxAgeHours: {
    get: () => runtimeHistoryMaxAgeHours,
    set: (hours) => { runtimeHistoryMaxAgeHours = hours },
  },
}))

app.route('/api/settings/chat-provider-env', chatProviderEnv.routes)
app.route('/api/chat/profiles', createClaudeProfileRoutes())
app.route('/api/chat/groups', createTeamGroupRoutes({
  groupProfileCounts: (teamId, groupId) => chatSessionManager.groupProfileCounts(teamId, groupId),
}))

app.route('/api/paste-file', createPasteFileRoutes())

app.route('/api', createPasteRoutes())

const staticDir = process.env.AGENTBOARD_STATIC_DIR || './dist/client'
app.use('/*', serveStatic({ root: staticDir }))

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
    initializePersistentTerminal(terminalCtx, ws)
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
  clearInterval(accountNoticeTimer)
  chatSessionManager.shutdown()
  db.close()
}

process.on('SIGINT', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  void cleanupAllTerminals().finally(() => process.exit(0))
})

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
    case 'team-mailbox-reload-rules':
    case 'team-mailbox-hand-off':
    case 'team-tasks-open':
    case 'team-tasks-close':
    case 'team-task-open':
    case 'team-task-close':
    case 'team-task-create':
    case 'team-task-amend':
    case 'team-task-note':
    case 'team-task-status':
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
	      fireAndForget(attachTerminalPersistent(terminalCtx, ws, message, ws.data.terminalAttachSeq), 'attachTerminalPersistent')
	      return
	    case 'terminal-detach':
	      detachTerminalPersistent(ws, message.sessionId)
	      return
    case 'terminal-input':
      handleTerminalInputPersistent(terminalCtx, ws, message.sessionId, message.data)
      return
    case 'terminal-paste':
      handleTerminalPastePersistent(terminalCtx, ws, message.sessionId, message.data)
      return
    case 'terminal-resize':
      handleTerminalResizePersistent(
        terminalCtx,
        ws,
        message.sessionId,
        message.cols,
        message.rows
      )
      return
    case 'tmux-cancel-copy-mode':
      // Exit tmux copy-mode when user starts typing after scrolling
      fireAndForget(handleCancelCopyMode(copyModeCtx, message.sessionId, ws), 'handleCancelCopyMode')
      return
    case 'tmux-check-copy-mode':
      fireAndForget(handleCheckCopyMode(copyModeCtx, message.sessionId, ws), 'handleCheckCopyMode')
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

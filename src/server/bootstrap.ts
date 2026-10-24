// Composition root: startServer() builds every server singleton in one
// explicit, linear sequence — preflight, database and persisted settings,
// tmux session manager, registry, connection hub, remote sessions, chat,
// refresh loop, session ops, log poller, update checker, workspace discovery,
// HTTP routes, then Bun.serve (plus the optional Tailscale bind) — and owns
// the shutdown list run on SIGINT/SIGTERM. Nothing here lives at module
// scope: each call boots a fresh graph (the isolated index harness re-imports
// the entry per section and relies on that).
import { registerMetricsRoute } from './metrics/export/route'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { logger, logLevel } from './logger'
import { ensureTmux } from './prerequisites'
import { checkPortAvailable, pruneOrphanedWsSessions } from './startupPreflight'
import { initDatabase, resolveDataDir } from './db'
import { DatabaseStartupError } from './dbSafety/migrations'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { SessionRefreshWorkerClient } from './sessionRefreshWorkerClient'
import { resolveTerminalMode } from './terminal'
import { LogPoller } from './logPoller'
import { toAgentSession } from './agentSessions'
import { LogLineCache } from './logContent'
import { startUpdateChecker } from './updates/updateChecker'
import { ChatSessionManager } from './chat/ChatSessionManager'
import { ChatConnections, type ChatConnection } from './chat/ChatConnections'
import { ChatWireLogs } from './chat/ChatWireLogs'
import { ChatWorkerStore } from './chat/chatWorkerStore'
import { ChatTaskStore } from './chat/chatTaskStore'
import { chatFixtureEnabled, fixtureQueryFactory } from './chat/developmentFixture'
import { WorkspaceCoordinator } from './workspace/workspaceCoordinator'
import { WorkspaceWatcher, createNodeWatcherHost } from './workspace/workspaceWatcher'
import { SessionRefreshLoop } from './refresh/SessionRefreshLoop'
import { RemoteSessionService } from './remote/RemoteSessionService'
import type { SessionOpsContext } from './sessions/context'
import { createClaudeProfileRoutes } from './routes/claudeProfiles'
import { createTeamGroupRoutes } from './routes/teamGroups'
import { createChatSearchRoutes } from './routes/chatSearch'
import { createPlanWorkspaceAssetRoutes } from './routes/planWorkspaceAsset'
import { createPasteFileRoutes } from './routes/pasteFile'
import { createChatProviderEnvStore } from './routes/chatProviderEnv'
import { createSettingsRoutes, loadStoredSettings } from './routes/settings'
import { createSessionPreviewRoutes } from './routes/sessionPreview'
import { createDirectoryRoutes } from './routes/directories'
import { createServerInfoRoutes, getTailscaleIp } from './routes/serverInfo'
import { createUpdateInstallRoutes } from './routes/updateInstall'
import { createPasteRoutes } from './routes/paste'
import type { WSData } from './ws/wsTypes'
import { ConnectionHub, fireAndForget } from './ws/ConnectionHub'
import type { ClipboardWatchContext } from './ws/clipboardWatch'
import type { CopyModeContext } from './ws/copyMode'
import type { TerminalAttachContext } from './ws/terminalAttach'
import { clearAttachDedup } from './ws/terminalProxy'
import { handleMessage, type MessageRouterContext } from './ws/messageRouter'
import { createServerFetch, createWebSocketHandlers } from './ws/socketHandlers'

export function startServer(): void {
  // 1. Preflight: port free, tmux present, terminal mode resolved.
  checkPortAvailable(config.port)
  ensureTmux()
  const resolvedTerminalMode = resolveTerminalMode()
  logger.info('terminal_mode_resolved', {
    configured: config.terminalMode,
    resolved: resolvedTerminalMode,
  })

  // 2. Storage, persisted settings, and the tmux session manager.
  const app = new Hono()
  const db = openDatabaseOrExit()
  // Hourly online backups while the database changes (execution-safety-recovery D15).
  db.backups?.start()

  // Persisted settings: mouse mode and history max age seed runtime state;
  // prefer-window-name and terminal colors fold into config (see routes/settings).
  const storedSettings = loadStoredSettings(db)
  const initialMouseMode = storedSettings.initialMouseMode
  let runtimeHistoryMaxAgeHours = storedSettings.historyMaxAgeHours
  // The chat manager reads this live at each question (question-auto-answer D5).
  let runtimeQuestionAutoAnswerMinutes = storedSettings.questionAutoAnswerMinutes

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

  // 3. Session registry, client hub, and remote sessions.
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

  // 4. Chat sessions (their callbacks reach chatConnections lazily).
  // Always-on raw protocol capture for the chat debug view, beside the DB.
  const chatWireLogs = new ChatWireLogs({ dir: path.join(resolveDataDir(), 'chat-wire') })
  // Worker-outcome sidecars for restart recovery (workers design D6), likewise
  // beside the DB; kill removes a session's file with its record.
  const chatWorkerStore = new ChatWorkerStore({ dir: path.join(resolveDataDir(), 'chat-workers') })
  // Background-task-outcome sidecars (background tasks D6), same contract.
  const chatTaskStore = new ChatTaskStore({ dir: path.join(resolveDataDir(), 'chat-tasks') })
  // SDK-driven chat sessions own their transcripts; log discovery must not
  // surface those files as extra sessions (design D6).
  const chatSessionManager = new ChatSessionManager({
    registry,
    db,
    onEvent: (sessionId, event) => {
      chatConnections.publish(sessionId, event)
      // The workspace's request and turn triggers live in one mapping (team-workspace).
      chatConnections.observeChatEvent(sessionId, event)
    },
    // Live membership (team-workspace): create, archive, restore, kill, and
    // status/name/group/task moves refresh the team's workspace.
    onSessionRecordChange: sessionId => chatConnections.publishWorkspaceOf(sessionId),
    onMailboxChange: (teamId, message) => chatConnections.publishMailbox(teamId, message),
    onWaitingReasonsChange: teamId => chatConnections.publishMailbox(teamId),
    onRoutingRulesLoaded: () => chatConnections.publishRoutingRules(),
    onTaskChange: teamId => chatConnections.publishTasks(teamId),
    onStrategyChange: teamId => chatConnections.publishStrategies(teamId),
    onProcessReportChange: teamId => chatConnections.publishMetrics(teamId),
    onPlanChange: (teamId, planId) => chatConnections.publishPlans(teamId, planId),
    onOutboundChange: teamId => chatConnections.publishOutbound(teamId),
    backupStatus: () => db.backups?.status() ?? null,
    onCommandState: (sessionId, state) => chatConnections.publishCommandState(sessionId, state),
    onActivity: (sessionId, activity) => chatConnections.publishActivity(sessionId, activity),
    onContextUsage: (sessionId, usage) => chatConnections.publishContextUsage(sessionId, usage),
    onModel: (sessionId, model) => chatConnections.publishModel(sessionId, model),
    onUsage: (providerId, report) => chatConnections.publishUsage(providerId, report),
    onWorkers: (sessionId, workers) => chatConnections.publishWorkers(sessionId, workers),
    onBackgroundTasks: (sessionId, tasks) => chatConnections.publishBackgroundTasks(sessionId, tasks),
    onNotifications: (sessionId, notifications) =>
      chatConnections.publishNotifications(sessionId, notifications),
    getProviderEnv: chatProviderEnv.current,
    wireLogs: chatWireLogs,
    workerStore: chatWorkerStore,
    taskStore: chatTaskStore,
    // Scoped workspace discovery after the agent moves (worktree tracking D2);
    // the closure runs only once a live agent reports a new cwd, by which time
    // the coordinator below exists.
    requestWorkspaceRefresh: (projectPath) => {
      fireAndForget(
        workspaceCoordinatorInstance.requestRefresh(projectPath),
        'workspaceChatCwdRefresh'
      )
    },
    // Human team views may address any discovered repository, chat or not
    // (team-workspace-pages D1); read lazily, like the refresh above.
    workspaceRepositories: () =>
      workspaceCoordinatorInstance.getSnapshot()?.repositories.map(repository => repository.commonDir) ?? [],
    ...(chatFixtureEnabled ? { queryFactory: fixtureQueryFactory, authCheck: () => true } : {}),
  })
  const chatConnections = new ChatConnections(chatSessionManager, chatWireLogs, message => broadcast(message))
  // Restore persisted rows before checking whether the development fixture exists.
  void chatSessionManager.whenRestored().then(() => {
    if (!chatFixtureEnabled || registry.getAll().some(session => session.name === 'Chat fixture')) return
    const fixture = chatSessionManager.createSession({ projectPath: process.cwd(), name: 'Chat fixture' })
    if (fixture.ok) void chatSessionManager.send(fixture.session.id, 'Show an approval')
  })
  const chatPeers = new WeakMap<ServerWebSocket<WSData>, ChatConnection>()
  function chatPeer(ws: ServerWebSocket<WSData>): ChatConnection {
    let peer = chatPeers.get(ws)
    if (!peer) {
      peer = { send: (message) => send(ws, message) }
      chatPeers.set(ws, peer)
    }
    return peer
  }

  // 5. Refresh loop, session ops, terminal attach, log polling, timers.
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
    wakeInFlight: new Set<string>(),
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

  // 6. Registry -> client broadcasts, then workspace discovery.
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

  // 7. HTTP routes (static assets last).
  registerMetricsRoute(app, chatSessionManager.observations)
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

  app.route('/api/session-preview', createSessionPreviewRoutes({
    db,
    logLineCache: new LogLineCache(),
  }))
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
    questionAutoAnswerMinutes: {
      get: () => runtimeQuestionAutoAnswerMinutes,
      set: (minutes) => { runtimeQuestionAutoAnswerMinutes = minutes },
    },
  }))

  app.route('/api/settings/chat-provider-env', chatProviderEnv.routes)
  app.route('/api/chat/profiles', createClaudeProfileRoutes())
  app.route('/api/chat/groups', createTeamGroupRoutes({
    groupProfileCounts: (teamId, groupId) => chatSessionManager.groupProfileCounts(teamId, groupId),
  }))
  app.route('/api/chat/search', createChatSearchRoutes({ source: chatSessionManager }))
  // The plan workspace's scoped asset route (plan-workspace 2.3): membership
  // and containment before any read; mounted before the static fallback.
  app.route('/api', createPlanWorkspaceAssetRoutes({
    membership: {
      resolve: teamPath => chatSessionManager.teamScopes.resolve(teamPath),
      exists: (teamId, root) => chatSessionManager.tasks.worktrees.exists(teamId, root),
    },
  }))

  app.route('/api/paste-file', createPasteFileRoutes())

  app.route('/api', createPasteRoutes())

  const staticDir = process.env.AGENTBOARD_STATIC_DIR || './dist/client'
  app.use('/*', serveStatic({ root: staticDir }))

  // 8. WebSocket routing and Bun.serve; Bun.serve opens only after every
  // subsystem above exists.
  // WebSocket message routing and the Bun.serve handlers (see ws/).
  const messageRouter: MessageRouterContext = {
    hub,
    registry,
    sessionManager,
    refresh,
    chatSessionManager,
    chatConnections,
    chatPeer,
    remote,
    workspaceCoordinator: workspaceCoordinatorInstance,
    sessionOps,
    terminal: terminalCtx,
    copyMode: copyModeCtx,
  }
  const serverFetch = createServerFetch(app)
  const websocketHandlers = createWebSocketHandlers({
    hub,
    registry,
    remote,
    workspaceCoordinator: workspaceCoordinatorInstance,
    terminal: terminalCtx,
    chatConnections,
    existingChatPeer: (ws) => chatPeers.get(ws),
    handleMessage: (ws, message) => handleMessage(messageRouter, ws, message),
  })

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

  // 9. Shutdown list, run on SIGINT/SIGTERM.
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
    chatConnections.stop()
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
}

/**
 * Open the database, or exit with the owner's message when it must not start
 * (execution-safety-recovery D13–D14): a database newer than this build, or a
 * failed migration or pre-migration backup. There is no override.
 */
function openDatabaseOrExit(): ReturnType<typeof initDatabase> {
  try {
    return initDatabase()
  } catch (error) {
    if (!(error instanceof DatabaseStartupError)) throw error
    logger.error('database_start_refused', { message: error.message })
    console.error(error.message)
    process.exit(1)
  }
}

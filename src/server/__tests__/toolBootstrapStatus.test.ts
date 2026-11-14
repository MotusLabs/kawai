// F1: exercise bootstrap's actual callback assignment, not a harness equivalent.
// Real database, manager, team scopes, observation status, readers and transports.
// Doubled I/O modules: db (call-through capture only), ChatSessionManager and
// ChatConnections (call-through captures only), prerequisites, startupPreflight,
// terminal, SessionManager, sessionRefreshWorkerClient, refresh/SessionRefreshLoop,
// remote/RemoteSessionService, logPoller, workspace/workspaceCoordinator,
// workspace/workspaceWatcher, updates/updateChecker, routes/serverInfo (IP only),
// developmentFixture. Bun.serve and fetch are external boundaries; intervals
// keep their original cadence and only this startup's handles are cleared.
import { expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ServerMessage } from '../../shared/types'
import type { ChatSessionManager, ChatSessionManagerOptions } from '../chat/ChatSessionManager'
import type { ChatConnections } from '../chat/ChatConnections'
import type { SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { SessionRegistry } from '../SessionRegistry'

// @covers: team-process-metrics › Tool metrics › Status change reaches open views without a refresh
test('F1: production bootstrap pushes a status-only commit to both warm team subscriptions without refresh', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-bootstrap-status-')))
  const originalDbPath = process.env.AGENTBOARD_DB_PATH
  const originalFetch = globalThis.fetch
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const intervalSpy = spyOn(globalThis, 'setInterval') // Native call-through, with all overloads.
  const clearSpy = spyOn(globalThis, 'clearInterval')
  let ownedIntervalCount = 0
  let unclearedIntervals: unknown[] = []
  const signals = ['SIGINT', 'SIGTERM'] as const
  const listeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]))
  const modules: Array<{ name: string; original: Record<string, unknown> }> = []
  const externalStops: Array<() => void> = []
  const captured: {
    manager?: ChatSessionManager
    connections?: ChatConnections
    planIntervals: unknown[]
  } = { planIntervals: [] }
  let database: SessionDatabase | undefined
  let suppliedOptions: ChatSessionManagerOptions | undefined
  let served = 0, networkCalls = 0, queryCalls = 0, preflights = 0, stopped = 0

  async function replace(name: string, overrides: Record<string, unknown>) {
    const original = { ...await import(name) }
    modules.push({ name, original })
    mock.module(name, () => ({ ...original, ...overrides }))
  }
  class Stoppable {
    constructor() { externalStops.push(() => this.stop()) }
    start() {}
    stop() { stopped++ }
  }
  try {
    process.env.AGENTBOARD_DB_PATH = path.join(root, 'agentboard.db')
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign((): Promise<Response> => {
      networkCalls++
      return Promise.reject(new Error('No external requests in bootstrap composition test'))
    }, { preconnect: () => {
      networkCalls++
      throw new Error('No external preconnections in bootstrap composition test')
    } }))
    const { config } = await import('../config')
    function serveBoundary<WebSocketData = undefined, R extends string = never>(
      options: Bun.Serve.Options<WebSocketData, R>,
    ): Bun.Server<WebSocketData> {
      expect(options.port).toBe(config.port)
      expect(Reflect.get(options, 'fetch')).toBeFunction()
      expect(Reflect.get(options, 'websocket')).toBeObject()
      served++
      return {} as Bun.Server<WebSocketData> // No real listener is opened.
    }
    spyOn(Bun, 'serve').mockImplementation(serveBoundary)
    const dbModule = { ...await import('../db') }
    const open = dbModule.initDatabase
    await replace('../db', { initDatabase: (...args: Parameters<typeof open>) => {
      database = open(...args)
      return database
    } })
    const { ChatSessionManager: OriginalManager } = await import('../chat/ChatSessionManager')
    class CapturedManager extends OriginalManager {
      constructor(options: ChatSessionManagerOptions) {
        suppliedOptions = options
        super(options) // Same object from startServer; never adds or replaces callbacks.
        captured.manager = this
      }
    }
    await replace('../chat/ChatSessionManager', { ChatSessionManager: CapturedManager })
    const { ChatConnections: OriginalConnections } = await import('../chat/ChatConnections')
    class CapturedConnections extends OriginalConnections {
      constructor(...args: ConstructorParameters<typeof OriginalConnections>) {
        const first = intervalSpy.mock.results.length
        super(...args)
        captured.connections = this
        // Both real plan watchers start during this construction, before test cleanup.
        captured.planIntervals.push(...intervalSpy.mock.results.slice(first)
          .flatMap(result => result.type === 'return' ? [result.value] : []))
      }
    }
    await replace('../chat/ChatConnections', { ChatConnections: CapturedConnections })
    await replace('../prerequisites', { ensureTmux: () => { preflights++ } })
    await replace('../startupPreflight', {
      checkPortAvailable: (port: number) => { expect(port).toBe(config.port); preflights++ },
      pruneOrphanedWsSessions: () => { throw new Error('No tmux pruning expected') },
    })
    await replace('../terminal', { resolveTerminalMode: () => 'pty' })
    await replace('../SessionManager', { SessionManager: class {
      constructor(_unused: undefined, options: { mouseMode: boolean }) {
        expect(options.mouseMode).toBeBoolean()
      }
      ensureSession() { return { canPruneWsSessions: false } }
      scrubLeakedGlobalEnvironment() { return [] }
    } })
    await replace('../sessionRefreshWorkerClient', { SessionRefreshWorkerClient: class extends Stoppable {} })
    await replace('../refresh/SessionRefreshLoop', { SessionRefreshLoop: class extends Stoppable {
      constructor(options: { db: SessionDatabase; registry: SessionRegistry }) {
        super()
        expect(database).toBe(options.db)
        expect(options.registry).toBeInstanceOf(SessionRegistry)
      }
      logStartupState() {}
      updateDormantAgentSessions() {}
      isLastUserMessageLocked() { return false }
      async completeStartupVerification() {}
    } })
    await replace('../remote/RemoteSessionService', { RemoteSessionService: class extends Stoppable {
      remoteSessionNameOverrides = new Map()
      remoteSessionTombstones = new Set()
      constructor(options: { registry: SessionRegistry; broadcast: unknown; send: unknown }) {
        super()
        expect(options.registry).toBeInstanceOf(SessionRegistry)
        expect(options.broadcast).toBeFunction()
        expect(options.send).toBeFunction()
      }
    } })
    await replace('../logPoller', { LogPoller: class extends Stoppable {
      constructor(db: SessionDatabase, registry: SessionRegistry) {
        super()
        expect(database).toBe(db)
        expect(registry).toBeInstanceOf(SessionRegistry)
      }
    } })
    await replace('../workspace/workspaceCoordinator', { WorkspaceCoordinator: class {
      constructor(options: { getSeeds: unknown; broadcast: unknown }) {
        expect(options.getSeeds).toBeFunction()
        expect(options.broadcast).toBeFunction()
      }
      getSnapshot() { return null }
      async requestRefresh() {}
      async refreshPaths() {}
      async reconcile() {}
    } })
    await replace('../workspace/workspaceWatcher', {
      WorkspaceWatcher: class extends Stoppable { updateTargets() {} },
    })
    await replace('../updates/updateChecker', { startUpdateChecker: (options: { onChange: unknown }) => {
      expect(options.onChange).toBeFunction()
      return { getState: () => null }
    } })
    await replace('../routes/serverInfo', { getTailscaleIp: () => null })
    await replace('../chat/developmentFixture', { chatFixtureEnabled: false, fixtureQueryFactory: () => {
      queryCalls++
      throw new Error('No agent queries in bootstrap composition test')
    } })
    const { startServer } = await import('../bootstrap')
    startServer()
    const actual = captured.manager!, transport = captured.connections!, db = database!
    expect(actual).toBeInstanceOf(OriginalManager)
    expect(transport).toBeInstanceOf(OriginalConnections)
    expect(suppliedOptions?.db).toBe(db)
    expect(Reflect.get(actual, 'options')).toBe(suppliedOptions)
    expect(served).toBe(1)
    expect(preflights).toBe(2)
    await actual.whenRestored()

    const teams = [path.join(root, 'team-a'), path.join(root, 'team-b')]
    for (const [index, dir] of teams.entries()) {
      const result = spawnSync('git', ['init', '-q', dir], { env: cleanGitEnv(), encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      await actual.teams.track('bootstrap-' + index, dir)
      expect(actual.teams.teamOf('bootstrap-' + index)?.teamId).toBe(path.join(dir, '.git'))
    }
    await Bun.sleep(280) // Drain the real initial 250ms status notification.
    const sent: ServerMessage[] = []
    const connection = { send: (message: ServerMessage) => { sent.push(message) } }
    for (const teamPath of teams) await transport.handle(connection, {
      type: 'process-metrics-open', teamPath, window: '7d', slice: null,
    })
    const snapshots = () => sent.filter((m): m is Extract<ServerMessage, { type: 'process-metrics-snapshot' }> =>
      m.type === 'process-metrics-snapshot')
    expect(snapshots()).toHaveLength(2)
    const before = snapshots().slice(), count = sent.length
    for (const snapshot of before) {
      expect(snapshot.metrics.metrics.length).toBeGreaterThan(0)
      expect(snapshot.metrics.toolMeasurement.export.state).toBe('active')
    }
    expect(before.map(s => s.teamId)).toEqual(teams.map(dir => path.join(dir, '.git')))
    const read = spyOn(actual.metrics, 'read') // Call through, never fabricates a metric.
    db.db.transaction(() => {
      for (const family of ['task_stage_duration_seconds', 'task_acceptance_duration_seconds']) {
        const insert = db.db.prepare("INSERT INTO process_export_totals VALUES (?,?,'admitted',0)")
        for (let i = 0; i < 10000; i++) insert.run(family, JSON.stringify({ team: 'old-' + i }))
      }
    })()
    expect(actual.observations.toolExport.ensure()).toBe(true)
    expect(actual.observations.toolStatus().export).toMatchObject({
      state: 'budget-unavailable', reason: 'series-budget',
    })
    expect(JSON.parse(actual.observations.store.checkpoint('tool-export-v2')!).state).toBe('budget-unavailable')
    expect(sent).toHaveLength(count) // The committed change queues, rather than inventing a push.
    await Bun.sleep(280)
    const pushed = snapshots().slice(before.length)
    expect(pushed, 'bootstrap status-only commit reaches BOTH warm subscriptions').toHaveLength(2)
    expect(pushed.map(s => s.teamId)).toEqual(before.map(s => s.teamId))
    for (const [index, snapshot] of pushed.entries()) {
      expect(snapshot.metrics.toolMeasurement).toEqual(actual.observations.toolStatus())
      expect(snapshot.metrics.metrics).toBe(before[index]!.metrics.metrics)
      expect(snapshot.metrics.computedAt).toBe(before[index]!.metrics.computedAt)
      expect(before[index]!.metrics.toolMeasurement.export.state).toBe('active')
    }
    expect(read.mock.calls).toEqual(before.map(snapshot => [snapshot.teamId, '7d', null, { fresh: false }]))
    expect(suppliedOptions?.onToolMeasurementStatusChange).toBeFunction()
    expect(networkCalls).toBe(0)
    expect(queryCalls).toBe(0)
  } finally {
    try {
      captured.connections?.stop()
      if (captured.connections) {
        const productionClears = new Set<unknown>(clearSpy.mock.calls.map(call => call[0]))
        expect(captured.planIntervals.length).toBeGreaterThan(0)
        expect(captured.planIntervals.filter(timer => !productionClears.has(timer))).toEqual([])
      }
    } finally {
      captured.manager?.shutdown()
      await captured.manager?.retiredSettled()
      for (const stop of externalStops) stop()
      // Bootstrap's account-notice interval belongs to its signal shutdown, not connections.stop.
      // Clear all startup-owned leftovers only AFTER witnessing the plan watchers' real stop.
      const owned = [...intervalSpy.mock.results]
        .flatMap(result => result.type === 'return' ? [result.value] : [])
      for (const timer of owned) Reflect.apply(globalThis.clearInterval, globalThis, [timer])
      const allClears = new Set<unknown>(clearSpy.mock.calls.map(call => call[0]))
      ownedIntervalCount = owned.length
      unclearedIntervals = owned.filter(timer => !allClears.has(timer))
      for (const signal of signals) for (const listener of process.listeners(signal)) {
        if (!listeners.get(signal)!.has(listener)) process.removeListener(signal, listener)
      }
      database?.close()
      mock.restore()
      for (const { name, original } of modules.reverse()) mock.module(name, () => original)
      if (originalDbPath === undefined) delete process.env.AGENTBOARD_DB_PATH
      else process.env.AGENTBOARD_DB_PATH = originalDbPath
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  expect(globalThis.fetch).toBe(originalFetch)
  expect(globalThis.setInterval).toBe(originalSetInterval)
  expect(globalThis.clearInterval).toBe(originalClearInterval)
  expect(ownedIntervalCount).toBeGreaterThan(0)
  expect(unclearedIntervals).toEqual([])
  expect(stopped).toBe(externalStops.length)
  for (const signal of signals) expect(process.listeners(signal)).toEqual([...listeners.get(signal)!])
})

// A scripted package Codex driver for the codex-capacity-retry tables (O, C,
// L, T, P1-P3): the real package session built by createCodexDriverWith over
// capacityAppServer.ts, whose in-process app-server replaces only the process
// (the transport's private spawn seam) and whose fake clock replaces only the
// capacity clock (the session's private capacityClock seam). It records the
// session's events, activity, limit events and turn results.
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexDriverWith } from '../../src/codex/driver.js'
import type { CodexAgentDriver, TurnResult } from '../../src/contract.js'
import type { AgentEvent } from '../../src/events.js'
import type { Activity } from '../../src/activity.js'
import type { LimitEvent } from '../../src/usage/types.js'
import type { CodexDriverOptions } from '../../src/options.js'
import { capacityAppServer, FakeCapacityClock, type AppServer } from './capacityAppServer.js'
import { PERMISSIONS } from './codexDriverHarness.js'

export { EPOCH0, FakeCapacityClock, THREAD, type ClientRequest } from './capacityAppServer.js'

export interface Scripted extends Omit<AppServer, 'spawn'> {
  driver: CodexAgentDriver
  clock: FakeCapacityClock
  events: AgentEvent[]
  /** Every onActivity publication as a plain record (the shape's own fields, typed or not). */
  activities: Array<Record<string, unknown> | null>
  limits: LimitEvent[]
  results: TurnResult[]
  types(): string[]
}

let sharedRoot: { launch: CodexDriverOptions['launch'] } | null = null
function launch(): CodexDriverOptions['launch'] {
  if (!sharedRoot) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-capacity-')))
    for (const dir of ['home', 'cache', 'tmp', 'bin', 'work']) mkdirSync(join(root, dir))
    const wrapper = join(root, 'bin', 'codex')
    writeFileSync(wrapper, '#!/bin/sh\nexit 1\n')
    chmodSync(wrapper, 0o755)
    sharedRoot = { launch: { cwd: join(root, 'work'), childEnv: { CODEX_HOME: join(root, 'home') }, executablePath: wrapper, homeDir: join(root, 'home'), cacheDir: join(root, 'cache'), tempDir: join(root, 'tmp') } }
  }
  return sharedRoot.launch
}

/** One scripted driver; `capacityRecovery` as given (omit it for the default). */
export function scriptedCodex(options: { capacityRecovery?: unknown; clock?: FakeCapacityClock; resume?: string } = {}): Scripted {
  const clock = options.clock ?? new FakeCapacityClock()
  const recorded = { events: [] as AgentEvent[], activities: [] as Array<Record<string, unknown> | null>, limits: [] as LimitEvent[], results: [] as TurnResult[] }
  const server = capacityAppServer(clock)
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const driverOptions = {
    logger, launch: launch(), permissions: PERMISSIONS,
    ...(options.capacityRecovery !== undefined ? { capacityRecovery: options.capacityRecovery as 'bounded' } : {}),
    ...(options.resume ? { resume: { runtime: 'codex' as const, runtimeSessionId: options.resume } } : {}),
    callbacks: {
      onEvent: (event: AgentEvent) => void recorded.events.push(event),
      onActivity: (activity: Activity | null) => void recorded.activities.push(activity as Record<string, unknown> | null),
      onLimitEvent: (event: LimitEvent) => void recorded.limits.push(event),
      onTurnResult: (result: TurnResult) => void recorded.results.push(result),
    },
  } satisfies CodexDriverOptions
  const driver = createCodexDriverWith(driverOptions, { spawn: server.spawn, capacityClock: clock })
  const { spawn: _spawn, ...controls } = server
  return { driver, clock, ...recorded, ...controls, types: () => recorded.events.map((event) => event.type) }
}

/** Frame helpers for one attempt id. */
export const frames = {
  started: (turnId: string) => ['turn/started', { turn: { id: turnId, status: 'inProgress', items: [], error: null } }] as const,
  completed: (turnId: string, items: unknown[] = []) => ['turn/completed', { turn: { id: turnId, status: 'completed', error: null, items } }] as const,
  failed: (turnId: string, codexErrorInfo: unknown, message = 'the turn failed') => ['turn/completed', { turn: { id: turnId, status: 'failed', error: { message, codexErrorInfo, additionalDetails: null }, items: [] } }] as const,
  interrupted: (turnId: string) => ['turn/completed', { turn: { id: turnId, status: 'interrupted', error: null, items: [] } }] as const,
  retryError: (turnId: string, codexErrorInfo: unknown, willRetry = true) => ['error', { turnId, willRetry, error: { message: 'busy', codexErrorInfo, additionalDetails: null } }] as const,
}

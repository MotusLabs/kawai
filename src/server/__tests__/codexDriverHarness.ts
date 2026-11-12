// Test harness for the Codex driver (codex-chat-sessions §5): builds
// synthetic app-server transcripts the fake replays (the shared Script
// builder lives in tests/fixtures/codexTranscript.ts so the e2e spec
// imports the same one; tests/fixtures/fake-codex-app-server.ts replays
// them — client requests must arrive in the scripted order, responses wait
// for their request, server requests wait for the reply), runs a
// CodexSessionDriver against it, and records what the driver emitted and
// sent. No real Codex is involved, and the home is a temp dir.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatContextUsage, ChatEvent } from '../../shared/chat'
import type { SessionStatus } from '../../shared/types'
import { CodexSessionDriver, type CodexSessionDriverOptions } from '../chat/codex/CodexSessionDriver'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../chat/provider/driver'

export const FAKE_CODEX = path.resolve(import.meta.dir, '../../../tests/fixtures/fake-codex-app-server.ts')

import { ROLLOUT, Script, THREAD_ID } from '../../../tests/fixtures/codexTranscript'
export { ROLLOUT, Script, THREAD_ID }

export interface Harness {
  driver: CodexSessionDriver
  events: ChatEvent[]
  statuses: SessionStatus[]
  usage: Array<ChatContextUsage | null>
  /** Every JSON-RPC message the driver wrote. */
  sent: Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }>
  wire: Array<{ dir: string; raw: string }>
  sessionIds: string[]
  transcriptPaths: string[]
  dir: string
  /** The written transcript the fake replays. */
  transcript: string
  cleanup(): void
}

/** A temp dir with an (empty) project and Codex home, removed by cleanup. */
export function tempDirs(): { dir: string; project: string; home: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-driver-')))
  const project = path.join(dir, 'project')
  const home = path.join(dir, 'codex-home')
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  return { dir, project, home }
}

export function startHarness(
  script: Script,
  overrides: Partial<CodexSessionDriverOptions> = {},
  dirs = tempDirs(),
): Harness {
  const transcript = script.write(dirs.dir)
  const events: ChatEvent[] = []
  const statuses: SessionStatus[] = []
  const usage: Array<ChatContextUsage | null> = []
  const wire: Harness['wire'] = []
  const sessionIds: string[] = []
  const transcriptPaths: string[] = []
  let turn = 0
  const driver = new CodexSessionDriver({
    sessionId: 'chat-codex-test',
    projectPath: dirs.project,
    executable: FAKE_CODEX,
    codexHome: dirs.home,
    network: true,
    wire: { record: (dir, raw) => wire.push({ dir, raw }) },
    withheldCredentials: () => new Set(),
    serverEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirs.dir, FAKE_TRANSCRIPT: transcript },
    createTurnId: () => `turn-${++turn}`,
    onEvent: event => events.push(event),
    onStatus: status => statuses.push(status),
    onContextUsage: reading => usage.push(reading),
    onSdkSessionId: id => sessionIds.push(id),
    onTranscriptPath: file => transcriptPaths.push(file),
    interruptTimeoutMs: 2_000,
    ...overrides,
  })
  const harness: Harness = {
    driver, events, statuses, usage, wire, sessionIds, transcriptPaths, dir: dirs.dir, transcript,
    get sent() {
      return wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw))
    },
    cleanup: () => {
      driver.kill()
      fs.rmSync(dirs.dir, { recursive: true, force: true })
    },
  }
  return harness
}

/** Kawai's production Codex composition, as createChatDriver returns it. */
export type RuntimeDriver = ChatAgentDriver & { settled(): Promise<void> }

export interface RuntimeHarness extends Omit<Harness, 'driver' | 'cleanup'> {
  driver: RuntimeDriver
  /**
   * Kills the driver, joins every operation it owns (settled()), and only
   * then removes the temp root. Every call returns the same join; a raw
   * failure settled() reports rejects it once, never swallowed.
   */
  cleanup(): Promise<void>
}

/**
 * The production path (extract-agent-runtime 6.2/6.3, task-5906f19c):
 * createChatDriver → codexRuntime.ts → the public package factory, which
 * launches the replaying fake as its own default-owned child over stdio. The
 * same inputs as startHarness, minus the legacy driver's knobs the adapter
 * never reads (createTurnId: the package mints turn ids; createClient: the
 * package owns its client). The rate-limits claim defaults to none, as the
 * old harness's unset option meant; production always passes the usage
 * store's claim.
 */
export function startRuntimeHarness(
  script: Script,
  overrides: Partial<CodexSessionDriverOptions> = {},
  dirs = tempDirs(),
): RuntimeHarness {
  const transcript = script.write(dirs.dir)
  const events: ChatEvent[] = []
  const statuses: SessionStatus[] = []
  const usage: Array<ChatContextUsage | null> = []
  const wire: Harness['wire'] = []
  const sessionIds: string[] = []
  const transcriptPaths: string[] = []
  const driver = createChatDriver({
    runtime: 'codex',
    options: {
      sessionId: 'chat-codex-test',
      projectPath: dirs.project,
      executable: FAKE_CODEX,
      codexHome: dirs.home,
      network: true,
      wire: { record: (dir, raw) => wire.push({ dir, raw }) },
      withheldCredentials: () => new Set(),
      serverEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dirs.dir, FAKE_TRANSCRIPT: transcript },
      claimRateLimitsRead: () => false,
      onEvent: event => events.push(event),
      onStatus: status => statuses.push(status),
      onContextUsage: reading => usage.push(reading),
      onSdkSessionId: id => sessionIds.push(id),
      onTranscriptPath: file => transcriptPaths.push(file),
      interruptTimeoutMs: 2_000,
      ...overrides,
    },
  }) as RuntimeDriver
  let joined: Promise<void> | null = null
  return {
    driver, events, statuses, usage, wire, sessionIds, transcriptPaths, dir: dirs.dir, transcript,
    get sent() {
      return wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw))
    },
    cleanup: () => (joined ??= (async () => {
      driver.kill()
      try {
        await driver.settled()
      } finally {
        fs.rmSync(dirs.dir, { recursive: true, force: true })
      }
    })()),
  }
}

/** Poll until the predicate holds (cross-process settling). */
export async function until(predicate: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}

/** The first sent request with `method`. */
export function sentRequest(harness: Pick<Harness, 'sent'>, method: string, nth = 0): Record<string, unknown> | undefined {
  return harness.sent.filter(message => message.method === method)[nth]?.params
}

export const eventTypes = (events: ChatEvent[]): string[] => events.map(event => event.type)

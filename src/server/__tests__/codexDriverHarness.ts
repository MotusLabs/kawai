// Test harness for the Codex driver (codex-chat-sessions §5): builds
// synthetic app-server transcripts the fake replays (tests/fixtures/
// fake-codex-app-server.ts — client requests must arrive in the scripted
// order, responses wait for their request, server requests wait for the
// reply), runs a CodexSessionDriver against it, and records what the driver
// emitted and sent. No real Codex is involved, and the home is a temp dir.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatContextUsage, ChatEvent } from '../../shared/chat'
import type { SessionStatus } from '../../shared/types'
import { CodexSessionDriver, type CodexSessionDriverOptions } from '../chat/codex/CodexSessionDriver'

export const FAKE_CODEX = path.resolve(import.meta.dir, '../../../tests/fixtures/fake-codex-app-server.ts')

export const THREAD_ID = 'thread-0001'
export const ROLLOUT = '/codex-home/sessions/rollout-thread-0001.jsonl'

type Line = { dir: 'out' | 'in'; line: string }

/** A transcript under construction; request ids follow the client's (1, 2, …). */
export class Script {
  readonly lines: Line[] = []
  private nextId = 1

  /** A client request and its recorded response. */
  request(method: string, result: unknown = {}): this {
    const id = this.nextId++
    this.lines.push({ dir: 'out', line: JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) })
    this.lines.push({ dir: 'in', line: JSON.stringify({ id, result }) })
    return this
  }

  notify(method: string, params: Record<string, unknown>): this {
    this.lines.push({ dir: 'in', line: JSON.stringify({ method, params }) })
    return this
  }

  /** A server request; the replay waits for the client's reply to `id`. */
  serverRequest(id: number, method: string, params: Record<string, unknown>): this {
    this.lines.push({ dir: 'in', line: JSON.stringify({ method, id, params }) })
    return this
  }

  /** initialize + thread/start (or resume) answered with THREAD_ID. */
  boot(method: 'thread/start' | 'thread/resume' = 'thread/start', model = 'gpt-test'): this {
    return this.request('initialize', { userAgent: 'fake' })
      .request(method, { thread: { id: THREAD_ID, path: ROLLOUT }, model })
  }

  /** turn/start answered, then turn/started for `codexTurn`. */
  turn(codexTurn: string): this {
    return this.request('turn/start', { turn: { id: codexTurn, status: 'inProgress', items: [], error: null } })
      .notify('turn/started', { threadId: THREAD_ID, turn: { id: codexTurn, status: 'inProgress', items: [], error: null } })
  }

  item(phase: 'started' | 'completed', codexTurn: string, item: Record<string, unknown>): this {
    return this.notify(`item/${phase}`, { item, threadId: THREAD_ID, turnId: codexTurn })
  }

  completed(codexTurn: string, status = 'completed', items: unknown[] = [], error: unknown = null): this {
    return this.notify('turn/completed', { threadId: THREAD_ID, turn: { id: codexTurn, status, items, error } })
  }

  write(dir: string): string {
    const file = path.join(dir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`)
    fs.writeFileSync(file, this.lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    return file
  }
}

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

/** Poll until the predicate holds (cross-process settling). */
export async function until(predicate: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}

/** The first sent request with `method`. */
export function sentRequest(harness: Harness, method: string, nth = 0): Record<string, unknown> | undefined {
  return harness.sent.filter(message => message.method === method)[nth]?.params
}

export const eventTypes = (events: ChatEvent[]): string[] => events.map(event => event.type)

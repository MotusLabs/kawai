// External terminal activity never enters process observations: the tmux
// SessionManager subsystem parses an external Codex log for session discovery
// and status, and that path owns no observation recorder.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { freshTestDatabase } from './helpers/testDatabase'
import { LogPoller } from '../logPoller'
import { SessionRegistry } from '../SessionRegistry'
import { handleMatchWorkerRequest } from '../logMatchWorker'
import type { MatchWorkerRequest, MatchWorkerResponse } from '../logMatchWorkerTypes'

const bunAny = Bun as typeof Bun & {
  spawnSync: typeof Bun.spawnSync
  spawn: typeof Bun.spawn
}
const originalSpawnSync = bunAny.spawnSync
const originalSpawn = bunAny.spawn
const originalCodex = process.env.CODEX_HOME

let tempRoot = ''

/** The worker runs in-process here; production spawns it as a subprocess. */
function inProcessWorker() {
  return {
    poll: (request: Omit<MatchWorkerRequest, 'id'>): Promise<MatchWorkerResponse> =>
      handleMatchWorkerRequest({ ...request, id: 'external-observation' }),
    dispose: () => {},
  }
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-external-codex-'))
  process.env.CODEX_HOME = path.join(tempRoot, 'codex')
  await fs.mkdir(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true })
  bunAny.spawnSync = ((args: string[]) => {
    const tmuxSubcommand = args[1] === '-u' ? args[2] : args[1]
    if (args[0] === 'tmux' && tmuxSubcommand === 'capture-pane') {
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as ReturnType<typeof Bun.spawnSync>
    }
    if (args[0] === 'rg') {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') } as ReturnType<typeof Bun.spawnSync>
    }
    return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync
  bunAny.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const cmd = Array.isArray(args[0]) ? args[0] : [String(args[0])]
    const syncResult = bunAny.spawnSync(cmd as Parameters<typeof Bun.spawnSync>[0])
    const stdoutBuf = syncResult.stdout ?? Buffer.from('')
    const stderrBuf = syncResult.stderr ?? Buffer.from('')
    return {
      exited: Promise.resolve(syncResult.exitCode ?? 0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(typeof stdoutBuf === 'string' ? new TextEncoder().encode(stdoutBuf) : stdoutBuf)
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(typeof stderrBuf === 'string' ? new TextEncoder().encode(stderrBuf) : stderrBuf)
          controller.close()
        },
      }),
      kill: () => {},
      pid: 34567,
    } as unknown as ReturnType<typeof Bun.spawn>
  }) as typeof Bun.spawn
})

afterEach(async () => {
  bunAny.spawnSync = originalSpawnSync
  bunAny.spawn = originalSpawn
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
  await fs.rm(tempRoot, { recursive: true, force: true })
})

// @covers: process-observations › Observations cover managed work only › External terminal activity
test('an external Codex log parsed by the SessionManager subsystem writes no process observation', async () => {
  const logPath = path.join(process.env.CODEX_HOME!, 'sessions', 'rollout-external.jsonl')
  await fs.writeFile(
    logPath,
    `${JSON.stringify({
      type: 'user',
      sessionId: 'external-codex-1',
      cwd: '/tmp/external-project',
      message: { role: 'user', content: [{ type: 'text', text: 'run the external terminal prompt for the orphan codex session' }] },
    })}\n`,
  )
  const dbPath = path.join(tempRoot, 'sessions.db')
  const db: SessionDatabase = freshTestDatabase(dbPath)
  const poller = new LogPoller(db, new SessionRegistry(), { matchWorkerClient: inProcessWorker() })
  try {
    await poller.pollChanged([logPath])
    // The log was really parsed: session discovery recorded the external
    // Codex session from it.
    const parsed = db.getSessionByLogPath(logPath)
    expect(parsed?.sessionId).toBe('external-codex-1')
    expect(parsed?.agentType).toBe('codex')
    // And that parse path collected no process observation.
    expect((db.db.prepare('SELECT count(*) n FROM process_observations').get() as { n: number }).n).toBe(0)
  } finally {
    poller.stop()
    db.close()
  }
})

test('the sessions database carries the observations schema the parse path must leave empty', () => {
  const db = initDatabase({ path: ':memory:' })
  expect(
    db.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='process_observations'").get(),
  ).toEqual({ n: 1 })
  db.close()
})

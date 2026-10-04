import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '../../shared/types'
import { createMatchWorkerDispatcher, handleMatchWorkerRequest } from '../logMatchWorker'
import type {
  MatchWorkerRequest,
  MatchWorkerResponse,
} from '../logMatchWorkerTypes'

const messages: unknown[] = []

const bunAny = Bun as typeof Bun & {
  spawnSync: typeof Bun.spawnSync
  spawn: typeof Bun.spawn
}
const originalSpawnSync = bunAny.spawnSync
const originalSpawn = bunAny.spawn
const tmuxOutputs = new Map<string, string>()

const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME
const originalPi = process.env.PI_HOME

let tempRoot = ''

function buildPromptScrollback(
  messages: string[],
  options: { prefix?: string; glyph?: string } = {}
): string {
  const prefix = options.prefix ?? ''
  const glyph = options.glyph ?? '❯'
  return messages
    .map((message) => `${prefix}${glyph} ${message}\n⏺ ok`)
    .join('\n')
    .concat('\n')
}

/**
 * Build a log entry in proper Claude/Codex format with "text" field.
 * This format is required for the JSON field pattern matching.
 */
function buildUserLogEntry(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message }] }
  })
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = []
  if (!fsSync.existsSync(dir)) return results
  const entries = fsSync.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath)
    }
  }
  return results
}

function runRg(args: string[]) {
  const patternIndex = args.indexOf('-e')
  const pattern = patternIndex >= 0 ? args[patternIndex + 1] ?? '' : ''
  const regex = pattern ? new RegExp(pattern, 'm') : null

  if (args.includes('--json')) {
    const filePath = args[args.length - 1] ?? ''
    if (!filePath || !regex || !fsSync.existsSync(filePath)) {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    const lines = fsSync.readFileSync(filePath, 'utf8').split('\n')
    const output: string[] = []
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        output.push(JSON.stringify({ type: 'match', data: { line_number: index + 1 } }))
      }
    })
    const exitCode = output.length > 0 ? 0 : 1
    return {
      exitCode,
      stdout: Buffer.from(output.join('\n')),
      stderr: Buffer.from(''),
    }
  }

  if (args.includes('-l')) {
    if (!regex) {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    const targets: string[] = []
    let skipNext = false
    for (let i = patternIndex + 2; i < args.length; i += 1) {
      const arg = args[i] ?? ''
      if (skipNext) {
        skipNext = false
        continue
      }
      if (!arg) continue
      if (arg === '--glob' || arg === '--threads') {
        skipNext = true
        continue
      }
      if (arg.startsWith('-')) continue
      targets.push(arg)
    }
    const files: string[] = []
    for (const target of targets) {
      if (!fsSync.existsSync(target)) continue
      const stat = fsSync.statSync(target)
      if (stat.isDirectory()) {
        files.push(...findJsonlFiles(target))
      } else if (stat.isFile()) {
        files.push(target)
      }
    }
    const matches = files.filter((file) => {
      const content = fsSync.readFileSync(file, 'utf8')
      return regex.test(content)
    })
    return {
      exitCode: matches.length > 0 ? 0 : 1,
      stdout: Buffer.from(matches.join('\n')),
      stderr: Buffer.from(''),
    }
  }

  return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
}

function setTmuxOutput(target: string, content: string) {
  tmuxOutputs.set(target, content)
}

async function postRequest(request: MatchWorkerRequest) {
  messages.push(await handleMatchWorkerRequest(request))
}

afterAll(() => {
  bunAny.spawnSync = originalSpawnSync
  bunAny.spawn = originalSpawn
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
  if (originalPi) process.env.PI_HOME = originalPi
  else delete process.env.PI_HOME
})

beforeEach(async () => {
  messages.length = 0
  tmuxOutputs.clear()

  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-worker-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, 'claude')
  process.env.CODEX_HOME = path.join(tempRoot, 'codex')
  process.env.PI_HOME = path.join(tempRoot, 'pi')
  await fs.mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), {
    recursive: true,
  })
  await fs.mkdir(path.join(process.env.CODEX_HOME, 'sessions'), {
    recursive: true,
  })
  await fs.mkdir(path.join(process.env.PI_HOME, 'agent', 'sessions'), {
    recursive: true,
  })

  bunAny.spawnSync = ((args: string[]) => {
    const tmuxSubcommand = args[1] === '-u' ? args[2] : args[1]
    if (args[0] === 'tmux' && tmuxSubcommand === 'capture-pane') {
      const targetIndex = args.indexOf('-t')
      const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
      const output = tmuxOutputs.get(target ?? '') ?? ''
      return {
        exitCode: 0,
        stdout: Buffer.from(output),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    if (args[0] === 'rg') {
      return runRg(args) as ReturnType<typeof Bun.spawnSync>
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync

  // The async matcher (paced variant) captures via Bun.spawn — delegate it
  // to the current spawnSync mock so both interfaces see the same fixtures.
  // Read spawnSync at call time so test-local wrappers keep applying.
  bunAny.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const cmd = Array.isArray(args[0]) ? args[0] : [String(args[0])]
    const syncResult = bunAny.spawnSync(
      cmd as Parameters<typeof Bun.spawnSync>[0]
    )
    const stdoutBuf = syncResult.stdout ?? Buffer.from('')
    const stderrBuf = syncResult.stderr ?? Buffer.from('')
    return {
      exited: Promise.resolve(syncResult.exitCode ?? 0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(
            typeof stdoutBuf === 'string'
              ? new TextEncoder().encode(stdoutBuf)
              : stdoutBuf
          )
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(
            typeof stderrBuf === 'string'
              ? new TextEncoder().encode(stderrBuf)
              : stderrBuf
          )
          controller.close()
        },
      }),
      kill: () => {},
      pid: 23456,
    } as unknown as ReturnType<typeof Bun.spawn>
  }) as typeof Bun.spawn
})

afterEach(async () => {
  bunAny.spawnSync = originalSpawnSync
  bunAny.spawn = originalSpawn
  tmuxOutputs.clear()
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
  if (originalPi) process.env.PI_HOME = originalPi
  else delete process.env.PI_HOME
})

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  agentType: 'claude',
  source: 'managed',
}

describe('logMatchWorker', () => {
  test('skips matching when sessions already mapped', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-1.jsonl')
    await fs.writeFile(
      logPath,
      buildUserLogEntry('hello', { sessionId: 'session-1', cwd: '/tmp/alpha' })
    )

    await postRequest({
      id: 'request-1',
      windows: [baseSession],
      maxLogsPerPoll: 5,
      sessions: [
        {
          sessionId: 'session-1',
          logFilePath: logPath,
          currentWindow: 'agentboard:1',
          lastActivityAt: new Date().toISOString(),
        },
      ],
      scrollbackLines: 25,
    })

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('result')
    expect(response.matchSkipped).toBe(true)
    expect(response.matches).toEqual([])
    expect(response.matchWindowCount).toBe(0)
    expect(response.matchLogCount).toBe(0)
  })

  test('matches entries and returns resolved windows', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-2.jsonl')
    const message = 'alpha one'
    await fs.writeFile(
      logPath,
      buildUserLogEntry(message, { sessionId: 'session-2', cwd: '/tmp/alpha' })
    )

    setTmuxOutput('agentboard:1', buildPromptScrollback([message]))

    await postRequest({
      id: 'request-2',
      windows: [baseSession],
      maxLogsPerPoll: 5,
      sessions: [],
      scrollbackLines: 25,
    })

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('result')
    expect(response.matchSkipped).toBe(false)
    expect(response.matchWindowCount).toBe(1)
    expect(response.matchLogCount).toBe(1)
    expect(response.matches).toEqual([{ logPath, tmuxWindow: 'agentboard:1' }])
  })

  test('returns error responses when matching throws', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-3.jsonl')
    await fs.writeFile(
      logPath,
      buildUserLogEntry('boom', { sessionId: 'session-3', cwd: '/tmp/alpha' })
    )

    bunAny.spawnSync = (() => {
      throw new Error('boom')
    }) as typeof Bun.spawnSync

    await postRequest({
      id: 'request-3',
      windows: [baseSession],
      maxLogsPerPoll: 5,
      sessions: [],
      scrollbackLines: 25,
    })

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('error')
    expect(response.error).toBe('boom')
  })

  test('uses preFilteredPaths and skips full directory scan', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })

    const includedLogPath = path.join(logDir, 'included.jsonl')
    const scannedOnlyLogPath = path.join(logDir, 'scanned-only.jsonl')
    await fs.writeFile(
      includedLogPath,
      buildUserLogEntry('included message', {
        sessionId: 'session-included',
        cwd: '/tmp/alpha',
      })
    )
    await fs.writeFile(
      scannedOnlyLogPath,
      buildUserLogEntry('scanned only message', {
        sessionId: 'session-scanned-only',
        cwd: '/tmp/alpha',
      })
    )

    await postRequest({
      id: 'request-prefiltered',
      windows: [],
      maxLogsPerPoll: 25,
      sessions: [],
      scrollbackLines: 25,
      preFilteredPaths: [includedLogPath],
    })

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('result')
    const entries = response.entries as Array<{ logPath: string }>
    expect(entries).toHaveLength(1)
    expect(entries[0]?.logPath).toBe(includedLogPath)
  })

  test('falls back to full scan when preFilteredPaths is empty', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })

    const firstLogPath = path.join(logDir, 'first.jsonl')
    const secondLogPath = path.join(logDir, 'second.jsonl')
    await fs.writeFile(
      firstLogPath,
      buildUserLogEntry('first message', {
        sessionId: 'session-first',
        cwd: '/tmp/alpha',
      })
    )
    await fs.writeFile(
      secondLogPath,
      buildUserLogEntry('second message', {
        sessionId: 'session-second',
        cwd: '/tmp/alpha',
      })
    )

    await postRequest({
      id: 'request-empty-prefiltered',
      windows: [],
      maxLogsPerPoll: 25,
      sessions: [],
      scrollbackLines: 25,
      preFilteredPaths: [],
    })

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('result')
    const entries = (response.entries as Array<{ logPath: string }>).map(
      (entry) => entry.logPath
    )
    expect(entries).toContain(firstLogPath)
    expect(entries).toContain(secondLogPath)
  })

  test('dispatcher serializes queued requests and recovers after failure', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })

    const events: string[] = []
    // Record capture-pane invocations by target; the targets differ per
    // request, so the event order proves serialization.
    const recordCaptures = (args: string[]) => {
      const tmuxSubcommand = args[1] === '-u' ? args[2] : args[1]
      if (args[0] === 'tmux' && tmuxSubcommand === 'capture-pane') {
        const targetIndex = args.indexOf('-t')
        events.push(`capture:${args[targetIndex + 1]}`)
      }
    }
    const innerMock = bunAny.spawnSync
    bunAny.spawnSync = ((args: string[]) => {
      recordCaptures(args)
      return innerMock(args as Parameters<typeof Bun.spawnSync>[0])
    }) as typeof Bun.spawnSync

    const dispatched: MatchWorkerResponse[] = []
    const dispatch = createMatchWorkerDispatcher((response) =>
      dispatched.push(response)
    )

    // Request 1: paced with two windows and a 20ms inter-window yield, so its
    // captures and response span a measurable interval.
    const pacedLog = path.join(logDir, 'paced.jsonl')
    await fs.writeFile(
      pacedLog,
      buildUserLogEntry('paced message', { sessionId: 'session-paced', cwd: '/tmp/alpha' })
    )
    const pacedWindowA = { ...baseSession, tmuxWindow: 'agentboard: paced-a' }
    const pacedWindowB = { ...baseSession, tmuxWindow: 'agentboard: paced-b' }
    setTmuxOutput('agentboard: paced-a', buildPromptScrollback(['paced message']))
    setTmuxOutput('agentboard: paced-b', buildPromptScrollback(['paced message']))

    // Request 2: an orphan-rematch request whose capture must not start
    // before request 1's response was posted.
    const orphanLog = path.join(logDir, 'orphan.jsonl')
    await fs.writeFile(
      orphanLog,
      buildUserLogEntry('orphan message', { sessionId: 'session-orphan', cwd: '/tmp/alpha' })
    )
    const orphanWindow = { ...baseSession, tmuxWindow: 'agentboard: orphan-w' }
    setTmuxOutput('agentboard: orphan-w', buildPromptScrollback(['orphan message']))

    const pacedRequest: MatchWorkerRequest = {
      id: 'request-paced',
      windows: [pacedWindowA, pacedWindowB],
      maxLogsPerPoll: 5,
      sessions: [],
      scrollbackLines: 25,
      search: { interWindowYieldMs: 20 },
    }
    const orphanRequest: MatchWorkerRequest = {
      id: 'request-orphan',
      windows: [orphanWindow],
      maxLogsPerPoll: 5,
      sessions: [],
      scrollbackLines: 25,
      forceOrphanRematch: true,
      orphanCandidates: [
        {
          sessionId: 'session-orphan',
          logFilePath: orphanLog,
          projectPath: '/tmp/alpha',
          agentType: 'claude',
          currentWindow: null,
        },
      ],
      search: { interWindowYieldMs: 20 },
    }

    // Queue both back-to-back without awaiting the first.
    dispatch(pacedRequest)
    dispatch(orphanRequest)

    const deadline = Date.now() + 10000
    while (
      Date.now() < deadline &&
      dispatched.filter((r) => r.type === 'result').length < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(dispatched).toHaveLength(2)
    expect(dispatched.map((r) => r.id)).toEqual(['request-paced', 'request-orphan'])

    // Serialization: request 2's capture happens only after request 1's
    // response was posted — never interleaved with request 1's captures.
    const orphanCaptureIndex = events.findIndex(
      (e) => e === 'capture:agentboard: orphan-w'
    )
    expect(orphanCaptureIndex).toBeGreaterThanOrEqual(0)
    // All of request 1's captures precede request 2's capture.
    expect(events.lastIndexOf('capture:agentboard: paced-b')).toBeLessThan(orphanCaptureIndex)

    // A failing request must not poison the queue: force spawnSync to throw,
    // dispatch an erroring request, then a normal one that still completes.
    bunAny.spawnSync = (() => {
      throw new Error('poison')
    }) as typeof Bun.spawnSync
    dispatched.length = 0
    dispatch({ ...pacedRequest, id: 'request-failing' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    bunAny.spawnSync = innerMock as typeof Bun.spawnSync
    dispatch({ ...orphanRequest, id: 'request-after-failure' })

    const deadline2 = Date.now() + 10000
    while (Date.now() < deadline2 && dispatched.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(dispatched).toHaveLength(2)
    expect(dispatched[0].type).toBe('error')
    expect(dispatched[1].type).toBe('result')
    expect(dispatched[1].id).toBe('request-after-failure')
  })
})

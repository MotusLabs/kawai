// Old-positive witnesses O1/O2 and gate row WG2 (bounded-log-reads D2/D3):
// logs whose message text the old whole-file reader counted but the bounded
// windows cannot see in a complete line. Through the real poller, the real
// match worker, and the real token reader, each must stay eligible and be
// inserted on an exact match; no empty cache may hold it. Logs are written in
// chunks; tmux and rg are the only doubles.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readLogTokenEvidence } from '../logmatch'
import {
  assistantLine, claudeLogPath, fillerLine, FsObserver, giantMessageLine, matchMessage, userLine, WitnessEnv, writeChunked,
  type Part,
} from './helpers/logTokenHarness'

const KiB = 1024
const MiB = 1024 * KiB
const SESSION = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let env: WitnessEnv

beforeEach(() => {
  env = new WitnessEnv()
})

afterEach(() => {
  env.dispose()
})

/**
 * Polls once through the real poller and worker and asserts the log reached
 * exact matching (the rg double reported it), was inserted, and is in
 * neither empty cache. With `tmuxWindow`, the insert is bound to it.
 */
async function expectInserted(logPath: string, sessionId: string, tmuxWindow: string | null) {
  const { poller, worker, emptyLogCache } = env.poller()
  const stats = await poller.pollOnce()
  expect(worker.requests.length).toBeGreaterThan(0)
  expect(env.rgHits).toContain(logPath)
  expect(stats.newSessions).toBe(1)
  const record = env.db.getSessionByLogPath(logPath)
  expect(record?.sessionId).toBe(sessionId)
  if (tmuxWindow) expect(record?.currentWindow).toBe(tmuxWindow)
  expect(emptyLogCache.has(logPath)).toBe(false)
  // The reader's own cache: a further read must read content again.
  const observer = new FsObserver().start()
  try {
    readLogTokenEvidence(logPath, { agentType: 'claude' })
  } finally {
    observer.stop()
  }
  expect(observer.for(logPath).some((op) => op.api === 'read')).toBe(true)
}

// The exact matcher's progressive tail check stops when its first 96 KiB
// tail holds no complete line (pre-existing, unchanged by this change), so a
// log ending in a large line is inserted without a window. Each witness is
// therefore run as specified and with a short trailing non-message line,
// which binds the exact-matched window; the token evidence is P(0) in both.
const TRAILER = fillerLine(200)

const META = (n: number) => ({ sessionId: SESSION(n), cwd: '/tmp/kawai-token-witness' })

/** Writes `parts` as specified (window null) and with the trailer (window bound), and checks both. */
async function bothForms(n: number, message: string, parts: Part[], count: number) {
  for (const trailed of [false, true]) {
    const id = trailed ? n + 100 : n
    const window = env.showWindow(id, message)
    const logPath = claudeLogPath(`witness-${id}`)
    const layout = parts.map((part) => (typeof part === 'string' ? part.replace(SESSION(n), SESSION(id)) : part))
    writeChunked(logPath, trailed ? [...layout, ...TRAILER] : layout)
    expect(readLogTokenEvidence(logPath, { agentType: 'claude' })).toMatchObject({ kind: 'partial', count })
    await expectInserted(logPath, SESSION(id), trailed ? window.tmuxWindow : null)
    env.tmux.delete(window.tmuxWindow)
  }
}

describe('old-positive witnesses through worker → exact match → insert', () => {
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  test('O1: a > 200 KiB first user message and a > 200 KiB echo stay eligible and insert', async () => {
    const message = matchMessage('oone')
    // Message text in both lines (the old whole-file count was > 0); neither
    // is a complete line inside a window, so the evidence is P(0).
    await bothForms(1, message, [
      ...giantMessageLine('user', 210 * KiB, 'word ', META(1), `${message} `),
      ...giantMessageLine('assistant', 210 * KiB, 'echo ', {}, `${message} `),
    ], 0)
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Giant line before a short message
  test('O2: meta, a > 16 MiB non-message line, a short message, a 300 KiB echo stay eligible and insert', async () => {
    const message = matchMessage('otwo')
    await bothForms(2, message, [
      `${JSON.stringify({ type: 'summary', ...META(2) })}\n`,
      ...fillerLine(16 * MiB + 4 * KiB),
      userLine(message, META(2)),
      ...fillerLine(300 * KiB),
    ], 0)
  })
})

describe('WG2: partial evidence at the production insert minimum', () => {
  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  test('P(0): the only message lies between the windows; eligible and inserted at minimum 1', async () => {
    const message = matchMessage('wgtwozero')
    await bothForms(3, message, [...fillerLine(300 * KiB), userLine(message, META(3)), ...fillerLine(300 * KiB)], 0)
  })

  // @covers: terminal-streaming › Token gates and empty caches act only on complete evidence › Partial evidence stays eligible
  test('P(1): one countable word in the tail; eligible and inserted at minimum 1', async () => {
    const message = matchMessage('wgtwoone')
    await bothForms(4, message, [
      ...fillerLine(300 * KiB), userLine(message, META(4)), ...fillerLine(300 * KiB), assistantLine('ok'),
    ], 1)
  })
})

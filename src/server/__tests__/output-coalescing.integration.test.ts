/**
 * output-coalescing.integration.test.ts
 *
 * Real-server verification of the coalesced terminal-output path (design D2):
 * ordered markers typed through a live tmux window must arrive in the same
 * order on the WebSocket, attach history must precede the terminal-ready
 * acknowledgement, and the final rendered pane must contain everything.
 * Also covers the coalescer lifecycle rule (design D2/task 2.3): after a
 * detach, a new attach on the same still-open socket must deliver output
 * again.
 *
 * Exact concatenated-stream equality (ANSI + Unicode) is asserted in the
 * deterministic unit test (terminalOutputCoalescer.test.ts); pane captures
 * are not a raw PTY byte oracle, so this file checks marker order and
 * rendered content instead.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import {
  canBindLocalhost,
  createTmuxTmpDir,
  isTmuxAvailable,
  waitForTmuxWindows,
} from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()
const localhostBindable = canBindLocalhost()
const testHost = '127.0.0.1'

interface ServerMessage {
  type: string
  sessionId?: string
  data?: string
}

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(
    `${reasons.join(' and ')} - skipping output-coalescing integration test`,
    () => {}
  )
} else {
  describe('terminal output coalescing integration', () => {
    const sessionName = `agentboard-coalesce-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-coalesce-${process.pid}-${Date.now()}.db`
    )
    const logFilePath = path.join(
      os.tmpdir(),
      `agentboard-coalesce-${process.pid}-${Date.now()}.log`
    )

    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let windowTarget = ''
    let sessionId = ''

    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir
        ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir }
        : { ...process.env }

    beforeAll(async () => {
      tmuxTmpDir = createTmuxTmpDir()

      Bun.spawnSync(
        ['tmux', 'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40'],
        { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
      )
      const windows = await waitForTmuxWindows(sessionName, tmuxEnv())
      windowTarget = windows[0]

      for (let i = 0; i < 30; i++) {
        Bun.spawnSync(
          ['tmux', 'send-keys', '-t', windowTarget, `echo "scrollback ${i}"`, 'Enter'],
          { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
        )
      }
      await delay(500)

      port = await getFreePort()
      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_DB_PATH: dbPath,
          TERMINAL_MODE: 'pty',
          LOG_LEVEL: 'debug',
          LOG_FILE: logFilePath,
          AGENTBOARD_LOG_MATCH_WORKER: 'false',
          ...(tmuxTmpDir ? { TMUX_TMPDIR: tmuxTmpDir } : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      drainStream(serverProcess.stdout)
      drainStream(serverProcess.stderr)
      await waitForHealth(port, serverProcess)

      sessionId = await waitForDiscoveredSessionId(port, windowTarget)
    }, 60000)

    afterAll(async () => {
      if (serverProcess) {
        try {
          serverProcess.kill()
          await serverProcess.exited
        } catch {
          // ignore
        }
      }
      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
          env: tmuxEnv(),
        })
      } catch {
        // ignore
      }
      for (const f of [dbPath, logFilePath]) {
        try {
          fs.unlinkSync(f)
        } catch {
          // ignore
        }
      }
      if (tmuxTmpDir) {
        try {
          fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    })

    function openSocket() {
      const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
      const messages: ServerMessage[] = []
      ws.onmessage = (event) => {
        try {
          messages.push(JSON.parse(String(event.data)))
        } catch {
          // ignore
        }
      }
      return { ws, messages }
    }

    const attach = (ws: WebSocket) =>
      ws.send(
        JSON.stringify({
          type: 'terminal-attach',
          sessionId,
          tmuxTarget: windowTarget,
          cols: 120,
          rows: 40,
        })
      )

    const outputData = (messages: ServerMessage[]) =>
      messages
        .filter(
          (m) => m.type === 'terminal-output' && m.sessionId === sessionId
        )
        .map((m) => m.data ?? '')
        .join('')

    test(
      'ordered markers arrive in order, history precedes ready, pane renders all',
      async () => {
        const { ws, messages } = openSocket()
        await waitForOpen(ws)
        await waitUntil(
          () => messages.some((m) => m.type === 'sessions'),
          5000,
          'sessions message'
        )
        messages.length = 0

        attach(ws)
        await waitUntil(
          () =>
            messages.some(
              (m) => m.type === 'terminal-ready' && m.sessionId === sessionId
            ),
          10000,
          'terminal-ready'
        )

        // Ordering rule: every history chunk precedes the ready acknowledgement.
        const readyIndex = messages.findIndex(
          (m) =>
            m.type === 'terminal-ready' && m.sessionId === sessionId
        )
        const historyBeforeReady = messages
          .slice(0, readyIndex)
          .filter(
            (m) => m.type === 'terminal-output' && m.sessionId === sessionId
          )
        expect(historyBeforeReady.length).toBeGreaterThanOrEqual(1)
        // captureTmuxHistory grabs the visible pane, so only the tail of the
        // echoed scrollback lines is present — assert on recent content.
        expect(historyBeforeReady.map((m) => m.data ?? '').join('')).toContain(
          'scrollback 29'
        )

        // Drive ordered markers through the live terminal.
        const markers = Array.from(
          { length: 8 },
          (_, i) => `MARK-${Date.now()}-${i}`
        )
        for (const marker of markers) {
          ws.send(
            JSON.stringify({
              type: 'terminal-input',
              sessionId,
              data: `echo "${marker}"\r`,
            })
          )
          // Small spacing so the shell can keep up; output frames may
          // coalesce any number of these — only order matters here.
          await delay(80)
        }

        await waitUntil(
          () => markers.every((m) => outputData(messages).includes(m)),
          15000,
          'all markers in output stream'
        )

        // Marker order in the concatenated output stream is preserved.
        const stream = outputData(messages)
        let cursor = -1
        for (const marker of markers) {
          const index = stream.indexOf(marker)
          expect(index).toBeGreaterThan(cursor)
          cursor = index
        }

        // Final rendered content contains every marker, in order.
        await waitUntil(
          () => {
            const pane = capturePaneText(windowTarget, tmuxEnv())
            return markers.every((m) => pane.includes(m))
          },
          10000,
          'all markers rendered in pane'
        )
        const pane = capturePaneText(windowTarget, tmuxEnv())
        let paneCursor = -1
        for (const marker of markers) {
          const index = pane.indexOf(marker)
          expect(index).toBeGreaterThan(paneCursor)
          paneCursor = index
        }

        ws.close()
      },
      60000
    )

    test(
      'detach then attach on the same socket delivers output for the new attachment',
      async () => {
        const { ws, messages } = openSocket()
        await waitForOpen(ws)
        await waitUntil(
          () => messages.some((m) => m.type === 'sessions'),
          5000,
          'sessions message'
        )
        messages.length = 0

        attach(ws)
        await waitUntil(
          () =>
            messages.some(
              (m) =>
                m.type === 'terminal-ready' && m.sessionId === sessionId
            ),
          10000,
          'first terminal-ready'
        )
        // Some live output before detaching.
        ws.send(
          JSON.stringify({
            type: 'terminal-input',
            sessionId,
            data: `echo "before-detach"\r`,
          })
        )
        await waitUntil(
          () => outputData(messages).includes('before-detach'),
          10000,
          'output before detach'
        )

        ws.send(
          JSON.stringify({ type: 'terminal-detach', sessionId })
        )
        await delay(600) // exceed the 500ms attach-dedup window

        messages.length = 0
        attach(ws)
        await waitUntil(
          () =>
            messages.filter(
              (m) =>
                m.type === 'terminal-ready' && m.sessionId === sessionId
            ).length >= 1,
          10000,
          'terminal-ready after re-attach'
        )

        // History replay for the new attachment precedes its ready message.
        const readyIndex = messages.findIndex(
          (m) => m.type === 'terminal-ready' && m.sessionId === sessionId
        )
        const history = messages
          .slice(0, readyIndex)
          .filter(
            (m) => m.type === 'terminal-output' && m.sessionId === sessionId
          )
        expect(history.length).toBeGreaterThanOrEqual(1)

        // Live output flows for the new attachment on the same socket.
        const marker = `after-reattach-${Date.now()}`
        ws.send(
          JSON.stringify({
            type: 'terminal-input',
            sessionId,
            data: `echo "${marker}"\r`,
          })
        )
        await waitUntil(
          () => outputData(messages).includes(marker),
          10000,
          'output after re-attach'
        )

        ws.close()
      },
      60000
    )
  })
}

// --- Helper functions ---

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ port: 0, host: testHost }, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Unable to allocate port')))
      }
    })
  })
}

async function waitForHealth(
  port: number,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 60000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`Server process exited with code ${proc.exitCode}`)
    }
    try {
      const response = await fetch(`http://${testHost}:${port}/api/health`)
      if (response.ok) {
        return
      }
    } catch {
      // retry
    }
    await delay(100)
  }
  throw new Error('Server did not become healthy in time')
}

async function waitForOpen(
  ws: WebSocket,
  timeoutMs = 5000
): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('WebSocket open timeout'))
    }, timeoutMs)
    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket error'))
    }
  })
}

async function waitForDiscoveredSessionId(
  port: number,
  tmuxWindow: string,
  timeoutMs = 15000
): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://${testHost}:${port}/api/sessions`)
      if (response.ok) {
        const sessions = (await response.json()) as Array<{
          id: string
          tmuxWindow: string
        }>
        const match = sessions.find((session) => session.tmuxWindow === tmuxWindow)
        if (match) {
          return match.id
        }
      }
    } catch {
      // retry
    }
    await delay(200)
  }
  throw new Error(`Server did not discover tmux window ${tmuxWindow}`)
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  description: string
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

function drainStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined
) {
  if (!stream || typeof stream === 'number') return
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const pump = async () => {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  }
  void pump()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function capturePaneText(target: string, env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(
    ['tmux', 'capture-pane', '-t', target, '-p', '-J'],
    { stdout: 'pipe', stderr: 'ignore', env }
  )
  return result.exitCode === 0 ? result.stdout.toString() : ''
}

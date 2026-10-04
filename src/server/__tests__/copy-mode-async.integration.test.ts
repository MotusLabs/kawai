/**
 * copy-mode-async.integration.test.ts
 *
 * Verifies the async copy-mode probe path (design D1): `handleCheckCopyMode`
 * spawns tmux asynchronously, skips overlapping polls on the same connection
 * while a probe is in flight, clears the guard after both successful and
 * failed probes, and discards replies that outlive their attachment.
 *
 * Determinism: the client polls every 750ms, so a probe must outlast that
 * period to exercise the skip/discard logic. Loading the real tmux server
 * enough to guarantee that is flaky, so a PATH shim visible only to the
 * server process delays exactly the copy-mode status probe (`display-message
 * … pane_in_mode …` — a format string no other server call uses) by 1.2s. A
 * `fail-once` flag file next to the shim makes the next probe exit non-zero
 * for the failure-path test.
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
// Must exceed the client's 750ms poll period with margin, and stay well under
// the server's 3s tmux timeout so the probe completes instead of being killed.
const PROBE_DELAY_MS = 1200

interface ServerMessage {
  type: string
  sessionId?: string
  inCopyMode?: boolean
  altScreen?: boolean
  appMouse?: boolean
}

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(
    `${reasons.join(' and ')} - skipping copy-mode async integration test`,
    () => {}
  )
} else {
  describe('copy-mode async integration', () => {
    const sessionName = `agentboard-cpmode-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-cpmode-${process.pid}-${Date.now()}.db`
    )
    const logFilePath = path.join(
      os.tmpdir(),
      `agentboard-cpmode-${process.pid}-${Date.now()}.log`
    )
    const shimDir = path.join(
      os.tmpdir(),
      `agentboard-cpmode-shim-${process.pid}-${Date.now()}`
    )
    const failOnceFlag = path.join(shimDir, 'fail-once')

    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let windowATarget = ''
    let windowBTarget = ''
    let sessionIdA = ''
    let sessionIdB = ''

    const tmuxEnv = (): NodeJS.ProcessEnv =>
      tmuxTmpDir
        ? { ...process.env, TMUX_TMPDIR: tmuxTmpDir }
        : { ...process.env }

    const runTmux = (args: string[]) =>
      Bun.spawnSync(['tmux', ...args], {
        stdout: 'pipe',
        stderr: 'ignore',
        env: tmuxEnv(),
      })

    beforeAll(async () => {
      tmuxTmpDir = createTmuxTmpDir()

      Bun.spawnSync(
        ['tmux', 'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40'],
        { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
      )
      const windows = await waitForTmuxWindows(sessionName, tmuxEnv())
      windowATarget = windows[0]

      // Content so the pane is non-trivial.
      for (let i = 0; i < 20; i++) {
        Bun.spawnSync(
          ['tmux', 'send-keys', '-t', windowATarget, `echo "line ${i}"`, 'Enter'],
          { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
        )
      }

      // A second window for the attachment-supersession test.
      Bun.spawnSync(
        ['tmux', 'new-window', '-t', sessionName, '-n', 'copy-mode-b'],
        { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
      )
      const listResult = runTmux([
        'list-windows',
        '-t',
        sessionName,
        '-F',
        '#{session_name}:#{window_id}',
      ])
      const allWindows = listResult.stdout
        .toString()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      windowBTarget = allWindows.find((w) => w !== windowATarget) ?? ''
      if (!windowBTarget) throw new Error('Failed to create second tmux window')
      for (let i = 0; i < 10; i++) {
        Bun.spawnSync(
          ['tmux', 'send-keys', '-t', windowBTarget, `echo "b line ${i}"`, 'Enter'],
          { stdout: 'ignore', stderr: 'ignore', env: tmuxEnv() }
        )
      }
      await delay(500)

      // PATH shim: delays (or fails, once, on flag) only the copy-mode probe.
      const realTmux = Bun.which('tmux')
      if (!realTmux) throw new Error('tmux not found on PATH')
      fs.mkdirSync(shimDir, { recursive: true })
      fs.writeFileSync(
        path.join(shimDir, 'tmux'),
        [
          '#!/bin/sh',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    *pane_in_mode*)',
          `      if [ -f "${failOnceFlag}" ]; then`,
          `        rm -f "${failOnceFlag}"`,
          '        exit 1',
          '      fi',
          `      sleep ${(PROBE_DELAY_MS / 1000).toFixed(2)}`,
          '      break',
          '      ;;',
          '  esac',
          'done',
          `exec "${realTmux}" "$@"`,
        ].join('\n'),
        { mode: 0o755 }
      )
      fs.chmodSync(path.join(shimDir, 'tmux'), 0o755)

      port = await getFreePort()
      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH ?? ''}`,
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

      sessionIdA = await waitForDiscoveredSessionId(port, windowATarget)
      const idB = await waitForDiscoveredSessionId(port, windowBTarget)
      if (!idB) throw new Error('Server did not discover second tmux window')
      sessionIdB = idB
    }, 120000)

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
      for (const dir of [shimDir, tmuxTmpDir]) {
        if (!dir) continue
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    })

    async function openSocket(): Promise<{
      ws: WebSocket
      messages: ServerMessage[]
      firstReplyAt: () => number | null
    }> {
      const ws = new WebSocket(`ws://${testHost}:${port}/ws`)
      await waitForOpen(ws)
      const messages: ServerMessage[] = []
      const replyTimestamps: number[] = []
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as ServerMessage
          messages.push(parsed)
          if (parsed.type === 'tmux-copy-mode-status') {
            replyTimestamps.push(Date.now())
          }
        } catch {
          // ignore
        }
      }
      await waitUntil(
        () =>
          messages.some((m) => m.type === 'sessions') &&
          messages.some((m) => m.type === 'server-config'),
        5000,
        'initial sessions/config messages'
      )
      return {
        ws,
        messages,
        firstReplyAt: () => replyTimestamps[0] ?? null,
      }
    }

    const sendCheck = (ws: WebSocket, sessionId: string) =>
      ws.send(JSON.stringify({ type: 'tmux-check-copy-mode', sessionId }))

    const attach = (ws: WebSocket, sessionId: string, target: string) =>
      ws.send(
        JSON.stringify({
          type: 'terminal-attach',
          sessionId,
          tmuxTarget: target,
          cols: 120,
          rows: 40,
        })
      )

    const statusReplies = (messages: ServerMessage[], sessionId: string) =>
      messages.filter(
        (m) => m.type === 'tmux-copy-mode-status' && m.sessionId === sessionId
      )

    test(
      'status reply arrives and tracks copy-mode transitions',
      async () => {
        const { ws, messages } = await openSocket()
        messages.length = 0

        // Enter copy-mode server-side, then ask the server: reply must say so.
        runTmux(['copy-mode', '-t', windowATarget])
        sendCheck(ws, sessionIdA)
        await waitUntil(
          () =>
            statusReplies(messages, sessionIdA).some((m) => m.inCopyMode === true),
          10000,
          'inCopyMode:true reply'
        )

        // Cancel through the server's client-facing cancel path, then re-check.
        messages.length = 0
        ws.send(
          JSON.stringify({ type: 'tmux-cancel-copy-mode', sessionId: sessionIdA })
        )
        sendCheck(ws, sessionIdA)
        await waitUntil(
          () =>
            statusReplies(messages, sessionIdA).some((m) => m.inCopyMode === false),
          10000,
          'inCopyMode:false reply after cancel'
        )

        ws.close()
      },
      60000
    )

    test(
      'overlapping polls are skipped while a probe is in flight; keystrokes still forwarded',
      async () => {
        const { ws, messages, firstReplyAt } = await openSocket()
        attach(ws, sessionIdA, windowATarget)
        await waitUntil(
          () =>
            messages.some(
              (m) => m.type === 'terminal-ready' && m.sessionId === sessionIdA
            ),
          10000,
          'terminal-ready for session A'
        )
        messages.length = 0

        // Fire the first probe, then immediately type. The keystroke must land
        // in the pane while the probe is still in flight (probe delay 1.2s).
        sendCheck(ws, sessionIdA)
        const marker = `probe-inflight-${Date.now()}`
        ws.send(
          JSON.stringify({
            type: 'terminal-input',
            sessionId: sessionIdA,
            data: `echo "${marker}"\r`,
          })
        )
        let markerSeenAt: number | null = null
        await waitUntil(
          () => {
            if (capturePaneText(windowATarget, tmuxEnv()).includes(marker)) {
              markerSeenAt = Date.now()
              return true
            }
            return false
          },
          5000,
          'marker in pane while probe in flight'
        )
        // The probe completes later; once its reply lands, prove the keystroke
        // was not queued behind it.
        await waitUntil(
          () => firstReplyAt() !== null,
          10000,
          'first status reply after probe completes'
        )
        expect(markerSeenAt).not.toBeNull()
        expect(markerSeenAt!).toBeLessThan(firstReplyAt()!)

        // Hammer polls faster than the probe completes: they must be skipped,
        // not queued (10 polls, probe takes ~1.2s => at most a few replies).
        for (let i = 0; i < 9; i++) {
          await delay(200)
          sendCheck(ws, sessionIdA)
        }
        await waitUntil(
          () => statusReplies(messages, sessionIdA).length >= 1,
          10000,
          'at least one status reply'
        )
        await waitForStatusReplyQuiescence(messages, sessionIdA)

        const replies = statusReplies(messages, sessionIdA).length
        expect(replies).toBeGreaterThanOrEqual(1)
        expect(replies).toBeLessThanOrEqual(4)

        // The guard cleared after the successful probes: a later poll gets a
        // fresh, current reply.
        messages.length = 0
        sendCheck(ws, sessionIdA)
        await waitUntil(
          () => statusReplies(messages, sessionIdA).length === 1,
          10000,
          'fresh reply after guard cleared'
        )

        ws.close()
      },
      60000
    )

    test(
      'guard clears after a failed probe and later polls receive fresh replies',
      async () => {
        const { ws, messages } = await openSocket()
        messages.length = 0

        // Arm the shim to fail exactly one probe.
        fs.writeFileSync(failOnceFlag, '1', { flag: 'w' })
        sendCheck(ws, sessionIdA)
        await waitUntil(
          () => statusReplies(messages, sessionIdA).length === 1,
          10000,
          'reply after failed probe (assumes not in copy mode)'
        )
        expect(statusReplies(messages, sessionIdA)[0].inCopyMode).toBe(false)

        // The failure path must have cleared the in-flight guard.
        messages.length = 0
        sendCheck(ws, sessionIdA)
        await waitUntil(
          () => statusReplies(messages, sessionIdA).length === 1,
          10000,
          'fresh reply after failed probe'
        )

        ws.close()
      },
      60000
    )

    test(
      'a session switch during the probe does not mutate the new attachment',
      async () => {
        const { ws, messages } = await openSocket()
        messages.length = 0

        // Probe for A (in flight for ~1.2s), then switch the attachment to B
        // while it runs. The stale reply must be discarded entirely.
        sendCheck(ws, sessionIdA)
        await delay(150)
        attach(ws, sessionIdB, windowBTarget)
        await waitUntil(
          () =>
            messages.some(
              (m) => m.type === 'terminal-ready' && m.sessionId === sessionIdB
            ),
          10000,
          'terminal-ready for session B'
        )

        // Wait well past the probe completion.
        await delay(PROBE_DELAY_MS + 800)
        expect(statusReplies(messages, sessionIdA)).toHaveLength(0)

        // The new attachment receives fresh replies on the same socket.
        messages.length = 0
        sendCheck(ws, sessionIdB)
        await waitUntil(
          () => statusReplies(messages, sessionIdB).length === 1,
          10000,
          'reply for new attachment'
        )
        expect(statusReplies(messages, sessionIdB)[0].sessionId).toBe(sessionIdB)

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

/**
 * Waits until no new copy-mode status replies arrive for 800ms (bounded).
 * Batches the tail of a poll burst so reply counting is stable.
 */
async function waitForStatusReplyQuiescence(
  messages: ServerMessage[],
  sessionId: string,
  timeoutMs = 8000
): Promise<void> {
  const startedAt = Date.now()
  let lastCount = statusCountFor(messages, sessionId)
  let stableSince = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await delay(50)
    const count = statusCountFor(messages, sessionId)
    if (count !== lastCount) {
      lastCount = count
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= 800) return
  }
}

function statusCountFor(messages: ServerMessage[], sessionId: string): number {
  return messages.filter(
    (m) => m.type === 'tmux-copy-mode-status' && m.sessionId === sessionId
  ).length
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

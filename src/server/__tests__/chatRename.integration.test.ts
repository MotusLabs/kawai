/**
 * chatRename.integration.test.ts
 *
 * session-rename over the real WebSocket against a spawned server running the
 * development chat fixture: chat sessions accept free-text names (spaces and
 * punctuation, no uniqueness), the rename reaches the broadcast, an
 * empty-after-trim name is refused, and an unknown session is refused
 * (chat-session-naming design D5). Terminal renames keep their stricter
 * [\w-]+ rule in the non-chat branches of handleRename.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import type { ServerMessage } from '../../shared/types'
import {
  canBindLocalhost,
  createTmuxTmpDir,
  isTmuxAvailable,
} from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()
const localhostBindable = canBindLocalhost()
const testHost = '127.0.0.1'

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(
    `${reasons.join(' and ')} - skipping chat rename integration test`,
    () => {}
  )
} else {
  describe('chat session rename integration', () => {
    const sessionName = `agentboard-chatrename-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const dbPath = path.join(
      os.tmpdir(),
      `agentboard-chatrename-${process.pid}-${Date.now()}.db`
    )

    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0
    let tmuxTmpDir: string | null = null
    let socket: TestSocket | null = null
    let fixtureId = ''

    beforeAll(async () => {
      tmuxTmpDir = createTmuxTmpDir()
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
          TMUX_TMPDIR: tmuxTmpDir,
          // The development chat fixture gives this harness a live chat
          // session (and a permissive auth check) without the SDK.
          NODE_ENV: 'development',
          AGENTBOARD_CHAT_FIXTURE: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      drainStream(serverProcess.stdout)
      drainStream(serverProcess.stderr)

      await waitForHealth(port)
      socket = new TestSocket(port)
      const sessions = (await socket.waitFor(
        (message) => message.type === 'sessions',
        10_000
      )) as Extract<ServerMessage, { type: 'sessions' }>
      const fixture = sessions.sessions.find(
        (session) => session.kind === 'chat' && session.name === 'Chat fixture'
      )
      if (!fixture) throw new Error('Chat fixture session not found')
      fixtureId = fixture.id
    }, 60_000)

    afterAll(async () => {
      socket?.close()
      if (serverProcess) {
        try {
          serverProcess.kill()
          await serverProcess.exited
        } catch {
          // ignore shutdown errors
        }
      }
      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
          env: {
            ...process.env,
            ...(tmuxTmpDir ? { TMUX_TMPDIR: tmuxTmpDir } : {}),
          },
        })
      } catch {
        // ignore cleanup errors
      }
      if (tmuxTmpDir) {
        try {
          Bun.spawnSync(['tmux', 'kill-server'], {
            stdout: 'ignore',
            stderr: 'ignore',
            env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
          })
        } catch {
          // ignore cleanup errors
        }
        try {
          fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }
      }
      try {
        fs.unlinkSync(dbPath)
      } catch {
        // ignore cleanup errors
      }
    })

    test('renames a chat session with free text and broadcasts the update', async () => {
      const client = socket!
      const newName = 'Claude Code Chat subscription usage metrics spec!'
      client.send({ type: 'session-rename', sessionId: fixtureId, newName })
      const update = (await client.waitFor(
        (message) =>
          message.type === 'session-update' &&
          message.session?.id === fixtureId &&
          message.session?.name === newName
      )) as Extract<ServerMessage, { type: 'session-update' }>
      expect(update.session.kind).toBe('chat')
      expect(update.session.nameSource).toBe('manual')
    })

    test('duplicate chat names are allowed', async () => {
      const client = socket!
      client.send({
        type: 'session-create',
        projectPath: process.cwd(),
        kind: 'chat',
        name: 'shared name',
      })
      const created = (await client.waitFor(
        (message) =>
          message.type === 'session-created' && message.session?.kind === 'chat'
      )) as Extract<ServerMessage, { type: 'session-created' }>
      expect(created.session.name).toBe('shared name')
      // Renaming the fixture onto the same name is accepted, not refused.
      client.send({
        type: 'session-rename',
        sessionId: fixtureId,
        newName: 'shared name',
      })
      const update = (await client.waitFor(
        (message) =>
          message.type === 'session-update' &&
          message.session?.id === fixtureId &&
          message.session?.name === 'shared name'
      )) as Extract<ServerMessage, { type: 'session-update' }>
      expect(update.session.nameSource).toBe('manual')
    })

    test('an empty-after-trim name is refused', async () => {
      const client = socket!
      const mark = client.mark()
      client.send({ type: 'session-rename', sessionId: fixtureId, newName: '   ' })
      const error = (await client.waitFor(
        (message) => message.type === 'error',
        5_000,
        mark
      )) as Extract<ServerMessage, { type: 'error' }>
      expect(error.message).toBe('Name cannot be empty')
    })

    test('an unknown session is refused', async () => {
      const client = socket!
      const mark = client.mark()
      client.send({
        type: 'session-rename',
        sessionId: 'chat-no-such-session',
        newName: 'x',
      })
      const error = (await client.waitFor(
        (message) => message.type === 'error',
        5_000,
        mark
      )) as Extract<ServerMessage, { type: 'error' }>
      expect(error.message).toBe('Session not found')
    })
  })
}

/** WebSocket client collecting every message for waitFor() polling. */
class TestSocket {
  private readonly socket: WebSocket
  private readonly messages: ServerMessage[] = []
  private closed = false

  constructor(port: number) {
    this.socket = new WebSocket(`ws://${testHost}:${port}/ws`)
    this.socket.onmessage = (event) => {
      try {
        this.messages.push(JSON.parse(String(event.data)) as ServerMessage)
      } catch {
        // ignore bad payloads
      }
    }
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  /** Cursor for waitFor: only messages after this index are considered. */
  mark(): number {
    return this.messages.length
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 5_000,
    from = 0
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = () => {
        const found = this.messages.find(
          (message, index) => index >= from && predicate(message)
        )
        if (found) {
          resolve(found)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(
            new Error(
              `Timed out waiting for message; saw ${this.messages.length} messages`
            )
          )
          return
        }
        setTimeout(poll, 25)
      }
      poll()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.close()
  }
}

function drainStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined
): void {
  if (!stream || typeof stream === 'number') return
  const reader = stream.getReader()
  const pump = async () => {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  }
  void pump()
}

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

async function waitForHealth(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://${testHost}:${port}/api/health`)
      if (response.ok) {
        return
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Server did not become healthy in time')
}

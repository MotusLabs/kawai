// One private synthetic measurement through the same browser/server path as CI.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerProcess } from './fixtures/serverProcess'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development fixture')

// @covers: session-updates › The session list leaves out archived chats › Archived chats stay off the connect payload
// @covers: workspace-navigation › Reconnects skip an unchanged workspace snapshot › Reconnect with an unchanged workspace
test('synthetic 778/771 connect payload omits archived rows and unchanged workspace on reconnect', async ({ page }, info) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-connect-payload-')))
  const server = new ServerProcess()
  const port = Number(process.env.E2E_PORT || 4173) + 190
  const url = `http://127.0.0.1:${port}`
  const env = { ...process.env, HOME: root, TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'payload-browser',
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '0', AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
    LOG_FILE: join(root, 'agentboard.log'), AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', AGENTBOARD_REMOTE_HOSTS: '',
    AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'), PORT: String(port), HOSTNAME: '127.0.0.1' }
  for (const name of ['claude', 'codex', 'pi']) mkdirSync(join(root, name))
  const connections: Array<{ url: string; frames: string[] }> = []
  page.on('websocket', socket => {
    const connection = { url: socket.url(), frames: [] as string[] }
    connections.push(connection)
    socket.on('framereceived', frame => connection.frames.push(String(frame.payload)))
  })
  const messages = (index: number) => connections[index]?.frames.map(raw => JSON.parse(raw)) ?? []
  try {
    // Archived history may outlive its project directory. This fixture avoids
    // unrelated per-chat Git discovery for 771 identical existing paths.
    execFileSync('bun', ['tests/e2e/fixtures/seedArchive.ts', env.AGENTBOARD_DB_PATH, root, '771', '6', join(root, 'deleted-archive-project')], { env })
    execFileSync('tmux', ['new-session', '-d', '-s', 'payload-browser', '-n', 'test', '-c', root, 'bash --noprofile --norc'], { env })
    server.spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let all: Array<{ archivedAt?: string | null }> = []
    await expect.poll(async () => {
      try { all = await (await page.request.get(url + '/api/sessions', { timeout: 1000 })).json(); return all.length }
      catch { return 0 }
    }, { timeout: 30_000 }).toBe(778)
    expect(all.filter(row => !!row.archivedAt)).toHaveLength(771)
    await page.addInitScript(() => {
      const original = window.WebSocket
      const held: WebSocket[] = []
      ;(window as unknown as { slowLinkSockets: WebSocket[] }).slowLinkSockets = held
      window.WebSocket = class extends original {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); held.push(this) }
      }
    })
    await page.goto(url)
    await expect.poll(() => messages(0).some(message => message.type === 'workspace-snapshot'), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => messages(0).some(message => message.type === 'agent-sessions')).toBe(true)
    const first = messages(0)
    expect(new URL(connections[0]!.url).searchParams.has('workspace')).toBe(false)
    expect(first.find(message => message.type === 'sessions').sessions).toHaveLength(7)
    expect(first.find(message => message.type === 'sessions').sessions.every((row: { archivedAt?: string }) => !row.archivedAt)).toBe(true)
    expect(first.find(message => message.type === 'archive-summary').archivedCount).toBe(771)
    const digest = first.find(message => message.type === 'workspace-snapshot').digest
    await page.evaluate(() => (window as unknown as { slowLinkSockets: WebSocket[] }).slowLinkSockets.at(-1)!.close())
    await expect.poll(() => messages(1).some(message => message.type === 'agent-sessions'), { timeout: 20_000 }).toBe(true)
    expect(new URL(connections[1]!.url).searchParams.get('workspace')).toBe(digest)
    expect(messages(1).some(message => message.type === 'workspace-snapshot')).toBe(false)
    const describe = (index: number) => connections[index]!.frames.map(raw => ({ type: JSON.parse(raw).type, bytes: Buffer.byteLength(raw) }))
    const total = (index: number) => connections[index]!.frames.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0)
    const report = { synthetic: { total: 778, archived: 771, live: 7,
      workspace: 'plain temporary directory; no repository/worktree payload', archivedProjects: 'private deleted directory; no Git subprocess per archived row' },
      completeSessionsFrameBytes: Buffer.byteLength(JSON.stringify({ type: 'sessions', sessions: all })),
      first: describe(0), firstBytes: total(0), equalDigestReconnect: describe(1), reconnectBytes: total(1) }
    const destination = process.env.SLOW_LINK_MEASUREMENT_PATH ?? join(root, 'measurement.json')
    if (!destination.startsWith('/tmp/')) throw new Error('Measurement must stay in private /tmp artifacts')
    writeFileSync(destination, JSON.stringify(report, null, 2) + '\n')
    await info.attach('synthetic-connect-payload', { path: destination, contentType: 'application/json' })
  } catch (error) {
    await info.attach('owned-server-diagnostics', { body: server.diagnostics(), contentType: 'text/plain' })
    throw error
  } finally { await server.stop({ tmuxRoot: root }); rmSync(root, { recursive: true, force: true }) }
})

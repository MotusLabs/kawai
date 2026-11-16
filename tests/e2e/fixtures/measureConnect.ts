// One private synthetic 778/771 connect measurement; no live data or services.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { ServerProcess } from './serverProcess'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-connect-measure-')))
const server = new ServerProcess()
const listener = createServer()
await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = (listener.address() as { port: number }).port
await new Promise<void>(resolve => listener.close(() => resolve()))
const env = { ...process.env, HOME: root, TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'connect-measure',
  NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '0', AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
  LOG_FILE: join(root, 'agentboard.log'), AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
  CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
  CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', AGENTBOARD_REMOTE_HOSTS: '',
  PORT: String(port), HOSTNAME: '127.0.0.1' }
for (const dir of ['claude', 'codex', 'pi']) mkdirSync(join(root, dir))
async function connect(digest?: string) {
  const frames: string[] = []
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${digest ? '?workspace=' + digest : ''}`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connect probe timed out')), 20_000)
    socket.onmessage = event => {
      frames.push(String(event.data))
      const types = frames.map(raw => JSON.parse(raw).type)
      if (types.includes('agent-sessions') && types.includes('archive-summary') && (digest || types.includes('workspace-snapshot'))) {
        clearTimeout(timer); resolve()
      }
    }
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Probe socket failed')) }
  })
  // Observe the completed initial publication without counting later refreshes.
  await new Promise(resolve => setTimeout(resolve, 150))
  socket.close()
  return frames
}
try {
  execFileSync(process.execPath, ['tests/e2e/fixtures/seedArchive.ts', env.AGENTBOARD_DB_PATH, root, '771'], { env })
  execFileSync('tmux', ['new-session', '-d', '-s', 'connect-measure', '-n', '__agentboard_root__', 'tail -f /dev/null'], { env })
  server.spawn(process.execPath, ['src/server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  const started = Date.now()
  let all: unknown[] = []
  while (Date.now() - started < 30_000) {
    try { all = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json() as unknown[]; if (all.length === 778) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (all.length !== 778) throw new Error(`Expected exactly 778 synthetic rows, got ${all.length}: ${server.diagnostics()}`)
  const first = await connect()
  const digest = first.map(raw => JSON.parse(raw)).find(message => message.type === 'workspace-snapshot')?.digest
  if (!digest) throw new Error('Missing initial workspace digest')
  const repeated = await connect(digest)
  const describe = (frames: string[]) => frames.map(raw => ({ type: JSON.parse(raw).type, bytes: Buffer.byteLength(raw),
    ...(JSON.parse(raw).type === 'sessions' ? { rows: JSON.parse(raw).sessions.length } : {}) }))
  const report = { synthetic: { total: 778, archived: 771, live: 7, workspace: 'plain temporary directory; no repository/worktree payload' },
    model: process.env.SLOW_LINK_AUTHOR_MODEL ?? 'Unknown', bun: Bun.version,
    completeSessionsFrameBytes: Buffer.byteLength(JSON.stringify({ type: 'sessions', sessions: all })),
    first: describe(first), firstBytes: first.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0),
    equalDigestReconnect: describe(repeated), reconnectBytes: repeated.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) }
  const destination = process.argv[2]
  if (!destination?.startsWith('/tmp/')) throw new Error('Measurement output must be private /tmp artifact')
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await server.stop({ tmuxRoot: root }); rmSync(root, { recursive: true, force: true }) }

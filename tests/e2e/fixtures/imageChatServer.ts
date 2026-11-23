// Each image browser case owns its server, database, native homes and tmux.
// This also gives the strict Codex script its own first provider-usage read.
import { test as base } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { ServerProcess } from './serverProcess'

interface ImageServer { url: string; root: string; transcript: string }
async function freePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return port
}

export const imageChatTest = base.extend<{ imageServer: ImageServer; imageServerEnvironment: Record<string, string> }>({
  imageServerEnvironment: [{}, { option: true }],
  imageServer: async ({ imageServerEnvironment }, use) => {
    const root = await mkdtemp(join(tmpdir(), 'kawai-image-browser-'))
    const server = new ServerProcess()
    const transcript = join(root, 'codex-transcript.jsonl')
    const port = await freePort(), url = `http://127.0.0.1:${port}`
    try {
      for (const name of ['claude', 'codex', 'pi']) await mkdir(join(root, name))
      await writeFile(join(root, 'codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'fake' } }))
      server.spawn('bun', ['src/server/index.ts'], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...imageServerEnvironment, HOME: root, TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'image-e2e',
          NODE_ENV: 'development', AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
          LOG_FILE: join(root, 'agentboard.log'), AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
          CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
          CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', AGENTBOARD_REMOTE_HOSTS: '',
          FAKE_TRANSCRIPT: transcript, AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'), PORT: String(port), HOSTNAME: '127.0.0.1' },
      })
      const until = Date.now() + 30_000
      let ready = false
      while (!ready && Date.now() < until) {
        try { ready = (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok } catch {}
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!ready) throw Error(`Image test server did not start: ${server.diagnostics()}`)
      await use({ url, root, transcript })
    } finally {
      try { await server.stop({ tmuxRoot: root }) }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  },
  baseURL: async ({ imageServer }, use) => { await use(imageServer.url) },
})

// Uses its own seeded database, HOME, tmux server, port and owned server process.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerProcess } from './fixtures/serverProcess'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development fixture')

// @covers: workspace-navigation › Archived chats are fetched by id when referenced › Reload with an archived chat selected
// @covers: workspace-navigation › Archived chats are fetched by id when referenced › The chat no longer exists
test('archive pages and collapsed selection survive reload and reconnect with compressed assets', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-archive-lazy-')))
  const server = new ServerProcess()
  const port = Number(process.env.KAWAI_ARCHIVE_PORT ?? (Number(process.env.E2E_PORT || 4173) + 180))
  const url = `http://127.0.0.1:${port}`
  const env = { ...process.env, HOME: root, TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'archive-lazy',
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '1', AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
    LOG_FILE: join(root, 'agentboard.log'), AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', AGENTBOARD_REMOTE_HOSTS: '',
    AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'), PORT: String(port), HOSTNAME: '127.0.0.1' }
  for (const name of ['claude', 'codex', 'pi']) mkdirSync(join(root, name))
  const lists: Array<Array<{ archivedAt?: string | null }>> = []
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/chat/sessions/')) requests.push(request.url()) })
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(String(frame.payload))
    if (message.type === 'sessions') lists.push(message.sessions)
  }))
  try {
    execFileSync('bun', ['tests/e2e/fixtures/seedArchive.ts', env.AGENTBOARD_DB_PATH, root, '120'], { cwd: process.cwd(), env })
    execFileSync('tmux', ['new-session', '-d', '-s', 'archive-lazy'], { env })
    server.spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    await expect.poll(async () => { try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false } }, { timeout: 30_000 }).toBe(true)
    await page.addInitScript(() => {
      const original = window.WebSocket
      const held: WebSocket[] = []
      ;(window as unknown as { slowLinkSockets: WebSocket[] }).slowLinkSockets = held
      window.WebSocket = class extends original {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); held.push(this) }
      }
    })
    await page.goto(url)
    const header = page.getByTestId('fallback-section-header').filter({ has: page.getByRole('button', { name: 'Expand Archive section' }) })
    await expect(header).toHaveAttribute('data-session-count', '120')
    expect(requests.filter(url => url.includes('/archived?'))).toHaveLength(0)
    expect(lists.length).toBeGreaterThan(0)
    expect(lists[0]!.every(row => !row.archivedAt)).toBe(true)
    await page.getByRole('button', { name: 'Expand Archive section' }).click()
    const rows = page.getByTestId('archive-rows').locator('[data-session-id^="chat-archive-"]')
    await expect(rows).toHaveCount(50)
    const pane = page.getByTestId('archive-section').getByTestId('fallback-pane-scroll')
    await pane.evaluate(node => { node.scrollTop = node.scrollHeight })
    await expect(rows).toHaveCount(100)
    await rows.first().click({ force: true })
    await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
    await page.getByRole('button', { name: 'Collapse Archive section' }).click()
    const beforeReload = requests.length
    await page.reload()
    await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
    expect(requests.slice(beforeReload).some(url => url.includes('/rows?'))).toBe(true)
    expect(requests.slice(beforeReload).some(url => url.includes('/archived?'))).toBe(false)
    const beforeReconnect = lists.length
    await page.evaluate(() => (window as unknown as { slowLinkSockets: WebSocket[] }).slowLinkSockets.at(-1)!.close())
    await expect.poll(() => lists.length).toBeGreaterThan(beforeReconnect)
    await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
    const bundle = await page.locator('script[type="module"][src]').first().getAttribute('src')
    const response = await page.request.get(url + bundle, { headers: { 'Accept-Encoding': 'gzip, br' } })
    expect(response.headers()['content-encoding']).toBe('br')
    expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    await page.route('**/api/chat/sessions/rows?*', route => {
      const ids = new URL(route.request().url()).searchParams.get('ids')!.split(',')
      return route.fulfill({ json: { rows: [], unknown: ids } })
    })
    await page.reload()
    await expect(page.getByRole('complementary').getByText('Chat session was not found.', { exact: true })).toBeVisible()
  } finally { await server.stop({ tmuxRoot: root }); rmSync(root, { recursive: true, force: true }) }
})

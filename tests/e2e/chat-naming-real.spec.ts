import { expect, test } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.KAWAI_REAL_CHAT_TEST !== '1', 'Opt-in test makes real Claude requests')

// Chat session naming, end to end against the real SDK: an unnamed chat
// starts on a generated placeholder, adopts Claude Code's generated title
// while unclaimed (the row updates live, without opening anything), keeps a
// manual rename against later titles, and survives a server restart.

/** The deployment env (OAuth token + chat provider) without echoing values. */
function deploymentChatEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    for (const rawLine of readFileSync('/home/coder/kawai/.env', 'utf8').split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      // AGENTBOARD_CHAT_ENV keeps a quoted KEY=VALUE;KEY=VALUE payload.
      let value = line.slice(eq + 1).trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      env[key] = value
    }
  } catch {
    // No deployment env: the auth gate will refuse chat creation.
  }
  return env
}

test('placeholder names adopt generated titles and keep manual renames', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-chat-naming-'))
  const project = join(root, 'project')
  const claude = join(root, 'claude')
  const port = process.env.KAWAI_REAL_CHAT_PORT || '4195'
  const url = `http://127.0.0.1:${port}`
  mkdirSync(project)
  mkdirSync(claude)
  const env = {
    ...process.env,
    ...deploymentChatEnv(),
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '0',
    PORT: port, HOSTNAME: '127.0.0.1',
    AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'),
    AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
    LOG_FILE: join(root, 'agentboard.log'),
    TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'kawai-chat-naming',
    AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
    CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
    AGENTBOARD_REMOTE_HOSTS: '', ANTHROPIC_API_KEY: '',
  }
  let server: ChildProcess | null = null
  let diagnostics = ''
  const start = async () => {
    server = spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000) })
    server.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000) })
    await expect.poll(async () => {
      try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false }
    }, { timeout: 20_000 }).toBe(true)
  }
  const stop = async () => {
    if (!server || server.exitCode !== null) return
    const stopped = new Promise<void>(resolve => server!.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await stopped
    server = null
  }
  const send = async (text: string) => {
    await page.getByLabel('Message Claude').fill(text)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
  }
  const results: string[] = []
  const wsEvents: string[] = []
  page.on('websocket', ws => {
    wsEvents.push(`open ${ws.url()}`)
    ws.on('close', () => wsEvents.push(`close ${ws.url()} @ ${new Date().toISOString()}`))
    ws.on('socketerror', error => wsEvents.push(`error ${ws.url()}: ${String(error)}`))
  })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      wsEvents.push(`console.${message.type()}: ${message.text().slice(0, 300)}`)
    }
  })
  page.on('pageerror', error => wsEvents.push(`pageerror: ${String(error).slice(0, 300)}`))
  try {
    await start()
    await page.goto(url)
    await expect(page.locator('header button[aria-label="New session"]')).toBeVisible()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const modal = page.getByRole('dialog', { name: 'New Session' })
    await modal.getByLabel('Session kind').selectOption('chat')
    await modal.locator('input').first().fill(project)
    // No name: the session must start on a generated placeholder.
    await modal.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-view')).toBeVisible()
    const row = page.locator('[data-session-id^="chat-"]').first()
    const sessionId = await row.getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()
    const placeholder = (await row.innerText()).split('\n')[0]!.trim()
    expect(placeholder).toMatch(/^[a-z]+-[a-z]+$/)
    await expect(page.getByTestId('chat-name')).toContainText(`${placeholder} · Chat`)
    results.push(`Unnamed chat started on the placeholder "${placeholder}".`)

    await send('Without using any tools, reply with exactly KAWAI_NAME_OK and nothing else.')
    await expect.poll(async () => page.locator('[data-chat-role="assistant"]').last().innerText(), {
      timeout: 150_000,
    }).toContainText('KAWAI_NAME_OK')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    // The title query runs after the turn ends; the row adopts it live.
    await expect.poll(async () => (await row.innerText()).split('\n')[0]!.trim(), {
      timeout: 120_000,
    }).not.toBe(placeholder)
    const adopted = (await row.innerText()).split('\n')[0]!.trim()
    await expect(page.getByTestId('chat-name')).toContainText(`${adopted} · Chat`)
    results.push(`Unclaimed session adopted the generated title "${adopted}".`)

    await page.getByTestId('chat-name').click()
    await page.getByTestId('chat-name-input').fill('My manual name')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('chat-name')).toContainText('My manual name · Chat')
    await expect.poll(async () => (await row.innerText()).split('\n')[0]!.trim()).toBe('My manual name')
    results.push('Manual rename reached the header and the navigator row.')

    await send('Without using any tools, reply with exactly KAWAI_NAME_OK_2 and nothing else.')
    await expect.poll(async () => page.locator('[data-chat-role="assistant"]').last().innerText(), {
      timeout: 150_000,
    }).toContainText('KAWAI_NAME_OK_2')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    // A later retitle must not touch the manual name; give it the chance.
    await page.waitForTimeout(15_000)
    await expect.poll(async () => (await row.innerText()).split('\n')[0]!.trim()).toBe('My manual name')
    await expect(page.getByTestId('chat-name')).toContainText('My manual name · Chat')
    results.push('A manual rename survived later generated titles.')

    await stop()
    await start()
    await page.reload()
    // Nobody opens the chat: the navigator itself shows the kept name.
    await expect
      .poll(async () => (await page.locator(`[data-session-id="${sessionId}"]`).first().innerText()).split('\n')[0]!.trim())
      .toBe('My manual name')
    results.push('After a restart the navigator still shows the manual name without opening the chat.')
  } finally {
    mkdirSync(info.outputDir, { recursive: true })
    writeFileSync(info.outputPath('server-diagnostics.log'), diagnostics)
    writeFileSync(info.outputPath('walkthrough-results.txt'), results.join('\n'))
    await info.attach('walkthrough-results', { body: results.join('\n'), contentType: 'text/plain' })
    await info.attach('server-diagnostics', { body: diagnostics, contentType: 'text/plain' })
    await stop()
    // Transcript tail: the ground truth for whether a title row ever landed.
    let transcriptDump = '(no transcript found)'
    for (const dir of readdirSync(claude, { recursive: true })) {
      const entry = String(dir)
      if (!entry.endsWith('.jsonl')) continue
      const content = readFileSync(join(claude, entry), 'utf8')
      const titleLines = content.split('\n').filter(line => line.includes('"title"'))
      transcriptDump =
        `file: ${entry}\n` +
        `lines: ${content.split('\n').length}\n` +
        `title lines:\n${titleLines.join('\n') || '(none)'}\n\n` +
        `tail:\n${content.slice(-2000)}`
    }
    await info.attach('transcript', { body: transcriptDump, contentType: 'text/plain' })
    await info.attach('ws-events', { body: wsEvents.join('\n'), contentType: 'text/plain' })
    spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' })
    rmSync(root, { recursive: true, force: true })
  }
})

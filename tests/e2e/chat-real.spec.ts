import { expect, test } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.KAWAI_REAL_CHAT_TEST !== '1', 'Opt-in test makes real Claude requests')

test('real chat approvals, questions, interrupt, reconnect, restart, recovery, and kill', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-real-chat-'))
  const project = join(root, 'project')
  const claude = join(root, 'claude')
  const port = process.env.KAWAI_REAL_CHAT_PORT || '4190'
  const url = `http://127.0.0.1:${port}`
  mkdirSync(project)
  mkdirSync(claude)
  const env = {
    ...process.env,
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '0',
    PORT: port, HOSTNAME: '127.0.0.1',
    AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'),
    AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
    LOG_FILE: join(root, 'agentboard.log'),
    TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'kawai-real-chat',
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
  try {
    await start()
    await page.goto(url)
    await expect(page.getByRole('button', { name: 'New session', exact: true }).first()).toBeVisible()
    // Wait for initial server config, avoiding creation before the socket opens.
    await expect(page.locator('header button[aria-label="New session"]')).toBeVisible()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const modal = page.getByRole('dialog', { name: 'New Session' })
    await modal.getByLabel('Session kind').selectOption('chat')
    await modal.locator('input').first().fill(project)
    await modal.locator('input').last().fill('Real SDK walkthrough')
    await modal.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-view')).toContainText('Real SDK walkthrough')
    const row = page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Real SDK walkthrough' }).first()
    const sessionId = await row.getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()
    results.push('Created a real OAuth-authenticated chat session.')

    await send(`Use the Write tool to create ${join(project, 'first.txt')} containing exactly ready. Then reply KAWAI_FIRST_OK. Do not use Bash.`)
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(page.locator('[data-chat-role="assistant"]').last()).toContainText('KAWAI_FIRST_OK')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    results.push('Write approval survived reload and completed after Allow.')

    await send('Use AskUserQuestion to ask "Which color?" with Blue and Green options. Wait for my answer, then acknowledge it. Do not choose for me.')
    await expect(page.getByRole('button', { name: 'Submit answers' })).toBeVisible()
    await page.getByTestId('chat-requests').locator('input[type="radio"], input[type="checkbox"]').first().check()
    await page.getByRole('button', { name: 'Submit answers' }).click()
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    results.push('Answered a real AskUserQuestion request.')

    await send(`Use Write to create ${join(project, 'stopped.txt')} containing stopped. Do not use other tools.`)
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    results.push('Interrupted a real turn while Write approval was pending.')

    await send('Without tools, explain rainbows in 400 words. Start with KAWAI_STREAM_OK.')
    await expect(page.locator('[data-chat-role="assistant"]').last()).toContainText('KAWAI_STREAM_OK')
    await page.reload()
    await expect(page.locator('[data-chat-role="assistant"]').last()).toContainText('KAWAI_STREAM_OK')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    results.push('Reconnected while a real response streamed.')

    await stop()
    await start()
    await page.reload()
    await page.locator(`[data-session-id="${sessionId}"]`).first().click()
    await expect(page.locator('[data-chat-role="assistant"]').filter({ hasText: 'KAWAI_FIRST_OK' })).toHaveCount(1)
    await send('What was the content of the first file I asked you to write? Answer in one short sentence without tools.')
    await expect(page.locator('[data-chat-role="assistant"]').last()).toContainText('ready', { ignoreCase: true })
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    results.push('Restarted the server, replayed history, and resumed the same conversation.')

    await stop()
    const transcripts: string[] = []
    const findTranscripts = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) findTranscripts(path)
        else if (entry.name.endsWith('.jsonl')) transcripts.push(path)
      }
    }
    findTranscripts(claude)
    const transcript = transcripts.find(path => !path.includes('/subagents/'))
    expect(transcript).toBeTruthy()
    renameSync(transcript!, `${transcript}.backup`)
    await start()
    await page.reload()
    await page.locator(`[data-session-id="${sessionId}"]`).first().click()
    await expect(page.getByTestId('chat-transcript')).toContainText('history unavailable', { ignoreCase: true })
    await send('Continue')
    await expect(page.getByRole('alert')).toContainText('transcript is missing')
    await stop()
    renameSync(`${transcript}.backup`, transcript!)
    await start()
    await page.reload()
    await page.locator(`[data-session-id="${sessionId}"]`).first().click()
    results.push('Missing transcript produced an actionable error; restored the original file.')

    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
    await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0)
    await stop()
    await start()
    await page.reload()
    await page.waitForTimeout(1000)
    await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0)
    results.push('Killed the session and verified another restart did not restore it.')
  } finally {
    mkdirSync(info.outputDir, { recursive: true })
    writeFileSync(info.outputPath('server-diagnostics.log'), diagnostics)
    writeFileSync(info.outputPath('walkthrough-results.txt'), results.join('\n'))
    await info.attach('walkthrough-results', { body: results.join('\n'), contentType: 'text/plain' })
    await info.attach('server-diagnostics', { body: diagnostics, contentType: 'text/plain' })
    await stop()
    spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' })
    rmSync(root, { recursive: true, force: true })
  }
})

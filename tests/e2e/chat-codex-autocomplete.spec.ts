// Codex autocomplete W1-W3/S3: real browser -> server/driver -> fake RPC.
// The fake asserts the actual native input before returning success text.
// Like chat-codex.spec, it owns a private server and CODEX_HOME: its script
// takes the once-per-server account/rateLimits/read, which an earlier Codex
// chat in a shared server would already have claimed, and stopping that
// server with its root removes every chat this spec made.
import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Script } from '../fixtures/codexTranscript'
import { ServerProcess } from './fixtures/serverProcess'
import { killChat } from './support/chatHeader'
import type { ClientMessage, ServerMessage } from '../../src/shared/types'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

test('Codex autocomplete selects without sending, refreshes both browsers, and invokes the exact native skill', async ({ page, context }, info) => {
  const project = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'codex-autocomplete-e2e-')))
  const rollout = path.join(project, 'rollout.jsonl')
  const gate = path.join(project, 'refresh')
  const skills = (names: string[]) => ({ data: [{ cwd: project, errors: [], skills: names.map(name => ({
    name, path: `/skills/${name}/SKILL.md`, description: name === 'explore' ? 'Investigate code' : 'Find defects', scope: 'repo', enabled: true,
  })) }] })
  const text = 'please /review on this'
  const sent: ClientMessage[] = []
  const created: string[] = []
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-autocomplete-')))
  const ownedServer = new ServerProcess()
  const port = Number(process.env.E2E_PORT || 4173) + 210
  const url = `http://127.0.0.1:${port}`
  const transcript = path.join(root, 'codex-transcript.jsonl')
  const env = { ...process.env, HOME: root, TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'codex-autocomplete',
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '1', AGENTBOARD_DB_PATH: path.join(root, 'agentboard.db'),
    LOG_FILE: path.join(root, 'agentboard.log'), AGENTBOARD_TMUX_PID_FILE: path.join(root, 'tmux.pid'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), PI_HOME: path.join(root, 'pi'),
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', AGENTBOARD_REMOTE_HOSTS: '',
    KAWAI_CODEX_PATH: process.env.KAWAI_CODEX_PATH, FAKE_TRANSCRIPT: transcript,
    AGENTBOARD_STATIC_DIR: path.join(process.cwd(), 'dist/client'), PORT: String(port), HOSTNAME: '127.0.0.1' }
  for (const name of ['claude', 'codex', 'pi']) mkdirSync(path.join(root, name))
  // The login gate's fake auth.json, as playwright.config writes it.
  writeFileSync(path.join(root, 'codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'fake' } }))
  const cleanupErrors: unknown[] = []
  try {
    await page.routeWebSocket(/\/ws$/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        if (typeof message === 'string') sent.push(JSON.parse(message) as ClientMessage)
        server.send(message)
      })
      server.onMessage(message => {
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as ServerMessage
          if (frame.type === 'session-created') created.push(frame.session.id)
        }
        socket.send(message)
      })
    })
    await mkdir(path.join(project, '.kawai'))
    await writeFile(path.join(project, '.kawai/profiles.json'), JSON.stringify({ codex: { label: 'Codex Autocomplete', runtime: 'codex' } }))
    const script = new Script().boot('thread/start', 'test', rollout).request('account/rateLimits/read', {})
      .request('skills/list', skills(['explore', 'review'])).gate(gate)
      .notify('skills/changed', {}).request('skills/list', skills(['review']))
      .turn('ct-1').assertInput([{ type: 'text', text, text_elements: [] }, { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }])
      .append(rollout).item('completed', 'ct-1', { type: 'agentMessage', id: 'answer', text: 'Native skill input verified', questions: null }).completed('ct-1')
      .turn('ct-2').assertInput([{ type: 'text', text: '/missing', text_elements: [] }])
      .item('completed', 'ct-2', { type: 'agentMessage', id: 'unknown', text: 'Unknown command stayed text', questions: null }).completed('ct-2')
    await writeFile(transcript, script.lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    ownedServer.spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    await expect.poll(async () => { try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false } }, { timeout: 30_000 }).toBe(true)
    await page.goto(url)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    await dialog.getByLabel('Project Path').fill(project)
    await expect(dialog.getByLabel('Profile').locator('option', { hasText: 'Codex Autocomplete' })).toHaveCount(1)
    await dialog.getByLabel('Profile').selectOption('codex')
    await dialog.getByLabel('Display Name').fill('Codex autocomplete')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    const input = page.getByLabel('Message Claude')
    await input.fill('/')
    await expect(page.getByRole('option', { name: /explore/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /review/ })).toBeVisible()
    await input.fill('please /invest on this')
    for (let i = 0; i < 8; i++) await input.press('ArrowLeft')
    await expect(page.getByRole('option', { name: /explore/ })).toBeVisible()
    await input.press('Tab')
    await expect(input).toHaveValue('please /explore on this')
    await expect(page.locator('[data-chat-role="user"]')).toHaveCount(0)
    await input.fill('first\n/')
    await input.press('ArrowDown')
    // Stationary-pointer regression (r1#ecfe1b7633b3, diagnosis task-acaf9d73):
    // Chromium re-emits pointer boundary events, without movement, on the row
    // under a parked cursor when the menu mounts or re-renders, and React
    // synthesizes enter from over/out pairs — so dispatching the bare over
    // event at each keyboard transition reproduces that burst
    // deterministically. The keyboard choice must survive it: pre-fix this
    // flipped to /explore at the assert below and the Enter then inserted
    // /review, exactly like the recurring CI fixture failure.
    await page.getByRole('option', { name: /explore/ }).dispatchEvent('pointerover')
    await expect(page.getByRole('option', { name: /review/ })).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowUp')
    await page.getByRole('option', { name: /review/ }).dispatchEvent('pointerover')
    await input.press('Enter')
    await expect(input).toHaveValue('first\n/explore ')
    await input.fill('/'); await page.getByRole('option', { name: /review/ }).hover()
    await expect(page.getByRole('option', { name: /review/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('option', { name: /review/ }).click()
    await expect(input).toHaveValue('/review ')
    // Touch activation still chooses directly: the tap's synthesized click is
    // untouched by the pointer-highlight wiring. A fresh hasTouch context has
    // no stored session selection, so the chat opens from the navigator row.
    const touchContext = await page.context().browser()!.newContext({ hasTouch: true })
    const touchPage = await touchContext.newPage()
    await touchPage.goto(page.url())
    await touchPage.getByRole('button', { name: /Codex autocomplete/ }).first().click()
    await touchPage.getByLabel('Message Claude').fill('/')
    await touchPage.getByRole('option', { name: /review/ }).tap()
    await expect(touchPage.getByLabel('Message Claude')).toHaveValue('/review ')
    await touchContext.close()
    for (const value of ['https://example', '/usr/bin']) { await input.fill(value); await expect(page.getByRole('listbox', { name: 'Slash commands' })).toHaveCount(0) }
    await input.fill('/expl'); await input.press('Escape'); await expect(input).toHaveValue('/expl')
    const other = await context.newPage(); await other.goto(page.url())
    await other.getByLabel('Message Claude').fill('/')
    await expect(other.getByRole('option', { name: /explore/ })).toBeVisible()
    await writeFile(gate, '')
    for (const browser of [page, other]) {
      await browser.getByLabel('Message Claude').fill('/')
      await expect(browser.getByRole('option', { name: /explore/ })).toHaveCount(0)
      await expect(browser.getByRole('option', { name: /review/ })).toBeVisible()
    }
    await page.screenshot({ path: info.outputPath('codex-autocomplete-menu.png') })
    await other.close()
    await input.fill('please /rev on this')
    for (let i = 0; i < 8; i++) await input.press('ArrowLeft')
    await input.press('Tab'); await expect(input).toHaveValue(text)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('chat-transcript')).toContainText('Native skill input verified')
    await input.fill('/missing'); await input.press('Enter')
    await expect(page.getByTestId('chat-transcript')).toContainText('Unknown command stayed text')
    await expect(page.locator('[data-chat-role="user"]')).toHaveCount(2)
    await page.screenshot({ path: info.outputPath('codex-autocomplete-invoked.png') })
    // Local reset commands keep the Codex profile/policy and archive only
    // after replacement creation. Later children need no home-wide usage fill.
    const replacement = new Script().boot('thread/start', 'test', rollout).request('skills/list', skills(['review']))
    await writeFile(transcript, replacement.lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    for (const command of ['/clear', '/reset', '/new']) {
      const previous = created.at(-1)!
      const count = created.length
      const sends = sent.filter(message => message.type === 'chat-send').length
      await input.fill(command); await input.press('Enter')
      await expect.poll(() => created.length).toBe(count + 1)
      await expect.poll(() => sent.some(message => message.type === 'chat-archive' && message.sessionId === previous)).toBe(true)
      expect(sent.filter(message => message.type === 'chat-send')).toHaveLength(sends)
      expect(sent.filter(message => message.type === 'session-create').at(-1)).toMatchObject({ claudeProfileId: 'codex', approvalPolicy: 'manual' })
      await expect(page.getByTestId('chat-profile')).toHaveText('Codex · Codex Autocomplete')
    }
    await killChat(page)
  } finally {
    // Stopping the private server and removing its root takes every chat
    // this spec created, passed or failed. A cleanup error is annotated and
    // fails a passing test below, but never replaces the original failure.
    await ownedServer.stop({ tmuxRoot: root }).catch(error => {
      cleanupErrors.push(error)
      info.annotations.push({ type: 'cleanup-error', description: String(error) })
    })
    rmSync(root, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0]
})

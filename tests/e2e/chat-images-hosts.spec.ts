import { expect, type Page } from '@playwright/test'
import { imageChatTest as test } from './fixtures/imageChatServer'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_IMAGE_RED_BASE64 } from '../fixtures/chatImage'
import { Script } from '../fixtures/codexTranscript'
import { killChat } from './support/chatHeader'
import type { ChatImage } from '../../src/shared/chatImages'
import type { ServerMessage } from '../../src/shared/types'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')
test.use({ imageServerEnvironment: { AGENTBOARD_CHAT_FIXTURE: '1' } })

async function paste(page: Page) {
  await page.getByLabel('Message Claude').evaluate((target, base64) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, CHAT_IMAGE_RED_BASE64)
}

async function create(page: Page, project: string, name: string, profile?: string, navigate = true) {
  if (navigate) await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.getByLabel('Project Path').fill(project)
  if (profile) {
    await expect(dialog.getByLabel('Profile').locator(`option[value="${profile}"]`)).toHaveCount(1)
    await dialog.getByLabel('Profile').selectOption(profile)
  }
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  await expect(page.getByLabel('Message Claude')).toBeVisible()
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

test('Codex native adapter carries image-only and mixed sends through the production server', async ({ page, imageServer }) => {
  const project = await mkdtemp(join(tmpdir(), 'kawai-image-codex-'))
  const rollout = join(project, 'rollout.jsonl')
  try {
    await mkdir(join(project, '.kawai'))
    await writeFile(join(project, '.kawai/profiles.json'), JSON.stringify({ 'image-codex': { label: 'Image Codex', runtime: 'codex' } }))
    await writeFile(rollout, '')
    const script = new Script().boot('thread/start', 'gpt-test', rollout).request('account/rateLimits/read', {})
      .turn('image-only').append(rollout).completed('image-only')
      .turn('mixed').append(rollout).completed('mixed')
    await writeFile(imageServer.transcript, script.lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    await create(page, project, 'Image Codex browser', 'image-codex')
    await paste(page)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByLabel('Attached images')).toHaveCount(0)
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(1)
    await paste(page)
    await page.getByLabel('Message Claude').fill('compare this screenshot')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByLabel('Attached images')).toHaveCount(0)
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(2)
    await expect(page.getByTestId('chat-transcript')).toContainText('compare this screenshot')
    await page.reload()
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(2)
    await killChat(page)
  } finally {
    await rm(imageServer.transcript, { force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('embedded repository conversation preserves pasted images across host navigation', async ({ page }) => {
  const bindingFrames: unknown[] = []
  page.on('websocket', socket => {
    for (const event of ['framesent', 'framereceived'] as const) socket.on(event, frame => {
      const message = JSON.parse(String(frame.payload))
      if (String(message.type).includes('workspace-bind') || message.type === 'team-plan-workspace-result' || message.type === 'error') bindingFrames.push(message)
    })
  })
  const project = await mkdtemp(join(tmpdir(), 'kawai-image-embedded-'))
  try {
    const id = await create(page, project, 'Image embedded browser')
    await page.evaluate(root => { window.location.hash = `#/team/${encodeURIComponent(root)}/plans` }, project)
    await page.getByTestId('plans-conversation-toggle').click()
    const host = page.getByTestId('plan-workspace-conversation')
    await expect(host).toBeVisible()
    await host.getByTestId('conversation-bind-picker').selectOption(id)
    try { await expect(host.getByLabel('Message Claude')).toBeVisible() }
    catch (error) { console.log('Embedded binding frames:', JSON.stringify(bindingFrames)); throw error }
    await paste(page)
    await expect(host.getByLabel('Attached images').getByRole('img')).toHaveCount(1)
    await page.getByTestId('conversation-role-lead').click()
    await page.getByTestId('conversation-role-architect').click()
    await expect(host.getByLabel('Attached images').getByRole('img')).toHaveCount(1)
    await host.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(host.getByLabel('Attached images')).toHaveCount(0)
    await expect(host.getByTestId('chat-transcript').getByRole('img')).toHaveCount(1)
  } finally { await rm(project, { recursive: true, force: true }) }
})

test('navigation during image upload sends only to the captured original session', async ({ page }) => {
  const project = await mkdtemp(join(tmpdir(), 'kawai-image-navigation-'))
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  try {
    const first = await create(page, project, 'Image navigation A')
    await page.route('**/api/chat/*/images', async route => { await hold; await route.continue() })
    await paste(page)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Uploading images' })).toBeVisible()
    await create(page, project, 'Image navigation B', undefined, false)
    release()
    await expect(page.getByLabel('Attached images')).toHaveCount(0)
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(0)
    await page.locator(`[data-session-id="${first}"]`).click()
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(1)
    await expect(page.getByLabel('Attached images')).toHaveCount(0)
  } finally { release?.(); await rm(project, { recursive: true, force: true }) }
})

// A socket fixture supplies an older native-projected image event; upload,
// current-turn sending, HTTP image reads, and the production UI stay real.
test('loading an older image message displays its scoped asset above the current conversation', async ({ page }) => {
  const project = await mkdtemp(join(tmpdir(), 'kawai-image-history-'))
  let sessionId = '', image: ChatImage | undefined
  try {
    await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw))
        if (message.type === 'chat-history-page' && message.sessionId === sessionId && image) {
          socket.send(JSON.stringify({ type: 'chat-history-page', sessionId, beforeId: message.beforeId,
            events: [{ type: 'user_message', id: 'older-image-fixture', sequence: 0, turnId: 'older-turn', at: '2026-11-01T10:00:00Z', text: 'Earlier image message', images: [image] }], hasOlder: false,
          }))
        } else server.send(raw)
      })
      server.onMessage(raw => {
        const message = JSON.parse(String(raw)) as ServerMessage
        if (message.type === 'chat-snapshot' && message.sessionId === sessionId && image) {
          socket.send(JSON.stringify({ ...message, historyHasOlder: true }))
        } else {
          if (message.type === 'chat-events' && message.sessionId === sessionId) {
            const user = message.events.find(event => event.type === 'user_message' && event.images?.length)
            if (user?.type === 'user_message') image = user.images![0]
          }
          socket.send(raw)
        }
      })
    })
    sessionId = await create(page, project, 'Image history browser')
    await paste(page)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(1)
    await page.reload()
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
    await expect(page.getByTestId('chat-transcript')).toContainText('Earlier image message')
    await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(2)
    await expect(page.getByText('Beginning of conversation', { exact: true })).toBeVisible()
  } finally { await rm(project, { recursive: true, force: true }) }
})

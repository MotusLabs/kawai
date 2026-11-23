import { expect, type Page } from '@playwright/test'
import { imageChatTest as test } from './fixtures/imageChatServer'
import { CHAT_IMAGE_RED_BASE64 } from '../fixtures/chatImage'
import { archiveChat } from './support/chatHeader'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')
test.use({ imageServerEnvironment: { AGENTBOARD_CHAT_FIXTURE: '1' } })

async function pasteImage(page: Page) {
  await page.getByLabel('Message Claude').evaluate((textarea, data) => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, CHAT_IMAGE_RED_BASE64)
}

async function openFixture(page: Page) {
  await page.goto('/')
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Chat fixture' }).first().waitFor({ state: 'attached' })
  const expandArchive = page.getByRole('button', { name: 'Expand Archive section', exact: true })
  if (await expandArchive.isVisible()) await expandArchive.click()
  // Archive rows inherit aria-disabled from their disabled drag handle;
  // their ordinary click handler still opens the retained conversation.
  const fixture = page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Chat fixture' }).first()
  await expect(fixture).toBeVisible()
  await fixture.click({ force: true })
  const restore = page.getByRole('button', { name: 'Restore', exact: true })
  if (await restore.isVisible()) await restore.click()
  await expect(page.getByLabel('Message Claude')).toBeVisible()
}

test('image-only paste uploads on Send, renders real pixels, survives reload and archive', async ({ page }) => {
  const uploads: string[] = [], sends: Array<Record<string, unknown>> = []
  page.on('request', request => { if (request.method() === 'POST' && /\/images$/.test(request.url())) uploads.push(request.url()) })
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload))
    if (message.type === 'chat-send') sends.push(message)
  }))
  await openFixture(page)
  await pasteImage(page); await pasteImage(page)
  await expect(page.getByLabel('Attached images')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove image 2' })).toBeVisible()
  expect(uploads).toHaveLength(0)
  await page.getByRole('button', { name: 'Remove image 1' }).click()
  await expect(page.getByLabel('Attached images').getByRole('img')).toHaveCount(1)
  const before = await page.getByTestId('chat-transcript').getByRole('img').count()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('Attached images')).toHaveCount(0)
  const images = page.getByTestId('chat-transcript').getByRole('img', { name: 'Attached image 1' })
  await expect(images).toHaveCount(before + 1)
  await expect.poll(() => images.last().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(32)
  expect(uploads).toHaveLength(1)
  expect(sends.at(-1)?.text).toBe('')
  expect(sends.at(-1)?.images).toHaveLength(1)
  expect(JSON.stringify(sends.at(-1))).not.toContain('base64')
  await page.reload()
  // Selection is stored in the URL; if a reload returns to the navigator,
  // select the same fixture again without manufacturing conversation rows.
  if (!await page.getByTestId('chat-view').isVisible()) await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Chat fixture' }).first().click()
  await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(before + 1)
  page.once('dialog', dialog => dialog.accept())
  await archiveChat(page)
  // Archiving selects the next live session. Open the retained archived
  // chat explicitly before checking its read-only conversation.
  await page.getByRole('button', { name: 'Expand Archive section', exact: true }).click()
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Chat fixture' }).first().click({ force: true })
  await expect(page.getByLabel('Message Claude')).toHaveCount(0)
  await expect(page.getByTestId('chat-transcript').getByRole('img')).toHaveCount(before + 1)
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
})

test('upload refusal and local reset retain the editable image draft', async ({ page }) => {
  await openFixture(page)
  await pasteImage(page)
  await page.getByLabel('Message Claude').fill('/clear')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Remove the attached images' })).toBeVisible()
  await expect(page.getByLabel('Message Claude')).toHaveValue('/clear')
  await page.getByLabel('Message Claude').fill('screenshot')
  await page.route('**/api/chat/*/images', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Injected upload failure' }) }))
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Injected upload failure' })).toBeVisible()
  await expect(page.getByLabel('Message Claude')).toHaveValue('screenshot')
  await expect(page.getByLabel('Attached images').getByRole('img')).toHaveCount(1)
})

test('real browser clipboard keyboard paste creates a local image preview', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixture(page)
  await page.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, CHAT_IMAGE_RED_BASE64)
  await page.getByLabel('Message Claude').focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect(page.getByLabel('Attached images').getByRole('img')).toHaveCount(1)
  await page.getByRole('button', { name: 'Remove image 1' }).click()
  await page.getByLabel('Message Claude').fill('start ')
  await page.evaluate(() => navigator.clipboard.writeText('pasted text'))
  await page.getByLabel('Message Claude').focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect(page.getByLabel('Message Claude')).toHaveValue('start pasted text')
  await pasteImage(page)
  await page.reload()
  await expect(page.getByLabel('Message Claude')).toHaveValue('')
  await expect(page.getByLabel('Attached images')).toHaveCount(0)
})

// Chat font size: computed sizes in a real browser. Chat text is em-sized from
// --chat-font-size (default 15px, Settings "Chat Font Size"), independent of
// the 13px root and the terminal font size; the composer stays at 16px or more
// on coarse pointers so iOS does not zoom on focus.
import { expect, test, type Locator, type Page } from '@playwright/test'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

const fontSize = (locator: Locator) => locator.evaluate(node => getComputedStyle(node).fontSize)
const px = (value: string) => Number.parseFloat(value)

// Each test creates (and kills) its own chat session: the shared "Chat fixture"
// session starts with a pending approval and is driven by chat.spec.ts.
async function createChat(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.locator('input').first().fill(process.cwd())
  await dialog.locator('input').last().fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

async function sendMarkdown(page: Page) {
  await page.getByLabel('Message Claude').fill('markdown')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('chat-transcript').getByRole('heading', { name: 'Markdown showcase' })).toBeVisible()
  await expect(page.getByTestId('chat-transcript').getByText(/Turn complete/)).toBeVisible()
}

async function killChat(page: Page) {
  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
}

function storedSettings(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('agentboard-settings') ?? '{}').state ?? {})
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('chat-font-size-seeded')) return
    sessionStorage.setItem('chat-font-size-seeded', '1')
    localStorage.removeItem('agentboard-settings')
  })
})

test('chat text defaults to 15px and follows the Chat Font Size setting', async ({ page }, info) => {
  await createChat(page, 'Font size chat')
  await sendMarkdown(page)
  const transcript = page.getByTestId('chat-transcript')
  const userBody = transcript.locator('[data-chat-role="user"] p').last()
  const userLabel = transcript.locator('[data-chat-role="user"] > div').last()
  const assistant = transcript.locator('[data-chat-role="assistant"]').last()
  const footer = transcript.getByText(/Turn complete/).last()

  expect(await fontSize(userBody)).toBe('15px')
  expect(await fontSize(assistant.locator('p').first())).toBe('15px')
  expect(await fontSize(userLabel)).toBe('12px')
  expect(await fontSize(footer)).toBe('12px')
  await page.screenshot({ path: info.outputPath('chat-font-15.png') })

  const terminalSizeBefore = (await storedSettings(page)).fontSize
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Increase Chat Font Size' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  expect(await fontSize(userBody)).toBe('18px')
  expect(await fontSize(assistant.locator('p').first())).toBe('18px')
  expect(px(await fontSize(assistant.locator('h1').first()))).toBeGreaterThan(18)
  expect(px(await fontSize(assistant.locator('h2').first()))).toBeGreaterThan(18)
  expect(await fontSize(page.getByLabel('Message Claude'))).toBe('18px')
  // List indent scales with the text so wider numbers stay inside the column.
  expect(await assistant.locator('ol').first().evaluate(node => getComputedStyle(node).paddingLeft)).toBe('27px')
  const stored = await storedSettings(page)
  expect(stored.chatFontSize).toBe(18)
  expect(stored.fontSize).toBe(terminalSizeBefore)
  await page.screenshot({ path: info.outputPath('chat-font-18.png') })

  await page.reload()
  await expect(page.getByTestId('chat-view')).toBeVisible()
  expect(await fontSize(page.getByTestId('chat-view'))).toBe('18px')
  await killChat(page)
})

test.describe('on a touch device', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('the composer stays at 16px when the chat font size is smaller', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('agentboard-settings', JSON.stringify({ state: { chatFontSize: 13 }, version: 7 }))
    })
    await createChat(page, 'Touch font chat')
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    expect(await fontSize(page.getByTestId('chat-view'))).toBe('13px')
    expect(await fontSize(page.getByLabel('Message Claude'))).toBe('16px')
    await killChat(page)
  })
})

// The chat header in a real browser against the development fixture
// (chat-header-layout): the session menu's entries, keyboard operation, and
// focus return; Debug from the menu replacing an open panel; the archived
// menu; and the kill confirmation (Cancel, Escape, confirm).
import { expect, test, type Page } from '@playwright/test'
import { killChat, openSessionMenu } from './support/chatHeader'

// Serial: every client selects each newly created session (App.tsx
// session-created), so parallel creations would yank each other's view.
test.describe.configure({ mode: 'serial' })

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

async function createChat(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.getByLabel('Project Path').fill(process.cwd())
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-name')).toHaveText(name)
}

const trigger = (page: Page) => page.getByTestId('chat-view').getByRole('button', { name: 'Session actions', exact: true })
const menuItemNames = (page: Page) =>
  page.getByRole('menu').locator('[role="menuitem"], [role="menuitemcheckbox"]').allInnerTexts()
    .then(names => names.map(name => name.replace('✓', '').trim()))

test('the session menu lists its actions and works from the keyboard', async ({ page }, info) => {
  await createChat(page, 'Header menu')
  await openSessionMenu(page)
  expect(await menuItemNames(page)).toEqual(['Rename', 'Debug', 'Archive', 'Kill session'])
  await page.screenshot({ path: info.outputPath('session-menu.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger(page)).toBeFocused()

  // Keyboard: Enter opens, arrows move, Escape closes with focus back on the trigger.
  await trigger(page).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  const highlighted = page.getByRole('menu').locator('[data-highlighted]')
  const seen = new Set<string>()
  await expect(async () => {
    await page.keyboard.press('ArrowDown')
    await expect(highlighted).toHaveCount(1, { timeout: 500 })
    seen.add((await highlighted.innerText()).replace('✓', '').trim())
    expect(seen.size).toBeGreaterThan(1)
  }).toPass({ timeout: 5000 })
  // Focus follows the highlight.
  await expect(highlighted).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger(page)).toBeFocused()

  // Rename from the menu focuses the name field.
  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(page.getByLabel('Session name')).toBeFocused()
  await page.keyboard.press('Escape')

  await killChat(page)
})

test('Debug from the menu replaces an open panel and shows as on', async ({ page }) => {
  await createChat(page, 'Header debug')
  const tasks = page.getByRole('group', { name: 'Side panels' }).getByRole('button', { name: 'Tasks', exact: true })
  await tasks.click()
  await expect(tasks).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('team-tasks')).toBeVisible()

  await openSessionMenu(page)
  await page.getByRole('menuitemcheckbox', { name: 'Debug' }).click()
  await expect(page.getByTestId('team-tasks')).toHaveCount(0)
  await expect(page.getByTestId('chat-debug-panel')).toBeVisible()
  await expect(tasks).toHaveAttribute('aria-pressed', 'false')
  await openSessionMenu(page)
  await expect(page.getByRole('menuitemcheckbox', { name: 'Debug' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')

  await killChat(page)
})

test('kill asks first: Cancel and Escape keep the chat, Kill removes it', async ({ page }, info) => {
  await createChat(page, 'Header kill')
  const dialog = page.getByRole('alertdialog')

  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Kill session', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Kill “Header kill”?')
  await expect(dialog).toContainText('permanently removes')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.screenshot({ path: info.outputPath('kill-confirm.png') })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('chat-name')).toHaveText('Header kill')

  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Kill session', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('chat-name')).toHaveText('Header kill')

  await killChat(page)
  await expect(page.getByTestId('chat-view')).toHaveCount(0)
})

test('an archived chat menu has no Archive entry', async ({ page }) => {
  await createChat(page, 'Header archived')
  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand Archive section' }).click()
  // Archived rows drag-disable themselves, so force the click through.
  await page.getByTestId('archive-rows').getByText('Header archived').click({ force: true })
  await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
  await openSessionMenu(page)
  expect(await menuItemNames(page)).toEqual(['Rename', 'Debug', 'Kill session'])
  await page.keyboard.press('Escape')
  await killChat(page)
})

// Header width steps (chat-header-layout D6), at the default 15px chat font.
async function headerFacts(page: Page) {
  const header = page.getByTestId('chat-view').locator('header')
  await expect(header).toBeVisible()
  return header.evaluate(h => {
    const box = h.getBoundingClientRect()
    const clipped = [...h.querySelectorAll('button, [role="switch"], [data-testid="chat-name"], [data-testid="chat-status"]')]
      .filter(node => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5 || rect.bottom > box.bottom + 0.5)
      })
      .map(node => node.getAttribute('aria-label') || node.textContent)
    const name = h.querySelector('[data-testid="chat-name"]')!.getBoundingClientRect().width
    return { layout: h.dataset.layout, clipped, name }
  })
}

test('the header steps down by its own width without clipping a control', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await createChat(page, 'Header widths')
  const expected: Array<[number, string]> = [[1440, 'full'], [1100, 'icons'], [768, 'menu'], [390, 'menu']]
  for (const [width, layout] of expected) {
    await page.setViewportSize({ width, height: 800 })
    await expect(page.getByTestId('chat-view').locator('header')).toHaveAttribute('data-layout', layout)
    const facts = await headerFacts(page)
    expect(facts.clipped).toEqual([])
    expect(facts.name).toBeGreaterThan(40)
    await page.getByTestId('chat-view').locator('header').screenshot({ path: info.outputPath(`header-${width}.png`) })
  }
  // In the menu layout the panels are menu entries.
  await openSessionMenu(page)
  await expect(page.getByRole('menuitemcheckbox', { name: 'Tasks' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Same window, wider navigator: the header narrows and steps down.
  await page.setViewportSize({ width: 1440, height: 800 })
  await expect(page.getByTestId('chat-view').locator('header')).toHaveAttribute('data-layout', 'full')
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('agentboard-settings') ?? '{"state":{},"version":7}')
    raw.state.sidebarWidth = 400
    localStorage.setItem('agentboard-settings', JSON.stringify(raw))
  })
  await page.reload()
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Header widths' }).first().click()
  await expect(page.getByTestId('chat-view').locator('header')).toHaveAttribute('data-layout', 'icons')
  expect((await headerFacts(page)).clipped).toEqual([])
  await killChat(page)
})

test('switching chats closes an open kill confirmation instead of retargeting it', async ({ page }) => {
  await createChat(page, 'Header switch A')
  await createChat(page, 'Header switch B')
  const dialog = page.getByRole('alertdialog')

  // Open Kill for B, then switch chats with the keyboard (Ctrl+Shift+]).
  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Kill session', exact: true }).click()
  await expect(dialog).toContainText('Kill “Header switch B”?')
  const before = await page.getByTestId('chat-name').innerText()
  await page.keyboard.press('Control+Shift+BracketRight')
  await expect(page.getByTestId('chat-name')).not.toHaveText(before)
  // The confirmation is gone rather than showing the other chat's name.
  await expect(dialog).toHaveCount(0)
  const switchedTo = await page.getByTestId('chat-name').innerText()

  // Going back does not resurrect it, and both chats are still alive.
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Header switch B' }).first().click()
  await expect(page.getByTestId('chat-name')).toHaveText('Header switch B')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-session-id^="chat-"]').filter({ hasText: switchedTo })).toHaveCount(1)

  await killChat(page)
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Header switch A' }).first().click()
  await expect(page.getByTestId('chat-name')).toHaveText('Header switch A')
  await killChat(page)
})

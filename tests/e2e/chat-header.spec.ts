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
  await dialog.locator('input').last().fill(name)
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
  await page.keyboard.press('ArrowDown')
  await expect(highlighted).toHaveCount(1)
  const first = (await highlighted.innerText()).replace('✓', '').trim()
  await page.keyboard.press('ArrowDown')
  await expect(highlighted).toHaveCount(1)
  await expect.poll(async () => (await highlighted.innerText()).replace('✓', '').trim()).not.toBe(first)
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

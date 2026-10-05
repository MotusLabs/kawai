import { expect, test } from '@playwright/test'

// Run with NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1; sessions use the SDK-independent chat
// fixture, while separate smoke scripts verify actual subprocess routing.
test('select named profile, create, display, reconnect, and retain terminal form', async ({ page }, info) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await expect(dialog.getByLabel('Profile')).toHaveValue('default')
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  await dialog.getByLabel('Profile').selectOption('glm')
  await page.screenshot({ path: info.outputPath('profile-selection.png') })
  await dialog.locator('input').first().fill(process.cwd())
  await dialog.locator('input').last().fill('GLM profile browser check')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-profile')).toHaveText('Profile: GLM')
  await page.getByLabel('Message Claude').fill('Hello profile')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.screenshot({ path: info.outputPath('profile-chat.png') })
  await page.reload()
  await page.getByText('GLM profile browser check', { exact: true }).first().click()
  await expect(page.getByTestId('chat-profile')).toHaveText('Profile: GLM')
  await page.screenshot({ path: info.outputPath('profile-reconnect.png') })
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await expect(dialog.getByLabel('Session kind')).toHaveValue('terminal')
  await expect(dialog.getByTestId('command-select')).toBeVisible()
  await expect(dialog.getByLabel('Profile')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('terminal-regression.png') })
})

test('catalog failure blocks chat creation and Retry recovers', async ({ page }, info) => {
  let fail = true
  await page.route('**/api/chat/profiles', route => fail
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    : route.continue())
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await expect(dialog.getByRole('alert')).toContainText('HTTP 503')
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('catalog-error.png') })
  fail = false
  await dialog.getByRole('button', { name: 'Retry profiles' }).click()
  await expect(dialog.getByLabel('Profile')).toHaveValue('default')
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
})

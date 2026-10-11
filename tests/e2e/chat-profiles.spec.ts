import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

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
  await dialog.getByLabel('Project Path').fill(process.cwd())
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
  // Reopening defaults to Claude chat; switching to Terminal still restores
  // the terminal form untouched by the chat flow.
  await expect(dialog.getByLabel('Session kind')).toHaveValue('chat')
  await dialog.getByLabel('Session kind').selectOption('terminal')
  await expect(dialog.getByTestId('command-select')).toBeVisible()
  await expect(dialog.getByLabel('Profile')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('terminal-regression.png') })
})

test('project-level .kawai catalog extends the picker for that path', async ({ page }, info) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'agentboard-e2e-profiles-'))
  try {
    await mkdir(path.join(project, '.kawai'), { recursive: true })
    await writeFile(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'glm-flash': {
        label: 'GLM Flash',
        model: 'glm-5.3-flash[1m]',
        env: { ANTHROPIC_BASE_URL: 'https://zai.ruslan.casa/api/anthropic' },
      },
    }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    const profile = dialog.getByLabel('Profile')
    // The prefilled server cwd has no .kawai: the shipped catalog applies.
    await expect(profile.locator('option', { hasText: 'GLM Flash' })).toHaveCount(0)
    // Entering the project path refetches the catalog and offers the entry.
    await dialog.getByLabel('Project Path').fill(project)
    await expect(profile.locator('option', { hasText: 'GLM Flash' })).toHaveCount(1)
    await profile.selectOption('glm-flash')
    await dialog.locator('input').last().fill('GLM Flash project catalog check')
    await page.screenshot({ path: info.outputPath('project-catalog-picker.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-profile')).toHaveText('Profile: GLM Flash')
    await page.getByLabel('Message Claude').fill('Hello flash')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.screenshot({ path: info.outputPath('project-catalog-chat.png') })
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('invalid project catalog file warns without blocking creation', async ({ page }, info) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'agentboard-e2e-profiles-bad-'))
  try {
    await mkdir(path.join(project, '.kawai'), { recursive: true })
    await writeFile(path.join(project, '.kawai', 'profiles.json'), '{ not json')
    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    await dialog.getByLabel('Project Path').fill(project)
    // The invalid file is reported by path...
    await expect(dialog.getByRole('status')).toContainText('profiles.json')
    // ...while the rest of the catalog resolves: creation still works.
    await expect(dialog.getByLabel('Profile')).toHaveValue('default')
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    await dialog.locator('input').last().fill('Invalid catalog check')
    await page.screenshot({ path: info.outputPath('catalog-warning.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-profile')).toHaveText('Profile: Default')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('catalog failure blocks chat creation and Retry recovers', async ({ page }, info) => {
  let fail = true
  await page.route('**/api/chat/profiles*', route => fail
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

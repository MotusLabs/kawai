import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

// Run with NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1; sessions use the SDK-independent chat
// fixture, while separate smoke scripts verify actual subprocess routing.
test('select named profile, create, display, reconnect, and retain terminal form', async ({ page }, info) => {
  // A project outside the server home: catalogs under /home would layer the
  // real user file as a project level and re-home the shipped keys.
  const project = await mkdtemp(path.join(os.tmpdir(), 'agentboard-e2e-profile-main-'))
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    await expect(dialog.getByLabel('Profile')).toHaveValue('default')
    await dialog.getByLabel('Project Path').fill(project)
    // Entering the project path refetches: outside the server home only the
    // shipped catalog applies, grouped by provider (design D13).
    const zaiGroup = dialog.getByLabel('Profile').locator('optgroup[label="Z.AI"]')
    await expect(zaiGroup).toHaveCount(1)
    await expect(zaiGroup.locator('option', { hasText: 'GLM Flash' })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    await dialog.getByLabel('Profile').selectOption('glm')
    await page.screenshot({ path: info.outputPath('profile-selection.png') })
    await dialog.getByLabel('Display Name').fill('GLM profile browser check')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    // The grouped shipped catalog names glm's provider in the header (design D13).
    await expect(page.getByTestId('chat-profile')).toHaveText('Z.AI · GLM')
    await page.getByLabel('Message Claude').fill('Hello profile')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.screenshot({ path: info.outputPath('profile-chat.png') })
    await page.reload()
    await page.getByText('GLM profile browser check', { exact: true }).first().click()
    await expect(page.getByTestId('chat-profile')).toHaveText('Z.AI · GLM')
    await page.screenshot({ path: info.outputPath('profile-reconnect.png') })
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    // Reopening defaults to Claude chat; switching to Terminal still restores
    // the terminal form untouched by the chat flow.
    await expect(dialog.getByLabel('Session kind')).toHaveValue('chat')
    await dialog.getByLabel('Session kind').selectOption('terminal')
    await expect(dialog.getByTestId('command-select')).toBeVisible()
    await expect(dialog.getByLabel('Profile')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('terminal-regression.png') })
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('project-level .kawai catalog extends the picker for that path', async ({ page }, info) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'agentboard-e2e-profiles-'))
  try {
    await mkdir(path.join(project, '.kawai'), { recursive: true })
    await writeFile(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'e2e-project-only': {
        label: 'E2E Project Only',
        model: 'glm-5.3-flash[1m]',
        env: { ANTHROPIC_BASE_URL: 'https://glm.example.internal/api/anthropic' },
      },
    }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    const profile = dialog.getByLabel('Profile')
    // The prefilled server cwd's catalogs (the repo's own .kawai included)
    // never define this entry; only the temp project's file does.
    await expect(profile.locator('option', { hasText: 'E2E Project Only' })).toHaveCount(0)
    // Entering the project path refetches the catalog and offers the entry.
    await dialog.getByLabel('Project Path').fill(project)
    await expect(profile.locator('option', { hasText: 'E2E Project Only' })).toHaveCount(1)
    await profile.selectOption('e2e-project-only')
    await dialog.getByLabel('Display Name').fill('Project catalog check')
    await page.screenshot({ path: info.outputPath('project-catalog-picker.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-profile')).toHaveText('E2E Project Only')
    await page.getByLabel('Message Claude').fill('Hello flash')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.screenshot({ path: info.outputPath('project-catalog-chat.png') })
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('a Codex profile option identifies its runtime in the picker and chat view', async ({ page }, info) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'agentboard-e2e-profiles-codex-'))
  try {
    await mkdir(path.join(project, '.kawai'), { recursive: true })
    // Codex entries may live at project level; only codexHome/network are
    // trusted-tier fields, so this entry names neither — the default home
    // applies server-side and never crosses the boundary.
    await writeFile(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' },
    }))
    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    const profile = dialog.getByLabel('Profile')
    await dialog.getByLabel('Project Path').fill(project)
    // The Codex entry renders once (its label equals the provider label, so
    // a plain option; the home-derived provider id never shows a path).
    await expect(profile.locator('option', { hasText: 'Codex' })).toHaveCount(1)
    await profile.selectOption('codex')
    await dialog.getByLabel('Display Name').fill('Codex profile check')
    await page.screenshot({ path: info.outputPath('codex-picker.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    // The chat view identifies the profile as Codex: provider · profile.
    await expect(page.getByTestId('chat-profile')).toHaveText('Codex · Codex')
    await page.screenshot({ path: info.outputPath('codex-chat-header.png') })
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
    // Unrelated group warnings share the status role; match by content.
    await expect(dialog.getByRole('status').filter({ hasText: 'profiles.json' })).toContainText('profiles.json')
    // ...while the rest of the catalog resolves: creation still works.
    await expect(dialog.getByLabel('Profile')).toHaveValue('default')
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    await dialog.getByLabel('Display Name').fill('Invalid catalog check')
    await page.screenshot({ path: info.outputPath('catalog-warning.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    // The grouped shipped catalog names Default's provider in the header.
    await expect(page.getByTestId('chat-profile')).toHaveText('Claude · Default')
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

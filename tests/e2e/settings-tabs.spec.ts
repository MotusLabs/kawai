// Settings reorg walkthrough (reorg-settings-default-approval): the modal's
// four tabs each carry their sections, opening on Sessions; the Chat tab
// holds the chat font size and provider env and only points to the per-team
// approval default (unify-approval-defaults D1); and a chat created with the
// box unchecked starts manual — its first tool use asks with an approval card
// instead of auto-approving.
import { expect, test, type Page } from '@playwright/test'
import { killChat } from './support/chatHeader'

// The chat walkthrough needs a working backend: the e2e server pins auth
// empty, so chat creation only succeeds with the development fixture's
// injected authCheck (see playwright.config.ts).
test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

const TABS = ['Sessions', 'Chat', 'Terminal', 'General'] as const

const panel = (page: Page, name: string) =>
  page.getByRole('tabpanel', { name })

/**
 * Let the tab strip's 150ms color transition settle before a screenshot:
 * mid-transition, the outgoing tab still paints its old active blue and the
 * incoming one still paints dark, so an immediate capture looks wrong.
 */
async function settledScreenshot(page: Page, path: string) {
  await page.waitForTimeout(250)
  await page.screenshot({ path })
}

async function openSettings(page: Page) {
  await page.goto('/')
  await expect(
    page.getByRole('button', { name: 'New session', exact: true }).first()
  ).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
}

test('the four tabs each show their sections and the modal opens on Sessions', async ({ page }, info) => {
  await openSettings(page)

  for (const tab of TABS) {
    await expect(page.getByRole('tab', { name: tab })).toBeVisible()
  }

  // Opens on Sessions; its first section is visible, the others are not.
  await expect(panel(page, 'Sessions')).toBeVisible()
  await expect(panel(page, 'Sessions').getByText('Default Project Directory')).toBeVisible()
  for (const tab of ['Chat', 'Terminal', 'General']) {
    await expect(panel(page, tab)).toBeHidden()
  }
  await settledScreenshot(page, info.outputPath('1-sessions-tab.png'))

  // Chat: provider env and chat font size; the approval default is per team.
  await page.getByRole('tab', { name: 'Chat' }).click()
  const chatPanel = panel(page, 'Chat')
  await expect(chatPanel).toBeVisible()
  await expect(chatPanel.getByText('Claude Chat Provider')).toBeVisible()
  await expect(chatPanel.getByText('New Chat Sessions', { exact: true })).toBeVisible()
  await expect(chatPanel.getByRole('radio', { name: 'Auto-approve', exact: true })).toHaveCount(0)
  await expect(chatPanel.getByTestId('default-approval-policy-hint')).toContainText("Team page's Members tab")
  await expect(chatPanel.getByLabel('Increase Chat Font Size')).toBeVisible()
  await settledScreenshot(page, info.outputPath('2-chat-tab.png'))

  // Terminal and General carry their own sections.
  await page.getByRole('tab', { name: 'Terminal' }).click()
  await expect(panel(page, 'Terminal').getByText('Terminal Rendering')).toBeVisible()
  await settledScreenshot(page, info.outputPath('3-terminal-tab.png'))

  await page.getByRole('tab', { name: 'General' }).click()
  await expect(panel(page, 'General').getByText('Dark Mode')).toBeVisible()
  await settledScreenshot(page, info.outputPath('4-general-tab.png'))

  // Cancel discards nothing here, but closing and reopening resets to
  // Sessions — the last tab is never remembered.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(panel(page, 'Sessions')).toBeVisible()
  await expect(panel(page, 'General')).toBeHidden()
})

test('a chat created with Auto-approve unchecked starts manual', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await expect(dialog.getByLabel('Auto-approve tools')).toBeVisible()

  // Unchecking creates a manual session: the header toggle reads manual and
  // the first tool use asks with an approval card instead of auto-approving.
  // The path goes first: an untouched checkbox re-seeds from the path's team.
  await dialog.getByLabel('Project Path').fill(process.cwd())
  await dialog.getByLabel('Auto-approve tools').uncheck()
  await dialog.getByPlaceholder('auto-generated').fill('Unchecked manual start')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText('Unchecked manual start')

  await expect(page.getByTestId('chat-approval-policy')).toHaveAttribute('aria-checked', 'false')

  await page.getByLabel('Message Claude').fill('approval')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await expect(page.getByTestId('chat-transcript').getByText('Auto-approved')).toHaveCount(0)

  await killChat(page)
})

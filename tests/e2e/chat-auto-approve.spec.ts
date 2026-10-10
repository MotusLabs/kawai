// Auto-approve policy in a real browser against the development fixture:
// the header toggle switches the policy live, a pending approval resolves
// when auto turns on, later tool uses run without cards, questions still
// ask under auto, a second tab sees the switch, and the archived read-only
// view hides the control.
import { expect, test, type Page } from '@playwright/test'

// Serial: the app selects every newly created session on every client
// (App.tsx session-created), so parallel chat creations yank each test's
// open view. One worker, one session alive at a time.
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
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message Claude').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

const toggle = (page: Page) => page.getByTestId('chat-approval-policy')
const transcript = (page: Page) => page.getByTestId('chat-transcript')

test('switching to auto resolves a pending approval and skips later cards', async ({ page }, info) => {
  await createChat(page, 'auto-policy')
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false')

  // Manual: a Bash approval surfaces as a card.
  await send(page, 'approval')
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('1-manual-approval-card.png') })

  // Flip the switch: the card resolves, the notice and auto-approved mark
  // appear, and the fixture's tool use proceeds ("Request accepted.").
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(transcript(page)).toContainText('Auto-approve on')
  await expect(transcript(page)).toContainText('Auto-approved Bash')
  await expect(transcript(page)).toContainText('Request accepted.')

  // The next tool use never shows a card.
  await send(page, 'approval')
  await expect(transcript(page)).toContainText('Request accepted.')
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(transcript(page).getByText('Auto-approved Bash')).toHaveCount(2)
  await page.screenshot({ path: info.outputPath('2-auto-no-cards.png') })

  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

test('questions still ask under auto', async ({ page }, info) => {
  await createChat(page, 'auto-question')
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')

  await send(page, 'question')
  await expect(page.getByRole('group', { name: 'Which color?' })).toBeVisible()
  await page.getByLabel('Blue').check()
  await page.getByRole('button', { name: 'Submit answers' }).click()
  await expect(transcript(page)).toContainText('Request accepted.')
  await page.screenshot({ path: info.outputPath('3-question-under-auto.png') })

  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

test('a second tab sees the same policy switch', async ({ page, context }, info) => {
  await createChat(page, 'auto-two-tabs')
  const other = await context.newPage()
  await other.goto('/')
  await other.getByText('auto-two-tabs', { exact: false }).first().click()
  await expect(other.getByTestId('chat-view')).toContainText('auto-two-tabs')
  await expect(toggle(other)).toHaveAttribute('aria-pressed', 'false')

  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle(other)).toHaveAttribute('aria-pressed', 'true')
  await expect(transcript(other)).toContainText('Auto-approve on')
  await page.screenshot({ path: info.outputPath('4-second-tab-sees-switch.png') })

  await other.close()
  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

test('the archived read-only view hides the approval-policy control', async ({ page }, info) => {
  await createChat(page, 'auto-archive')
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('chat-archive-button').click()
  // Archiving moves the session to the docked Archive pane and the app
  // auto-selects another live session (pre-existing navigator behavior).
  // Open the archived chat from the Archive pane to reach its read-only view.
  await page.getByRole('button', { name: 'Expand Archive section' }).click()
  // The docked pane's row can sit under list overlays; dispatch its select
  // handler directly instead of fighting pointer-event interception.
  await page
    .locator('[data-session-id^="chat-"]')
    .filter({ hasText: 'auto-archive' })
    .first()
    .evaluate(node => (node as HTMLElement).click())
  await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
  await expect(page.getByTestId('chat-view')).toContainText('Archived')
  await expect(toggle(page)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('5-archived-hides-toggle.png') })

  // Kill remains the only permanent removal; it also cleans the session up.
  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

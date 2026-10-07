// The activity row in a real browser against the development fixture: every
// phase renders with its label (waiting, thinking, writing tool input,
// running, retrying), the elapsed timer ticks client-side, the row hides
// while assistant text streams and after the turn completes, a reload
// mid-phase restores it from the snapshot with roughly the right age, and an
// approved tool restarts its clock so the card's wait never reads as tool
// time.
import { expect, test, type Page } from '@playwright/test'

// Serial: the app selects every newly created session on every client, so
// parallel chat creations yank each test's open view.
test.describe.configure({ mode: 'serial' })

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

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

async function send(page: Page, text: string) {
  await page.getByLabel('Message Claude').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

const row = (page: Page) => page.getByTestId('chat-activity')
const elapsedSeconds = (page: Page) =>
  elapsed(page).innerText().then(text => Number(text.replace(/[^\d]/g, '')))
const elapsed = (page: Page) => page.getByTestId('chat-activity-elapsed')
const openSession = async (page: Page, name: string) => {
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

test('a thinking turn shows waiting and thinking, ticks, survives reload, then clears', async ({ page }, info) => {
  await createChat(page, 'activity-thinking')
  await send(page, 'show thinking')

  // The turn opens with the request phase and a ticking timer.
  await expect(row(page)).toContainText('Waiting for model…')
  await expect(row(page)).toHaveAttribute('data-phase', 'requesting')
  await page.screenshot({ path: info.outputPath('1-waiting-for-model.png') })

  // The thinking block swaps the label and restarts the clock at zero.
  await expect(row(page)).toContainText('Thinking…')
  await expect(elapsed(page)).toHaveText('0s')
  await page.screenshot({ path: info.outputPath('2-thinking.png') })

  // The timer advances once per second without any server traffic.
  const first = await elapsedSeconds(page)
  await page.waitForTimeout(2_300)
  const second = await elapsedSeconds(page)
  expect(second - first).toBeGreaterThanOrEqual(2)

  // Reload mid-phase: the snapshot restores the row with its age.
  const before = await elapsedSeconds(page)
  await page.reload()
  await openSession(page, 'activity-thinking')
  await expect(row(page)).toContainText('Thinking…')
  const restored = await elapsedSeconds(page)
  expect(restored).toBeGreaterThanOrEqual(before)
  expect(restored).toBeLessThan(30)
  await page.screenshot({ path: info.outputPath('3-restored-after-reload.png') })

  // The completed turn leaves no row behind.
  await expect(page.getByTestId('chat-transcript')).toContainText('Thought it over.')
  await expect(row(page)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('4-turn-completed.png') })

  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

test('a tool turn prepares, runs, and hides while text streams', async ({ page }, info) => {
  await createChat(page, 'activity-tool')
  await send(page, 'run a tool')

  await expect(row(page)).toContainText('Writing Bash input…')
  await expect(row(page)).toHaveAttribute('data-phase', 'preparing_tool')
  await page.screenshot({ path: info.outputPath('5-writing-tool-input.png') })

  await expect(row(page)).toContainText('Running Bash…')
  await expect(row(page)).toHaveAttribute('data-phase', 'running_tools')
  await page.screenshot({ path: info.outputPath('6-running-tool.png') })

  // The streamed response is its own visible progress: no row below it.
  await expect(page.getByTestId('chat-transcript')).toContainText('Tool finished.')
  await send(page, 'stream')
  await expect(page.getByTestId('chat-transcript')).toContainText('Streaming a response across reconnect.')
  await expect(row(page)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('7-hidden-while-streaming.png') })

  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

test('an approved tool restarts its clock without the approval wait', async ({ page }, info) => {
  await createChat(page, 'activity-approval')
  await send(page, 'approval')

  // The card owns the footer while it waits; let a stale clock pile up 3s.
  const allow = page.getByRole('button', { name: 'Allow', exact: true })
  await expect(allow).toBeVisible()
  await expect(row(page)).toHaveCount(0)
  await page.waitForTimeout(3_000)

  // Approving restarts the phase clock: the row reappears near zero, not at
  // the 3s the card's wait would otherwise have counted (PR #34 review).
  await allow.click()
  await expect(row(page)).toContainText('Running Bash…')
  expect(await elapsedSeconds(page)).toBeLessThan(3)
  await page.screenshot({ path: info.outputPath('10-fresh-clock-after-approval.png') })

  await expect(page.getByTestId('chat-transcript')).toContainText('Request accepted.')
  await expect(row(page)).toHaveCount(0)

  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

test('a retry turn counts attempts and statuses, then recovers', async ({ page }, info) => {
  await createChat(page, 'activity-retry')
  await send(page, 'simulate a retry')

  await expect(row(page)).toContainText('Retrying (1/10, 504)…')
  await page.screenshot({ path: info.outputPath('8-retrying-attempt-1.png') })
  await expect(row(page)).toContainText('Retrying (2/10, 504)…')
  await page.screenshot({ path: info.outputPath('9-retrying-attempt-2.png') })

  // Recovery ends the turn: text arrives and the row disappears.
  await expect(page.getByTestId('chat-transcript')).toContainText('Recovered from the retry.')
  await expect(row(page)).toHaveCount(0)

  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
})

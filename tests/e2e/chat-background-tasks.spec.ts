// Background tasks in a real browser against the development fixture's
// background turn (background tasks design D2-D5): the Bash calls render as
// task rows with their roster state, the live strip lists the running shell
// and dev server with ticking elapsed and per-task Stop, expanding the
// settled shell fetches its output tail and the running server's tail grows,
// the settle wakes the agent into a triggered turn whose line replaces the
// user bubble, and stopping from the strip settles through the roster.
import { expect, test, type Page } from '@playwright/test'
import { killChat } from './support/chatHeader'

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

test('a background turn shows running rows, the strip, the tail, the trigger line, and stops one task', async ({ page }, info) => {
  await createChat(page, 'background-fixture')
  await page.getByLabel('Message Claude').fill('show background tasks')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  // Two task rows render with their roster state; the strip lists both live.
  const rows = page.getByTestId('chat-task-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Wait then print a marker')
  await expect(rows.first()).toHaveAttribute('data-status', 'running')
  const strip = page.getByTestId('chat-workers-strip')
  await expect(strip.getByTestId('chat-task-strip-row')).toHaveCount(2)
  await expect(strip).toContainText('Shell')
  await expect(strip).toContainText('Fixture dev server')
  await page.screenshot({ path: info.outputPath('1-tasks-live.png') })

  // The settle wakes the agent: a trigger line names the completed task,
  // its reply streams after it, and the quick row carries the outcome.
  await expect(page.getByTestId('turn-trigger')).toContainText('Wait then print a marker')
  await expect(page.getByTestId('chat-transcript')).toContainText('The marker printed fixture-shell-done.')
  await expect(rows.first()).toHaveAttribute('data-status', 'completed')
  await expect(rows.first()).toContainText('done')
  await expect(rows.first()).toContainText('Background command "Wait then print a marker" completed (exit code 0)')

  // Expanding the settled shell fetches its final output tail once.
  await rows.first().locator('summary').click()
  await expect(rows.first().getByTestId('chat-task-output')).toContainText('fixture-shell-done')
  await page.screenshot({ path: info.outputPath('2-settled-tail.png') })

  // The dev server keeps running: its row ticks and its tail grows.
  const server = rows.nth(1)
  await expect(server).toHaveAttribute('data-status', 'running')
  await server.locator('summary').click()
  await expect(server.getByTestId('chat-task-output')).toContainText('listening on :5173')

  // Stopping from the strip settles exactly that task through the roster.
  await strip.getByTestId('chat-task-strip-stop').click()
  await expect(server).toHaveAttribute('data-status', 'stopped')
  await expect(strip).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('3-stopped.png') })

  await killChat(page)
})

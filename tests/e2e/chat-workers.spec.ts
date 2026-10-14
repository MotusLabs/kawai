// Spawned workers in a real browser against the development fixture's worker
// turn (workers design D9): the Agent call renders as a worker row, the live
// strip lists the running worker with its last tool and a ticking timer, the
// worker's own tool call never reaches the transcript while its nested Agent
// call does (marked with a depth badge), and the strip leaves once the level
// drops the worker — with the settled outcome the notification's, not
// `stopped`. Expanding round-trips chat-worker-transcript; the fixture never
// sends system/init, so its chats have no SDK transcript and the body reports
// unavailable (rendering a delivered body is pinned by the component tests).
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
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

test('a worker turn shows the row, the live strip, the body, and the settled outcome', async ({ page }, info) => {
  await createChat(page, 'workers-fixture')
  await page.getByLabel('Message Claude').fill('spawn a worker')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  // The spawn renders as a worker row and the strip lists it live.
  const rows = page.getByTestId('chat-worker-row')
  await expect(rows.first()).toContainText('Agent · Explore')
  await expect(rows.first()).toContainText('Map the workspace')
  const strip = page.getByTestId('chat-workers-strip')
  await expect(strip).toContainText('Map the workspace')
  await expect(strip).toContainText('· Grep')
  await page.screenshot({ path: info.outputPath('1-worker-live.png') })

  // The nested spawn is anchored (with its depth badge); the worker's own
  // Grep call never reaches the parent transcript.
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1).getByTestId('chat-worker-depth')).toHaveText('depth 2')
  await expect(page.getByTestId('chat-transcript')).not.toContainText('package.json')
  await page.screenshot({ path: info.outputPath('2-nested-worker.png') })

  // Settled: the strip leaves and the row carries the notification's outcome.
  await expect(page.getByTestId('chat-transcript')).toContainText('The worker mapped the workspace.')
  await expect(strip).toHaveCount(0)
  await expect(rows.first()).toHaveAttribute('data-status', 'completed')
  await expect(rows.first()).toContainText('done')

  // Expanding shows the notification's summary and asks the server for the
  // body, which the fixture cannot have.
  await rows.first().locator('summary').click()
  await expect(rows.first().getByTestId('chat-worker-summary'))
    .toHaveText('Found three packages: client, server, shared.')
  await expect(rows.first().getByTestId('chat-worker-body-status')).toContainText('Body unavailable')
  await rows.nth(1).locator('summary').click()
  await expect(rows.nth(1).getByTestId('chat-worker-body-status')).toContainText('Body unavailable')
  await page.screenshot({ path: info.outputPath('3-settled-expanded.png') })

  await killChat(page)
})

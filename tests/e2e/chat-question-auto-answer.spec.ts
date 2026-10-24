// Question auto-answer end to end against the development fixture
// (question-auto-answer 5.2, oracles QA-1 and QA-3 through the production
// composition): a fully recommended question with a 1-minute wait shows the
// countdown and answers itself with the transcript marker and the agent
// note, and Wait for me in a second browser context stops it in both.
import { expect, test, type Page } from '@playwright/test'
import { killChat } from './support/chatHeader'

// Serial: the app selects every newly created session on every client
// (App.tsx session-created), so parallel chat creations yank each test's
// open view. One worker, one session alive at a time.
test.describe.configure({ mode: 'serial' })

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

const transcript = (page: Page) => page.getByTestId('chat-transcript')

async function setWaitMinutes(page: Page, minutes: number) {
  const response = await page.request.put('/api/settings/question-auto-answer', { data: { minutes } })
  expect(response.status()).toBe(200)
}

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

async function askRecommendedQuestion(page: Page) {
  // The fixture's "recommended question" variant asks one that marks a
  // (Recommended) option, so the saved wait arms a server-side deadline.
  await page.getByLabel('Message Claude').fill('recommended question')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const countdown = page.getByTestId('auto-answer-countdown')
  await expect(countdown).toBeVisible()
  await expect(countdown).toContainText('Will choose Blue (Recommended) in')
  await expect(countdown).toContainText(/in \d+:\d{2}$/)
}

test('a 1-minute wait answers a recommended question automatically', async ({ page }, info) => {
  test.setTimeout(150_000)
  await setWaitMinutes(page, 1)
  await createChat(page, 'qaa-auto')
  await askRecommendedQuestion(page)
  await page.screenshot({ path: info.outputPath('1-countdown.png') })

  // The deadline fires with no answer: the same validateAnswers path as a
  // user settles it, the marker names the chosen label, and the tool result
  // tells the agent the answer was automatic (D3).
  await expect(transcript(page)).toContainText('Answered automatically: Blue (Recommended)', { timeout: 100_000 })
  await expect(transcript(page)).toContainText('the recommended option was selected automatically')
  await expect(page.getByTestId('auto-answer-countdown')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Wait for me' })).toHaveCount(0)
  await expect(transcript(page)).toContainText('Request accepted.')
  await page.screenshot({ path: info.outputPath('2-answered-automatically.png') })

  await killChat(page)
})

test('Wait for me in a second browser context stops the deadline in both', async ({ page, browser }, info) => {
  test.setTimeout(220_000)
  await setWaitMinutes(page, 1)
  await createChat(page, 'qaa-hold')
  await askRecommendedQuestion(page)

  const other = await browser.newContext()
  const second = await other.newPage()
  await second.goto('/')
  await second.locator('[data-session-id^="chat-"]').filter({ hasText: 'qaa-hold' }).first().click()
  await expect(second.getByTestId('chat-view')).toContainText('qaa-hold')
  await expect(second.getByTestId('auto-answer-countdown')).toBeVisible()

  // Hold from the second context: the event is sequenced, so both contexts
  // drop the countdown and mark the hold.
  await second.getByRole('button', { name: 'Wait for me' }).click()
  await expect(transcript(second)).toContainText('Auto-answer held')
  await expect(transcript(page)).toContainText('Auto-answer held')
  await expect(page.getByTestId('auto-answer-countdown')).toHaveCount(0)
  await expect(second.getByTestId('auto-answer-countdown')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Wait for me' })).toHaveCount(0)
  await expect(second.getByRole('button', { name: 'Wait for me' })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('3-held-in-both.png') })

  // The deadline passes with no settlement: the hold cleared the timer, so
  // the marker never appears in either context.
  await page.waitForTimeout(70_000)
  await expect(transcript(page)).not.toContainText('Answered automatically')
  await expect(transcript(second)).not.toContainText('Answered automatically')

  // A held question still takes a later user answer.
  await page.getByLabel('Blue (Recommended)').check()
  await page.getByRole('button', { name: 'Submit answers' }).click()
  await expect(transcript(page)).toContainText('Request accepted.')
  await expect(transcript(second)).toContainText('Request accepted.')

  await other.close()
  await killChat(page)
  // Leave the saved wait at its default for the specs that follow (a leftover
  // 1 only matters to questions that mark a recommendation).
  await setWaitMinutes(page, 5)
})

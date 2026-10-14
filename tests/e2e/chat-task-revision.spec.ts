// Browser walkthrough of task-revision publication against the SDK-free
// fixture (task-revision-publication 6.2, E09): a task assigned to a fixture
// developer; Save draft leaves the shown revision alone; Publish revision
// records revision 2 with its rationale and its holder reads Not notified;
// Notify queues one notice, which the fixture (no transcript receipts)
// settles as Uncertain, linked to the Mailbox; discarding it there shows the
// notice Failed, and Retry notification sends one new notice — the task stays
// at revision 2 throughout. Run on its own fixture port; never against a live
// kawai (the suite's teardown is scoped to its private tmux socket).
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

function teamRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-task-revision-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\nmax: 3\n---\nBuild features')
  return root
}

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Developers' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

async function makeIdle(page: Page, session: string) {
  await page.locator(`[data-session-id="${session}"]`).click()
  await page.getByLabel('Message Claude').fill('hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('chat-status')).toHaveText('waiting', { timeout: 15_000 })
}

async function openTasks(page: Page) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByTestId('team-tasks')).toBeVisible()
}

test('E09: draft, publish, notify, an uncertain notice resolved in the Mailbox, and a retry — one revision', async ({ page }, info) => {
  const root = teamRoot()
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Revision lead', 'leads')
    const dev = await createChat(page, root, 'Revision developer', 'devs')
    await makeIdle(page, dev)
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTasks(page)
    const panel = page.getByTestId('team-tasks')

    // Assign the task; the developer claims the instruction.
    await panel.locator('summary', { hasText: 'New task' }).click()
    await panel.getByLabel('Task title').fill('Export')
    await panel.getByLabel('Task direction').fill('Ship a CSV export')
    await panel.getByLabel('Assignment target kind').selectOption('group')
    await panel.getByLabel('Assignment group').selectOption('devs')
    await panel.getByLabel('Assignment instruction').fill('Please build it')
    await panel.getByTestId('task-create-assign-button').click()
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('claimed by Revision developer', { timeout: 20_000 })
    const detail = page.getByTestId('task-detail')

    // Save draft: the shown direction and revision stay put.
    await detail.getByLabel('Draft direction').fill('Ship CSV and JSON exports')
    await detail.getByLabel('Rationale').fill('Customer asked for JSON')
    await detail.getByTestId('task-save-draft').click()
    await expect(detail.getByTestId('task-draft-status')).toContainText('based on revision 1 · not published')
    await expect(detail.getByTestId('task-direction')).toHaveText('Ship a CSV export')
    await expect(detail).toContainText('revision 1')
    await page.screenshot({ path: info.outputPath('draft-saved.png') })

    // Publish revision 2: rationale in the history; its holder is Not notified.
    await detail.getByTestId('task-publish').click()
    await expect(detail.getByTestId('task-direction')).toHaveText('Ship CSV and JSON exports')
    await expect(detail.getByTestId('task-draft-status')).toHaveCount(0)
    await detail.getByTestId('task-revisions').locator('summary').click()
    await expect(detail.getByTestId('revision-rationale')).toHaveText('Rationale: Customer asked for JSON')
    const publication = detail.locator('[data-testid="task-publication"][data-revision="2"]')
    const recipient = publication.getByTestId('task-publication-recipient')
    await expect(recipient.getByTestId('recipient-notice')).toHaveText('Not notified')
    await expect(recipient.getByTestId('recipient-acknowledged')).toHaveText('not acknowledged')
    await page.screenshot({ path: info.outputPath('published.png') })

    // Notify: one notice. The fixture confirms no receipt, so it settles Uncertain, linked to the Mailbox.
    await publication.getByTestId('task-notify').click()
    await expect(recipient.getByTestId('recipient-notice')).toHaveText(/Queued|Uncertain/)
    await expect(recipient.getByTestId('recipient-notice')).toHaveText('Uncertain', { timeout: 30_000 })
    await expect(publication.getByTestId('task-notify')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('notice-uncertain.png') })

    // Resolve it in the Mailbox: discard it there, and the detail shows the notice Failed.
    await recipient.getByTestId('recipient-open-mailbox').click()
    const mailbox = page.getByTestId('team-mailbox')
    const notice = mailbox.locator('article').filter({ hasText: 'revision 2 published by the human' })
    await notice.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(notice).toHaveCount(0)
    // Back to the task: the panel reopens on the list.
    await openTasks(page)
    await panel.locator('[data-task-id]').first().locator('button').first().click()
    await expect(recipient.getByTestId('recipient-notice')).toHaveText(/^Failed/, { timeout: 15_000 })

    // Retry notification: exactly one new notice, and still revision 2.
    await publication.getByTestId('task-retry-notification').click()
    await expect(recipient.getByTestId('recipient-notice')).toHaveText(/Queued|Uncertain/, { timeout: 15_000 })
    await expect(detail.getByTestId('message-row').filter({ hasText: 'revision 2 published by the human' })).toHaveCount(2, { timeout: 15_000 })
    await expect(detail).toContainText('revision 2')
    await expect(detail.locator('[data-testid="task-publication"]')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('retried.png') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

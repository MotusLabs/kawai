// Browser walkthrough of task contracts against the SDK-free fixture
// (implementation-contract 3.2, V4): create a task with a contract, see its
// r1 identity and clauses; edit the contract in the direction editor and see
// a live parser problem with Publish disabled; fix it, publish revision 2,
// and see both revisions' identities in the history. Run on its own fixture
// port; never against a live kawai (teardown is scoped to its private tmux
// socket).
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

const CONTRACT = ['## Implementation contract', '### Acceptance', '- A1: Exports a CSV', '### Invariants', '- I1: Never writes twice',
  '### Scope', '- `src/server/export/**`', '### Verification', '- V1: the export test passes', '### Excluded', '- X1: JSON export'].join('\n')

function teamRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-task-contract-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  return root
}

async function createChat(page: Page, root: string, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Team leads' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption('leads')
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

async function openTasks(page: Page) {
  const button = page.getByTestId('chat-team-button')
  if (await button.isVisible().catch(() => false)) await button.click()
  await page.getByTestId('team-tab-tasks').click()
  await expect(page.getByTestId('team-tasks')).toBeVisible()
}

test('a contract is created, edited with a live problem, published, and shown per revision in the history', async ({ page }, info) => {
  test.setTimeout(120_000)
  const root = teamRoot()
  try {
    await page.goto('/')
    await createChat(page, root, 'Contract lead')
    await openTasks(page)
    const panel = page.getByTestId('team-tasks')

    // Create the task with a contract.
    await panel.locator('summary', { hasText: 'New task' }).click()
    await panel.getByLabel('Task title').fill('Export')
    await panel.getByLabel('Task direction').fill('Ship a CSV export')
    await panel.getByLabel('Implementation contract', { exact: true }).fill(CONTRACT)
    await expect(panel.getByTestId('task-create-contract-problems')).toHaveCount(0)
    await panel.getByTestId('task-create-button').click()
    const detail = page.getByTestId('task-detail')
    await expect(detail).toBeVisible({ timeout: 15_000 })
    const current = detail.getByTestId('task-current-contract')
    await expect(current).toHaveAttribute('data-contract', 'present')
    await expect(current.getByTestId('contract-identity')).toHaveText(/^r1#[0-9a-f]{12}$/)
    await expect(current).toContainText('I1: Never writes twice')
    await expect(current).toContainText('src/server/export/**')
    const r1 = (await current.getByTestId('contract-identity').textContent())!
    await page.screenshot({ path: info.outputPath('created.png') })

    // Edit the contract in the direction editor: a duplicate id is a live problem and blocks Publish.
    const editor = detail.getByLabel('Draft implementation contract')
    await expect(editor).toHaveValue(/- I1: Never writes twice/)
    await editor.fill(CONTRACT.replace('- I1: Never writes twice', '- I1: Never writes twice\n- I1: Never loses a row'))
    await detail.getByLabel('Rationale').fill('Rows must not be lost')
    await expect(detail.getByTestId('task-contract-problems')).toContainText('Duplicate clause id I1')
    await expect(detail.getByTestId('task-publish')).toBeDisabled()
    await page.screenshot({ path: info.outputPath('live-problem.png') })

    // Fix it and publish revision 2.
    await editor.fill(CONTRACT.replace('- I1: Never writes twice', '- I1: Never writes twice\n- I2: Never loses a row'))
    await expect(detail.getByTestId('task-contract-problems')).toHaveCount(0)
    await detail.getByTestId('task-publish').click()
    await expect(current.getByTestId('contract-identity')).toHaveText(/^r2#[0-9a-f]{12}$/, { timeout: 15_000 })
    await expect(current).toContainText('I2: Never loses a row')

    // Both revisions' identities in the history; revision 1 keeps its own contract.
    await detail.getByTestId('task-section-toggle-Revision history').click()
    const history = detail.getByTestId('task-revisions')
    const revision1 = history.locator('[data-revision="1"]').getByTestId('revision-contract')
    const revision2 = history.locator('[data-revision="2"]').getByTestId('revision-contract')
    await expect(revision1.getByTestId('contract-identity')).toHaveText(r1)
    await expect(revision1).not.toContainText('Never loses a row')
    await expect(revision2.getByTestId('contract-identity')).toHaveText(/^r2#[0-9a-f]{12}$/)
    await expect(revision2).toContainText('I2: Never loses a row')
    await history.screenshot({ path: info.outputPath('history.png') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

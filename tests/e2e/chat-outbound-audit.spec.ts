// The Audit tab walkthrough (execution-safety-recovery 4.5, D9/D10) against
// the SDK-free fixture: a fixture agent's two sends run through the driver's
// registered audit hooks — an allowed push to the repository's own origin and
// a foreign-repository gh write — so the real observer and store record them.
// The violation raises one human-owned attention item; the owner filters the
// tab to violations and acknowledges the row, which clears the item and keeps
// the row's verdict. Written for CI; run locally only on a spare E2E_PORT
// after `bun run build`.
import { expect, test, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from '../../src/server/git/gitCommand'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

/** A repository team whose origin is its own: a push there is an allowed send. */
function auditTeam() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-outbound-audit-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Leads\n---\nCoordinate work')
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  git(['init', '-q', root])
  git(['remote', 'add', 'origin', 'https://github.com/example/kawai.git'])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return root
}

async function createChat(page: Page, root: string, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

async function say(page: Page, text: string) {
  await page.getByLabel('Message Claude').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

async function openTab(page: Page, teamKey: string, tab: string) {
  await page.evaluate(([key, name]) => { window.location.hash = `#/team/${encodeURIComponent(key!)}/${name}` }, [teamKey, tab])
  await expect(page.getByTestId('team-workspace')).toHaveAttribute('data-team-key', teamKey)
}

test('a fixture agent\'s sends are recorded, the violation raises one item, and the owner filters and acknowledges it', async ({ page }, info) => {
  const root = auditTeam()
  try {
    await page.goto('/')
    await createChat(page, root, 'Audit walkthrough')
    await say(page, 'audit')
    await expect(page.getByTestId('chat-transcript')).toContainText('Recorded the audit walkthrough sends', { timeout: 30_000 })
    await page.screenshot({ path: info.outputPath('audit-transcript.png') })

    // The tab lists both recorded sends, newest first.
    await openTab(page, root, 'audit')
    const rows = page.locator('[data-testid^="audit-row-"]')
    await expect(rows).toHaveCount(2, { timeout: 30_000 })
    await expect(rows.first()).toContainText('gh-write')
    await expect(rows.first()).toContainText('github:other/repo')
    await expect(rows.first()).toContainText('Violation')
    await expect(rows.nth(1)).toContainText('git-push')
    await expect(rows.nth(1)).toContainText('Allowed')
    const counts = page.getByTestId('audit-counts')
    await expect(counts).toContainText('git-push 1')
    await expect(counts).toContainText('Violations 1')
    await expect(counts).toContainText('Unacknowledged 1')
    await page.screenshot({ path: info.outputPath('audit-tab.png') })

    // The violation raised one human-owned attention item naming the group.
    const item = page.getByTestId('team-attention-queue').locator('[data-kind="outbound-violation"]')
    await expect(item).toHaveCount(1, { timeout: 30_000 })
    await expect(item).toContainText('gh-write to github:other/repo: 1 unacknowledged')
    await expect(item).toContainText('Review and acknowledge')

    // The owner filters to violations: one row, counts still over the range.
    await page.getByLabel('Filter by verdict').selectOption('violation')
    await page.getByTestId('audit-apply-filters').click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('gh-write')
    await expect(counts).toContainText('git-push 1')

    // Acknowledge through the row: the item clears, the verdict stays.
    await page.getByTestId('audit-acknowledge').click()
    const dialog = page.getByTestId('audit-ack-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Acknowledgement note').fill('known fork, fine for now')
    await dialog.getByTestId('audit-ack-confirm').click()
    await expect(item).toHaveCount(0, { timeout: 30_000 })
    await expect(rows.first()).toContainText('Violation')
    await expect(counts).toContainText('Unacknowledged 0')
    await page.screenshot({ path: info.outputPath('audit-acknowledged.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

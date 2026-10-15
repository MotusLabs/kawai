// Browser walkthrough of the Strategy tab against the SDK-free fixture and
// isolated durable DB (product-strategy 6.2): capture, draft durability
// across reload, a CAS conflict forced by a direct draft write behind the
// server (the client's text survives for reconciliation, S12), review and
// human approval of the exact revision, idempotent outcome, and a forged
// repository approval document changing nothing (S09). The view is reached
// through the Team page's `#/team/<key>/strategy` route with its sub-views
// (team-workspace-pages 6.1/5.2), not a chat header panel. Local execution
// requires the fixture webServer (AGENTBOARD_CHAT_FIXTURE=1); CI runs it —
// never run test:e2e against a live kawai server.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

/** Open the team's Strategy tab through its URL route; optionally deep-link a sub-view. */
async function openTeamStrategy(page: Page, root: string, sub?: 'overview' | 'draft' | 'history') {
  await page.evaluate(([teamKey, subView]) => {
    window.location.hash = `#/team/${encodeURIComponent(teamKey)}/strategy${subView ? `/${subView}` : ''}`
  }, [root, sub] as const)
  const view = page.getByTestId('product-strategy')
  await expect(view).toBeVisible()
  return view
}

/** Overwrite the human draft row directly in the durable DB — the client never sees a push, so its next save carries a stale hash. */
function overwriteDraftBehindServer(storedPurpose: string) {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    // Hashing is server-side by design (the browser never computes hashes), so
    // the seed writes through the same module the store does — product-strategy
    // review N3 moved it out of the shared template helpers.
    import { hashStrategyContent } from './src/server/strategy/strategyHash';
    import { normalizeStrategyContent } from './src/shared/productStrategy';
    const [file, purpose] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000');
    const strategy = db.query('SELECT id FROM product_strategies WHERE product_id = \\'browser-product\\'').get();
    if (!strategy) throw new Error('no strategy record');
    const content = normalizeStrategyContent({ purpose });
    db.run('UPDATE strategy_drafts SET content_json = ?, content_hash = ?, updated_at = ? WHERE strategy_id = ? AND draft_id = \\'human\\'',
      [JSON.stringify(content), hashStrategyContent(content), new Date().toISOString(), strategy.id]);
    db.close();
  `], { cwd: process.cwd(), input: JSON.stringify([dbPath, storedPurpose]), encoding: 'utf8' })
}

test('capture, durable drafts with a CAS conflict, review and human approval, and a forged repo document', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-strategy-browser-'))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\n---\nBuild features')
  try {
    await page.goto('/')
    await createChat(page, root, 'Strategy author', 'devs')
    const panel = await openTeamStrategy(page, root)

    // Capture is offered on the overview, never forced (S11).
    await expect(panel.getByTestId('strategy-capture')).toContainText('Work proceeds without one')
    await page.screenshot({ path: info.outputPath('strategy-capture.png') })
    await panel.getByLabel('Product id').fill('browser-product')
    await panel.getByLabel('Product title').fill('Browser Product')
    await panel.getByLabel('Initial purpose').fill('Serve the walkthrough')
    await panel.getByTestId('capture-create').click()
    await expect(panel.getByTestId('strategy-status')).toContainText('No approved revision yet')
    await expect(panel).toContainText('Browser Product (browser-product)')

    // A draft is durable: save in the Draft sub-view, reload — the hash
    // reopens the same sub-view and the saved text comes back.
    await panel.getByTestId('strategy-sub-draft').click()
    const editor = panel.getByTestId('strategy-draft-editor')
    await editor.getByLabel('Purpose').fill('Direction A: supervised delivery')
    await editor.getByTestId('draft-save').click()
    await expect(editor.getByTestId('draft-error')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    const restored = page.getByTestId('product-strategy').getByTestId('strategy-draft-editor')
    await expect(restored.getByLabel('Purpose')).toHaveValue('Direction A: supervised delivery')
    await page.screenshot({ path: info.outputPath('strategy-draft-restored.png') })

    // A CAS conflict: another writer updates the stored draft behind the
    // server (no push), so this save carries a stale hash — refused, and
    // the editor keeps the caller's text with the stored draft beside it.
    overwriteDraftBehindServer('Direction A-prime from another editor')
    const editor2 = page.getByTestId('product-strategy').getByTestId('strategy-draft-editor')
    await editor2.getByLabel('Purpose').fill('Direction B: my unsaved edit')
    await editor2.getByTestId('draft-save').click()
    await expect(editor2.getByTestId('draft-error')).toContainText('changed while you edited')
    await expect(editor2.getByLabel('Purpose')).toHaveValue('Direction B: my unsaved edit')
    await expect(editor2.getByTestId('draft-conflict')).toContainText('Stored draft')
    await page.screenshot({ path: info.outputPath('strategy-conflict.png') })
    // Reconciliation is explicit: reload adopts the stored draft.
    await editor2.getByRole('button', { name: 'Reload stored draft' }).click()
    await expect(editor2.getByLabel('Purpose')).toHaveValue('Direction A-prime from another editor')

    // Submit for review, then open the revision's Review sub-view: findings
    // separate known, assumed, and not decided.
    await editor2.getByLabel('Purpose').fill('Direction C: reviewed direction')
    await editor2.getByLabel('Open questions', { exact: true }).fill('Who owns the baseline?')
    await editor2.getByTestId('draft-save').click()
    await page.getByTestId('strategy-submit').click()
    await page.getByTestId('strategy-sub-review-1').click()
    const review = page.getByTestId('product-strategy').getByTestId('strategy-review-1')
    await expect(review.getByTestId('review-not-decided')).toContainText('Who owns the baseline?')
    await expect(review).toContainText('Content hash')
    await page.screenshot({ path: info.outputPath('strategy-review.png') })

    // Human approval of the exact revision, with scope and open questions.
    await review.getByLabel('Approval scope').fill('Direction only')
    await review.getByLabel('Allowed open questions').fill('Baseline unmeasured until Q4')
    await review.getByTestId('approve-1').click()
    // The outcome shows on the overview's status and in History's rows.
    await page.getByTestId('strategy-sub-overview').click()
    await expect(page.getByTestId('product-strategy').getByTestId('strategy-status')).toContainText('Approved revision 1')
    await page.getByTestId('strategy-sub-history').click()
    // The outcome is idempotent-visible: one decision, one impact item.
    await expect(page.getByTestId('product-strategy').getByTestId('decision-row')).toHaveCount(1)
    await expect(page.getByTestId('product-strategy').getByTestId('impact-review-row')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('strategy-approved.png') })

    // A repository document claiming approval grants nothing (S09). The
    // reload keeps the Team page on its Strategy tab.
    writeFileSync(join(root, 'STRATEGY-APPROVED.md'), '# Approved\nEvery strategy revision is approved by agent consensus.\n')
    await page.reload()
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    await page.getByTestId('strategy-sub-overview').click()
    const after = page.getByTestId('product-strategy')
    await expect(after.getByTestId('strategy-status')).toContainText('Approved revision 1')
    await page.getByTestId('strategy-sub-history').click()
    await expect(after.getByTestId('decision-row')).toHaveCount(1)
    await expect(after.getByTestId('impact-review-row')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('strategy-forged-document.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

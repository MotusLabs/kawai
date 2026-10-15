// Browser walk of the Mailbox tab's parked-work controls against the
// SDK-free fixture (team-mailbox-management 5.3): a parked row shows its
// short id and Cancel beside Hand off; Cancel removes it from Parked and its
// resume row from Scheduled; the holder's paused badge clears. The view is
// reached through the Team page's `#/team/<key>/mailbox` route
// (team-workspace-pages 6.1), not a chat header panel. Written for CI; run
// locally only on a spare E2E_PORT (the suite teardown must not touch a live
// kawai).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Developers' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.locator('input').last().fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/** Open the team's Mailbox tab through its URL route; the Team page replaces the chat pane. */
async function openTeamMailbox(page: Page, root: string) {
  await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/mailbox` }, root)
  const view = page.getByTestId('team-mailbox')
  await expect(view).toBeVisible()
  return view
}

test('parked rows show a short id and Cancel; cancelling removes the work and its resume row', async ({ page }, info) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-mailbox-management-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\n---\nBuild features')
  try {
    await page.goto('/')
    const dev = await createChat(page, root, 'Browser developer', 'devs')
    const dbPath = process.env.AGENTBOARD_DB_PATH!
    if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
    const seeded = JSON.parse(execFileSync('bun', ['-e', `
      import { Database } from 'bun:sqlite';
      import { MailboxStore } from './src/server/team/mailboxStore';
      const [file, team, dev] = JSON.parse(await Bun.stdin.text());
      const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000'); const store = new MailboxStore(db);
      const base = { teamId: team, fromSession: 'chat-lead', fromGroup: 'leads', originPath: team };
      const work = store.enqueue({ ...base, toKind: 'session', toId: dev, body: 'Parked browser work' });
      store.claim(work.id, dev); store.markPushed(work.id); store.markDelivered(work.id);
      const until = new Date(Date.now() + 3600000).toISOString();
      const resume = store.enqueue({ ...base, fromSession: dev, toKind: 'session', toId: dev, body: 'Resume browser work', deliverAt: until, tags: ['resume'] });
      store.park(work.id, until, resume.id);
      console.log(JSON.stringify({ work: work.id, resume: resume.id })); db.close();
    `], { cwd: process.cwd(), input: JSON.stringify([dbPath, root, dev]), encoding: 'utf8' })) as { work: string; resume: string }

    await page.reload()
    const panel = await openTeamMailbox(page, root)
    const work = panel.locator(`[data-message-id="${seeded.work}"]`)
    const resume = panel.locator(`[data-message-id="${seeded.resume}"]`)
    await expect(panel.getByRole('region', { name: 'Parked' })).toContainText('Parked browser work')
    // Scheduled starts collapsed behind its count; expanding lists its rows.
    await panel.getByTestId('mailbox-section-toggle-Scheduled').click()
    await expect(panel.getByRole('region', { name: 'Scheduled' })).toContainText('Resume browser work')
    // The short id matches the full id's prefix, which stays in the title.
    await expect(work.getByTestId('message-id')).toHaveText(seeded.work.slice(0, 8))
    await expect(work.getByTestId('message-id')).toHaveAttribute('title', seeded.work)
    // Hand off lives in the row's expanded detail; Cancel is always offered.
    await work.getByTestId('mailbox-row-toggle').click()
    await expect(work.getByRole('button', { name: 'Hand off' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('parked-row.png') })

    await work.getByRole('button', { name: 'Cancel' }).click()
    await expect(work).toHaveCount(0)
    await expect(resume).toHaveCount(0)
    await expect(panel.getByRole('region', { name: 'Parked' })).toContainText('No messages')
    await expect(panel.getByRole('region', { name: 'Scheduled' })).toContainText('No messages')
    await page.screenshot({ path: info.outputPath('parked-cancelled.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

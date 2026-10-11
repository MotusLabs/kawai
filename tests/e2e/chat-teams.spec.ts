// Browser walkthrough against the SDK-free fixture and isolated durable DB.
// The headless integration test covers sending tools; here seeded mailbox
// rows exercise actual dispatch, snapshots and human controls in the browser.
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
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Developers' })).toHaveCount(1)
  await expect(dialog.getByLabel('Group')).toHaveValue('')
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.locator('input').last().fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

test('group picker, badge, peer replay and mailbox controls', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-teams-browser-'))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\n---\nBuild features')
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    const dev = await createChat(page, root, 'Browser developer', 'devs')
    await expect(page.locator(`[data-session-id="${dev}"]`).getByTestId('session-group-badge')).toHaveText('Developers')
    await page.screenshot({ path: info.outputPath('team-groups.png') })
    const dbPath = process.env.AGENTBOARD_DB_PATH!
    if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
    const seeded = JSON.parse(execFileSync('bun', ['-e', `
      import { Database } from 'bun:sqlite';
      import { MailboxStore } from './src/server/team/mailboxStore';
      const [file, team, lead, dev] = JSON.parse(await Bun.stdin.text());
      const db = new Database(file); const store = new MailboxStore(db);
      const base = { teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, body: 'Browser peer greeting', toKind: 'session', toId: dev, tags: ['review'] };
      const peer = store.enqueue(base);
      const queued = store.enqueue({ ...base, body: 'Queued browser mail', toKind: 'group', toId: 'unstaffed' });
      const scheduled = store.enqueue({ ...base, body: 'Scheduled browser mail', deliverAt: new Date(Date.now()+3600000).toISOString() });
      const dead = store.enqueue({ ...base, body: 'Dead browser mail' }); store.deadLetter(dead.id, 'killed-recipient');
      const held = store.enqueue({ ...base, body: 'Held browser mail' }); store.claim(held.id, dev); store.markPushed(held.id); store.holdUncertain(held.id, 'transcript-unavailable-or-torn');
      console.log(JSON.stringify({peer: peer.id, queued: queued.id, scheduled: scheduled.id, dead: dead.id, held: held.id})); db.close();
    `], { cwd: process.cwd(), input: JSON.stringify([dbPath, root, lead, dev]), encoding: 'utf8' }))
    // A fixture turn produces the idle notification that wakes dispatch.
    await page.getByLabel('Message Claude').fill('hello')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const peer = page.locator('[data-chat-role="peer"]')
    await expect(peer).toContainText('Browser peer greeting')
    await expect(peer).toContainText('leads')
    await expect(peer).toContainText('#review')
    await page.reload()
    await expect(peer).toHaveCount(1)
    await expect(peer).toContainText('Browser peer greeting')
    await page.getByRole('button', { name: 'Mailbox', exact: true }).click()
    const panel = page.getByTestId('team-mailbox')
    for (const text of ['Queued browser mail', 'Scheduled browser mail', 'Dead browser mail', 'Held browser mail']) await expect(panel).toContainText(text)
    await page.screenshot({ path: info.outputPath('team-mailbox.png') })
    await panel.locator(`[data-message-id="${seeded.queued}"]`).getByRole('button', { name: 'Cancel' }).click()
    await expect(panel.locator(`[data-message-id="${seeded.queued}"]`)).toHaveCount(0)
    await panel.locator(`[data-message-id="${seeded.dead}"]`).getByRole('button', { name: 'Discard' }).click()
    await expect(panel.locator(`[data-message-id="${seeded.dead}"]`)).toHaveCount(0)
    await panel.locator(`[data-message-id="${seeded.held}"]`).getByRole('button', { name: 'Retry' }).click()
    await expect(panel.locator(`[data-message-id="${seeded.held}"]`)).toHaveCount(0)
    await page.getByRole('button', { name: 'Close mailbox' }).click()
    await expect(page.locator('[data-chat-role="peer"]').filter({ hasText: 'Held browser mail' })).toContainText('Possible duplicate')
    await page.screenshot({ path: info.outputPath('team-peer-retry.png') })
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
    await page.locator(`[data-session-id="${lead}"]`).click()
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

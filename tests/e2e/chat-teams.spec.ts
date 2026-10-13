// Browser walkthrough against the SDK-free fixture and isolated durable DB.
// The headless integration test covers sending tools; here seeded mailbox
// rows exercise actual dispatch, snapshots and human controls in the browser.
// Waiting reasons (team-waiting-reasons): a seeded `spawning` row with its
// reservation renders as Starting agent, blockers render one line with the
// other constraints expandable, dead letters read as sentences with the code
// visible, and a group definition restored mid-wait updates the reason
// without any row state change.
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
    // The SDK-free fixture writes no CLI transcript: even after retry, the
    // unconfirmed receipt stays visible for review instead of vanishing.
    await expect(page.locator('[data-chat-role="peer"]').filter({ hasText: 'Held browser mail' })).toContainText('Possible duplicate')
    await expect(panel.locator(`[data-message-id="${seeded.held}"]`)).toContainText('receipt-unconfirmed-after-delivery')
    await page.getByRole('button', { name: 'Close mailbox' }).click()
    await expect(page.locator('[data-chat-role="peer"]').filter({ hasText: 'Held browser mail' })).toContainText('Possible duplicate')
    await page.screenshot({ path: info.outputPath('team-peer-retry.png') })
    // Clearing a member still works after its group file is removed.
    rmSync(join(root, '.kawai/groups/devs.md'))
    await page.getByLabel('Message Claude').fill('/clear')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('chat-transcript')).not.toContainText('Browser peer greeting')
    await expect(page.getByTestId('session-group-badge').filter({ hasText: 'devs' }).first()).toHaveAttribute('data-missing', 'true')
    await page.screenshot({ path: info.outputPath('team-clear-missing-group.png') })
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
    await page.getByRole('button', { name: 'Expand Archive section' }).click()
    // Archived rows use a drag-disabled wrapper, as in chat-drafts.spec.ts.
    await page.getByTestId('archive-rows').locator(`[data-session-id="${dev}"]`).click({ force: true })
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
    await page.locator(`[data-session-id="${lead}"]`).click()
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('waiting reasons: starting agent, expandable blockers, dead-letter labels, and a reason-only update', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'kawai-teams-waiting-'))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  // max 2: the seeded reservation plus the one live member fill the group,
  // so the Starting agent row carries its own capacity facts among the others.
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\nmax: 2\n---\nBuild features')
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Waiting lead', 'leads')
    await createChat(page, root, 'Waiting developer', 'devs')
    const dbPath = process.env.AGENTBOARD_DB_PATH!
    if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
    const seeded = JSON.parse(execFileSync('bun', ['-e', `
      import { Database } from 'bun:sqlite';
      import { MailboxStore } from './src/server/team/mailboxStore';
      const [file, team, lead, rootDir] = JSON.parse(await Bun.stdin.text());
      const db = new Database(file); const store = new MailboxStore(db);
      const base = { teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, toKind: 'group', toId: 'devs', body: 'Seeded', tags: [] };
      // A spawn held open forever (no live spawn attached): state spawning +
      // its durable reservation, exactly what the snapshot derivation reads.
      const starting = store.enqueue(base);
      store.reserveForSpawn(starting.id);
      db.prepare('INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('seeded-res', starting.id, team, 'devs', rootDir, new Date().toISOString(), 'default');
      // A queued row whose group does not exist yet: blocked on the missing definition.
      const queued = store.enqueue({ ...base, toId: 'unstaffed', body: 'Waiting on a group' });
      const dead = store.enqueue({ ...base, toKind: 'session', toId: lead, body: 'Dead browser mail' });
      store.deadLetter(dead.id, 'worktree-missing: ' + rootDir + '/gone');
      console.log(JSON.stringify({starting: starting.id, queued: queued.id, dead: dead.id})); db.close();
    `], { cwd: process.cwd(), input: JSON.stringify([dbPath, root, lead, root]), encoding: 'utf8' }))
    // A fixture turn ends and wakes dispatch: the queued row gets its reason.
    await page.getByLabel('Message Claude').fill('hello')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('button', { name: 'Mailbox', exact: true }).click()
    const panel = page.getByTestId('team-mailbox')
    const startingRow = panel.locator(`[data-message-id="${seeded.starting}"]`)
    // Starting agent: the section, the reservation's facts, the elapsed time.
    const section = panel.locator('section[aria-label="Starting agent"]')
    await expect(section).toContainText('Seeded')
    await expect(startingRow).toContainText('Starting devs on default in kawai-teams-waiting-')
    await expect(startingRow).toContainText(/for \d+m/)
    await expect(startingRow).toContainText('Starting agent')
    // The blocker stays Starting agent; its own reservation's capacity facts
    // sit in the expander, never as the blocker.
    await expect(startingRow.getByTestId('waiting-reason')).toContainText('Starting agent (devs, default')
    const expander = startingRow.getByTestId('waiting-others')
    await expander.locator('summary').click()
    await expect(expander).toContainText('Group is at capacity (2/2)')
    await expect(expander).toContainText('held by a pending spawn')
    // A dead letter reads as a sentence with the code still visible.
    const deadRow = panel.locator(`[data-message-id="${seeded.dead}"]`)
    await expect(deadRow.getByTestId('dead-letter-reason')).toContainText('The target worktree is missing')
    await expect(deadRow.getByTestId('dead-letter-reason')).toContainText('(worktree-missing:')
    // The queued row is blocked on the missing group definition.
    const queuedRow = panel.locator(`[data-message-id="${seeded.queued}"]`)
    await expect(queuedRow.getByTestId('waiting-reason')).toContainText('The group definition is missing')
    await page.screenshot({ path: info.outputPath('team-waiting-reasons.png') })
    // Slot-free update: the group definition appears; the reason flips with
    // no row state change (a reason-only re-publish).
    writeFileSync(join(root, '.kawai/groups/unstaffed.md'), '---\nlabel: Unstaffed\n---\nWork.')
    await page.getByRole('button', { name: 'Close mailbox', exact: true }).click()
    await page.getByLabel('Message Claude').fill('hello again')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('button', { name: 'Mailbox', exact: true }).click()
    await expect(panel.locator(`[data-message-id="${seeded.queued}"]`).getByTestId('waiting-reason')).toContainText('No eligible member', { timeout: 15000 })
    await page.screenshot({ path: info.outputPath('team-waiting-updated.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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
import { killChat } from './support/chatHeader'
import { createChat as createResultsChat, createTask, openTeamView, openTasks, openTaskId, reopenTask, resultsTeam, say, seedResult, spawnedSession } from './support/taskResults'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  const projectPath = dialog.getByLabel('Project Path')
  // The dialog initializes its fields during the open render, so a fill can
  // no longer be lost to a late open-transition reset (see NewSessionModal).
  await projectPath.fill(root)
  await expect(projectPath).toHaveValue(root)
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Developers' })).toHaveCount(1)
  await expect(dialog.getByLabel('Group')).toHaveValue('')
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
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
      import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
      const [file, team, lead, dev] = JSON.parse(await Bun.stdin.text());
      const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000'); const store = new MailboxStore(db);
      // One retried immediate transaction: the server is a second writer
      // (BUSY on the deferred upgrade bypasses busy_timeout), and atomic
      // seeding keeps it from seeing or claiming half a seed.
      const seeded = await retryOnSqliteBusy(() => db.transaction(() => {
        const base = { teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, body: 'Browser peer greeting', toKind: 'session', toId: dev, tags: ['review'] };
        const peer = store.enqueue(base);
        const queued = store.enqueue({ ...base, body: 'Queued browser mail', toKind: 'group', toId: 'unstaffed' });
        const scheduled = store.enqueue({ ...base, body: 'Scheduled browser mail', deliverAt: new Date(Date.now()+3600000).toISOString() });
        const dead = store.enqueue({ ...base, body: 'Dead browser mail' }); store.deadLetter(dead.id, 'killed-recipient');
        const held = store.enqueue({ ...base, body: 'Held browser mail' }); store.claim(held.id, dev); store.markPushed(held.id); store.holdUncertain(held.id, 'transcript-unavailable-or-torn');
        return {peer: peer.id, queued: queued.id, scheduled: scheduled.id, dead: dead.id, held: held.id};
      }).immediate());
      console.log(JSON.stringify(seeded)); db.close();
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
    await openTeamView(page, 'mailbox')
    const panel = page.getByTestId('team-mailbox')
    // Held for review, Dead letters, and Parked start expanded; Queued and
    // Scheduled sit collapsed behind their counts until expanded.
    await panel.getByTestId('mailbox-section-toggle-Queued').click()
    await panel.getByTestId('mailbox-section-toggle-Scheduled').click()
    for (const text of ['Queued browser mail', 'Scheduled browser mail', 'Dead browser mail', 'Held browser mail']) await expect(panel).toContainText(text)
    await page.screenshot({ path: info.outputPath('team-mailbox.png') })
    await panel.locator(`[data-message-id="${seeded.queued}"]`).getByRole('button', { name: 'Cancel' }).click()
    await expect(panel.locator(`[data-message-id="${seeded.queued}"]`)).toHaveCount(0)
    await panel.locator(`[data-message-id="${seeded.dead}"]`).getByRole('button', { name: 'Discard' }).click()
    await expect(panel.locator(`[data-message-id="${seeded.dead}"]`)).toHaveCount(0)
    await panel.locator(`[data-message-id="${seeded.held}"]`).getByRole('button', { name: 'Retry' }).click()
    await panel.locator(`[data-message-id="${seeded.held}"]`).getByTestId('mailbox-row-toggle').click()
    await expect(panel.locator(`[data-message-id="${seeded.held}"]`)).toContainText('receipt-unconfirmed-after-delivery')
    // Back to the chat through its navigator row (there is no close button
    // on the Team page; the selection leaves the route). The SDK-free
    // fixture writes no CLI transcript: even after retry, the unconfirmed
    // receipt replays in the transcript with its possible-duplicate notice.
    await page.locator(`[data-session-id="${dev}"]`).click()
    await expect(page.getByTestId('chat-view')).toBeVisible()
    await expect(page.locator('[data-chat-role="peer"]').filter({ hasText: 'Held browser mail' })).toContainText('Possible duplicate')
    await page.screenshot({ path: info.outputPath('team-peer-retry.png') })
    // Clearing a member still works after its group file is removed.
    rmSync(join(root, '.kawai/groups/devs.md'))
    await page.getByLabel('Message Claude').fill('/clear')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('chat-transcript')).not.toContainText('Browser peer greeting')
    await expect(page.getByTestId('session-group-badge').filter({ hasText: 'devs' }).first()).toHaveAttribute('data-missing', 'true')
    await page.screenshot({ path: info.outputPath('team-clear-missing-group.png') })
    await killChat(page)
    await page.getByRole('button', { name: 'Expand Archive section' }).click()
    // Archived rows use a drag-disabled wrapper, as in chat-drafts.spec.ts.
    await page.getByTestId('archive-rows').locator(`[data-session-id="${dev}"]`).click({ force: true })
    await killChat(page)
    await page.locator(`[data-session-id="${lead}"]`).click()
    await killChat(page)
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
      import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
      const [file, team, lead, rootDir] = JSON.parse(await Bun.stdin.text());
      const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000'); const store = new MailboxStore(db);
      // Same retried immediate transaction as the mailbox seeder above.
      const seeded = await retryOnSqliteBusy(() => db.transaction(() => {
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
        return {starting: starting.id, queued: queued.id, dead: dead.id};
      }).immediate());
      console.log(JSON.stringify(seeded)); db.close();
    `], { cwd: process.cwd(), input: JSON.stringify([dbPath, root, lead, root]), encoding: 'utf8' }))
    // A fixture turn ends and wakes dispatch: the queued row gets its reason.
    await page.getByLabel('Message Claude').fill('hello')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await openTeamView(page, 'mailbox')
    const panel = page.getByTestId('team-mailbox')
    // Starting agent starts collapsed behind its count; expand it and the row.
    await panel.getByTestId('mailbox-section-toggle-Starting agent').click()
    const startingRow = panel.locator(`[data-message-id="${seeded.starting}"]`)
    await startingRow.getByTestId('mailbox-row-toggle').click()
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
    await deadRow.getByTestId('mailbox-row-toggle').click()
    await expect(deadRow.getByTestId('dead-letter-reason')).toContainText('The target worktree is missing')
    await expect(deadRow.getByTestId('dead-letter-reason')).toContainText('(worktree-missing:')
    // The queued row is blocked on the missing group definition.
    await panel.getByTestId('mailbox-section-toggle-Queued').click()
    const queuedRow = panel.locator(`[data-message-id="${seeded.queued}"]`)
    await queuedRow.getByTestId('mailbox-row-toggle').click()
    await expect(queuedRow.getByTestId('waiting-reason')).toContainText('The group definition is missing', { timeout: 15000 })
    await page.screenshot({ path: info.outputPath('team-waiting-reasons.png') })
    // Slot-free update: the group definition appears; the reason flips with
    // no row state change (a reason-only re-publish).
    writeFileSync(join(root, '.kawai/groups/unstaffed.md'), '---\nlabel: Unstaffed\n---\nWork.')
    // Back to the lead's chat for the fixture turn that wakes dispatch.
    await page.locator(`[data-session-id="${lead}"]`).click()
    await page.getByLabel('Message Claude').fill('hello again')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await openTeamView(page, 'mailbox')
    await expect(page.getByTestId('team-mailbox').locator(`[data-message-id="${seeded.queued}"]`).getByTestId('waiting-reason')).toContainText('No eligible member', { timeout: 15000 })
    await page.screenshot({ path: info.outputPath('team-waiting-updated.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Task results and handoffs (task-results-handoffs 8.4). Fixture agents
// cannot call task_submit_result, so each result is seeded through the
// server's own store and the task view reopened; the fixture confirms no
// receipts, so delivered instructions settle Uncertain (still outstanding).
// Headless coverage (taskResultsE07/E08/E10) adds what a browser cannot
// drive: a contributor's refused accept, findings, and a restart.
test('E07: a result, a review queued behind the developer, and release and hand off to one reviewer', async ({ page }, info) => {
  test.setTimeout(120_000)
  const { root, worktree } = resultsTeam()
  try {
    await page.goto('/')
    await createResultsChat(page, root, 'Results lead', 'leads')
    await openTasks(page, root)
    await createTask(page, { title: 'Export', direction: 'Ship a CSV export', worktree, assign: 'devs' })
    const dev = await spawnedSession(page, worktree)
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText(/claimed|delivered|uncertain/, { timeout: 30_000 })
    const taskId = await openTaskId(page)
    seedResult(taskId, dev, worktree)
    await reopenTask(page, taskId)
    const detail = page.getByTestId('task-detail')
    const card = detail.getByTestId('task-result')
    await expect(card).toContainText('CSV export')
    await expect(card).toContainText('abc1234')
    await expect(card.getByTestId('result-test')).toContainText('(claimed)')
    await page.getByTestId('task-results').screenshot({ path: info.outputPath('task-results-section.png') })

    // Request review: it waits behind the developer occupying the worktree.
    await detail.getByTestId('task-handoff-review').click()
    const form = detail.getByTestId('task-handoff-form')
    await form.getByLabel('Request review role').selectOption('reviewers')
    await form.getByLabel('Request review instructions').fill('Review the export')
    await form.getByTestId('task-handoff-send').click()
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group reviewers')
    await expect(form).toHaveCount(0)
    await page.getByTestId('team-tab-mailbox').click()
    const mailbox = page.getByTestId('team-mailbox')
    await mailbox.getByTestId('mailbox-section-toggle-Queued').click()
    const review = mailbox.locator('article').filter({ hasText: 'Review the export' })
    await review.getByTestId('mailbox-row-toggle').click()
    await expect(review.getByTestId('waiting-reason')).toContainText('is held by', { timeout: 15_000 })

    // Release and hand off: the developer is archived; the queued review is the one that proceeds.
    await reopenTask(page, taskId, root)
    await detail.getByTestId('task-release').click()
    const confirm = detail.getByTestId('task-release-confirm')
    await expect(confirm.getByTestId('release-member')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
    await confirm.getByLabel('Review instructions').fill('Review the export')
    await page.getByTestId('task-release-confirm').screenshot({ path: info.outputPath('task-release-confirm.png') })
    await confirm.getByTestId('task-release-confirm-button').click()
    await expect(confirm).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText(/group reviewers.*(claimed|delivered|uncertain)/, { timeout: 30_000 })
    await expect(detail.getByTestId('task-assignment-history').locator('summary')).toHaveText('Assignment history (2)')
    await expect(detail.getByRole('region', { name: 'Journal' }).getByText(/worktree released for review/)).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('task-released.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E08: release is refused while the developer is busy or awaiting approval, then succeeds once', async ({ page }, info) => {
  test.setTimeout(120_000)
  const { root, worktree } = resultsTeam()
  try {
    await page.goto('/')
    const lead = await createResultsChat(page, root, 'Release lead', 'leads')
    await openTasks(page, root)
    await createTask(page, { title: 'Export', direction: 'Ship a CSV export', worktree, assign: 'devs' })
    const dev = await spawnedSession(page, worktree)
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText(/claimed|delivered|uncertain/, { timeout: 30_000 })
    const taskId = await openTaskId(page)
    seedResult(taskId, dev, worktree)
    await reopenTask(page, taskId)
    const detail = page.getByTestId('task-detail')
    const alert = page.getByTestId('team-tasks').locator('[role="alert"]')
    const history = detail.getByTestId('task-assignment-history').locator('summary')
    // The release confirm lives on the Team page, which a chat visit
    // replaces, so each refusal reopens the task and its confirm after the
    // chat interaction that sets the developer's state.
    const openConfirm = async () => {
      await reopenTask(page, taskId, root)
      await page.getByTestId('task-detail').getByTestId('task-release').click()
      const box = page.getByTestId('task-release-confirm')
      await box.getByLabel('Review instructions').fill('Review the export')
      return box
    }

    // Mid-turn: refused naming the developer; nothing archived or dispatched.
    await say(page, dev, 'keep thinking about edge cases')
    await expect(page.getByTestId('chat-status')).toHaveText('working', { timeout: 15_000 })
    let confirm = await openConfirm()
    await confirm.getByTestId('task-release-confirm-button').click()
    await expect(alert).toContainText('nothing was archived or dispatched')
    await expect(alert).toContainText('it is busy')
    // The refusal kept the form's instructions exactly as entered.
    await expect(page.getByTestId('task-release-confirm').getByLabel('Review instructions')).toHaveValue('Review the export')
    await expect(history).toHaveText('Assignment history (1)')
    await page.screenshot({ path: info.outputPath('task-release-refused-busy.png') })
    await page.locator(`[data-session-id="${dev}"]`).click()
    await expect(page.getByTestId('chat-status')).toHaveText('waiting', { timeout: 30_000 })

    // Awaiting an approval: refused, naming it.
    await say(page, dev, 'approval')
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible({ timeout: 15_000 })
    confirm = await openConfirm()
    await confirm.getByTestId('task-release-confirm-button').click()
    await expect(alert).toContainText('awaiting an approval or answer')
    await expect(page.getByTestId('task-release-confirm').getByLabel('Review instructions')).toHaveValue('Review the export')
    await expect(history).toHaveText('Assignment history (1)')

    // Resolved and the turn ended: one release, one review dispatch. The
    // approval card lives in the developer's chat, so return to it first.
    await page.locator(`[data-session-id="${dev}"]`).click()
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(page.getByTestId('chat-transcript')).toContainText('Request accepted.')
    await expect(page.getByTestId('chat-status')).toHaveText('waiting', { timeout: 15_000 })
    // Retry from the lead's chat: archiving the selected developer chat would deselect it.
    await page.locator(`[data-session-id="${lead}"]`).first().click()
    await reopenTask(page, taskId, root)
    await detail.getByTestId('task-release').click()
    await confirm.getByLabel('Review instructions').fill('Review the export')
    await confirm.getByTestId('task-release-confirm-button').click()
    await expect(confirm).toHaveCount(0, { timeout: 15_000 })
    await expect(history).toHaveText('Assignment history (2)')
    await expect(detail.getByRole('region', { name: 'Journal' }).getByText(/worktree released for review/)).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('task-release-succeeded.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E10: a contributor result stays open; amendment flags it; children never close the parent; accept needs a reason', async ({ page }, info) => {
  const { root } = resultsTeam()
  try {
    await page.goto('/')
    const contributor = await createResultsChat(page, root, 'Results contributor', 'devs')
    await createResultsChat(page, root, 'Acceptance lead', 'leads')
    await openTasks(page, root)
    await createTask(page, { title: 'Report', direction: 'CSV export', acceptance: 'Exports every row' })
    seedResult(await openTaskId(page), contributor, null)
    await reopenTask(page, 'Report', root)
    const detail = page.getByTestId('task-detail')
    // The contributor's result leaves the task open.
    await expect(detail.getByTestId('task-detail-status')).toHaveText('open')
    await expect(detail.getByTestId('task-result')).toContainText('CSV export')

    // An amendment flags the earlier result Needs re-evaluation.
    await detail.getByLabel('Draft direction').fill('CSV and TSV export')
    await detail.getByLabel('Rationale').fill('TSV too')
    await detail.getByTestId('task-publish').click()
    await expect(detail.getByTestId('result-reevaluation')).toHaveText('Needs re-evaluation')

    // A finished child never closes its parent; an open one stays listed.
    await createTask(page, { title: 'Headers', direction: 'Header row', parent: 'Report' })
    await detail.getByRole('button', { name: 'Mark done', exact: true }).click()
    await expect(detail.getByTestId('task-detail-status')).toHaveText('done')
    await createTask(page, { title: 'Docs', direction: 'Document it', parent: 'Report' })
    await page.getByTestId('team-tasks').getByRole('button', { name: 'All tasks' }).click()
    await expect(page.getByTestId('team-tasks').locator('[data-task-id]').filter({ hasText: 'Report' }).getByTestId('task-result-badge')).toHaveAttribute('data-state', 'flagged')
    await reopenTask(page, 'Report', root)
    await expect(detail.getByTestId('task-detail-status')).toHaveText('open')

    // Accept: criteria and open children shown; a reason is required and journaled.
    await detail.getByTestId('task-accept').click()
    await expect(detail.getByTestId('accept-criteria')).toHaveText('Exports every row')
    await expect(detail.getByTestId('accept-open-children')).toContainText('Docs')
    await expect(detail.getByTestId('accept-open-children')).not.toContainText('Headers')
    await expect(detail.getByTestId('task-accept-confirm-button')).toBeDisabled()
    await detail.getByLabel('Acceptance reason').fill('TSV follows in Docs')
    await page.getByTestId('task-accept-confirm').screenshot({ path: info.outputPath('task-accept-confirm.png') })
    await detail.getByTestId('task-accept-confirm-button').click()
    await expect(detail.getByTestId('task-detail-status')).toHaveText('done')
    await expect(detail.getByTestId('result-accepted')).toHaveText('Accepted by Human')
    await expect(detail.getByRole('region', { name: 'Journal' })).toContainText('TSV follows in Docs')
    await reopenTask(page, 'Docs', root)
    await expect(detail.getByTestId('task-detail-status')).toHaveText('open')
    await page.screenshot({ path: info.outputPath('task-accepted.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

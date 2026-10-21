// Browser walk of the Messages tab against the SDK-free fixture (E06 and the
// E11 slice): named senders, chronological thread order, task filtering, the
// delivered history in each row, click-through to a live participant, a reload
// with one sender killed, and — beside the Mailbox tab's unchanged delivery
// operations — an uncertain retry to the same recipient with its
// possible-duplicate explanation, retained retry/discard history, and survival
// across a server restart. The views are reached through the Team page's
// `#/team/<key>/…` routes (team-workspace-pages 6.1), not chat header panels.
// Written for CI; not run locally against a live kawai (its teardown would
// kill it).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killChat } from './support/chatHeader'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

/** A throwaway team directory with two roles, canonically resolved like the server. */
function teamRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-team-messages-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\n---\nBuild features')
  return root
}

async function createChat(page: Page, root: string, name: string, group: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(root)
  // Groups resolve from the project path; wait for that before choosing one.
  await expect(dialog.getByLabel('Group').locator('option', { hasText: 'Team leads' })).toHaveCount(1)
  await dialog.getByLabel('Group').selectOption(group)
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
  return (await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().getAttribute('data-session-id'))!
}

/**
 * Seed the team's durable rows through the real stores: one task, its thread
 * (a group message delivered to the developer, then a reply back to its
 * sender), an unrelated pending row for the task filter to exclude, and — when
 * asked — two uncertain rows claimed by the developer. Task revisions on the
 * rows are whatever each push carried, not what the task says now.
 */
function seed(args: { dbPath: string; team: string; lead: string; dev: string; uncertain?: boolean }) {
  // Two legal homes for a seeded database: the run's isolated agentboard, or
  // the throwaway team root this test created and will delete.
  const isolated = [process.env.E2E_TMUX_TMPDIR!, args.team].some(root => args.dbPath.startsWith(root))
  if (!isolated) throw new Error('Refuse seeding a non-isolated database')
  return JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const { dbPath, team, lead, dev, uncertain } = JSON.parse(await Bun.stdin.text());
    const db = new Database(dbPath); db.exec('PRAGMA busy_timeout = 5000'); const store = new MailboxStore(db); const tasks = new TaskStore(db, store);
    // One retried immediate transaction: the server is a second writer (BUSY
    // on the deferred upgrade bypasses busy_timeout), and atomic seeding keeps
    // it from seeing or claiming half a seed.
    const out = await retryOnSqliteBusy(() => db.transaction(() => {
      const task = tasks.create({ teamId: team, title: 'Export CSV', direction: 'Ship a CSV export', creator: { kind: 'human', sessionId: null } });
      const sent = { teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, taskId: task.id };
      const first = store.enqueue({ ...sent, toKind: 'group', toId: 'devs', body: 'Please build the CSV export' });
      store.claim(first.id, dev); store.markPushed(first.id, undefined, 1); store.markDelivered(first.id);
      const reply = store.enqueue({ ...sent, toKind: 'session', toId: lead, fromSession: dev, fromGroup: 'devs', body: 'On it — the branch is ready', inReplyTo: store.get(first.id) });
      store.claim(reply.id, lead); store.markPushed(reply.id, undefined, 1); store.markDelivered(reply.id);
      const other = store.enqueue({ teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, toKind: 'group', toId: 'devs', body: 'Unrelated status ping' });
      const seeded = { task: task.id, first: first.id, reply: reply.id, other: other.id };
      if (uncertain) {
        for (const body of ['Receipt evidence missing', 'Receipt evidence torn']) {
          const held = store.enqueue({ ...sent, toKind: 'session', toId: dev, body });
          store.claim(held.id, dev); store.markPushed(held.id); store.holdUncertain(held.id, 'transcript-unavailable-or-torn');
          seeded[body.includes('missing') ? 'held' : 'torn'] = held.id;
        }
      }
      return seeded;
    }).immediate());
    console.log(JSON.stringify(out)); db.close();
  `], { cwd: process.cwd(), input: JSON.stringify(args), encoding: 'utf8' })) as {
    task: string; first: string; reply: string; other: string; held?: string; torn?: string
  }
}

/**
 * Open the team's Messages tab through its URL route (6.1): the Team page
 * replaces the chat pane while the selection stays, so returning to a chat is
 * one navigator click (or one Back). Idempotent — re-navigating the same hash
 * pushes no new history entry.
 */
async function openTeamMessages(page: Page, root: string) {
  await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/messages` }, root)
  const view = page.getByTestId('team-messages')
  await expect(view).toBeVisible()
  return view
}

/** Open the team's Mailbox tab the same way. */
async function openTeamMailbox(page: Page, root: string) {
  await page.evaluate(teamKey => { window.location.hash = `#/team/${encodeURIComponent(teamKey)}/mailbox` }, root)
  const view = page.getByTestId('team-mailbox')
  await expect(view).toBeVisible()
  return view
}

/** The thread row a message belongs to — its id is the thread's root id. */
const threadRow = (page: Page, threadId: string) =>
  page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`)

/** Row with this id, in a thread's expansion or detail. */
const row = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`)

/** Expand a thread row in place so every loaded message of it renders — idempotent, since kept expansion survives the open. */
async function expandThread(page: Page, threadId: string) {
  const toggle = threadRow(page, threadId).getByTestId('thread-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

/**
 * The retried message's history is two real holds, not one hold recorded twice.
 *
 * Retry requeues the row to the same recipient; the live dispatcher re-claims
 * and re-pushes it, and the receipt is still unconfirmable (the fixture
 * transcript carries no envelope row with the id), so it is held again. Each
 * hold follows a claim — both rows therefore say "was claimed · claimed by …"
 * — and the reasons name what happened: the seed's torn transcript first, then
 * the unconfirmed receipt of the re-delivery (or, if the recipient went
 * unavailable in the push, that hold instead).
 */
async function expectHeldHistory(thread: Locator) {
  const held = thread.locator('[data-kind="held-uncertain"]')
  await expect(held).toHaveCount(2)
  await expect(held.nth(0)).toContainText('transcript-unavailable-or-torn')
  await expect(held.nth(1)).toContainText(/receipt-unconfirmed-after-delivery|recipient-unavailable-after-push/)
  await expect(thread.locator('[data-kind="retried"]')).toHaveCount(1)
  expect(await thread.locator('[data-kind]').evaluateAll(
    nodes => nodes.map(node => node.getAttribute('data-kind')))).toEqual([
    'sent', 'claimed', 'pushed', 'held-uncertain',
    'retried', 'claimed', 'pushed', 'held-uncertain',
  ])
}

test('E06: named senders, chronological threads, task filtering, and a killed sender', async ({ page }, info) => {
  const root = teamRoot()
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    const dev = await createChat(page, root, 'Browser developer', 'devs')
    const ids = seed({
      dbPath: process.env.AGENTBOARD_DB_PATH!, team: root, lead, dev,
    })

    // The team's Messages tab is delivered history and pending mail together,
    // grouped by thread — the collapsed row shows each thread's newest
    // message, naming people rather than ids.
    const panel = await openTeamMessages(page, root)
    await expect(row(page, ids.other)).toBeVisible()
    await expect(row(page, ids.reply)).toBeVisible()
    await expandThread(page, ids.first)
    await expect(row(page, ids.first)).toBeVisible()
    const names = panel.getByTestId('participant-name')
    await expect(names.filter({ hasText: 'Browser team lead' }).first()).toBeVisible()
    await expect(names.filter({ hasText: 'Browser developer' }).first()).toBeVisible()
    await expect(panel.getByText('Task revision 1').first()).toBeVisible()
    await page.screenshot({ path: info.outputPath('messages-list.png') })

    // Thread detail is chronological with the reply relation and each row's
    // append-only history.
    await threadRow(page, ids.first).getByRole('button', { name: 'Open thread' }).click()
    const thread = page.getByTestId('thread-detail')
    await expect(thread).toBeVisible()
    await expect(thread.getByTestId('thread-entry')).toHaveCount(2)
    const bodies = thread.getByTestId('message-body')
    await expect(bodies.nth(0)).toHaveText('Please build the CSV export')
    await expect(bodies.nth(1)).toHaveText('On it — the branch is ready')
    await expect(thread.getByTestId('message-reply-to')).toContainText('Please build the CSV export')
    await thread.getByTestId('message-events').first().locator('summary').click()
    await expect(thread.locator('[data-kind="delivered"]').first()).toBeVisible()
    await expect(thread.locator('[data-kind="sent"]').first()).toBeVisible()
    await page.screenshot({ path: info.outputPath('thread-history.png') })

    // A live participant in the thread is a link into its chat: following it
    // leaves the Team page (the pane returns to the chat).
    await thread.getByTestId('participant-name').first().click()
    await expect(page.getByTestId('chat-view')).toContainText('Browser team lead')

    // Task detail embeds the task-filtered subset: its own two rows, never
    // the unrelated ping. Reach it through the chat header's Team button.
    await page.getByTestId('chat-team-button').click()
    await page.getByTestId('team-tab-tasks').click()
    await expect(page.getByTestId('team-tasks')).toBeVisible()
    await page.locator('[data-task-id]').getByRole('button', { name: 'Export CSV' }).click()
    const detail = page.getByTestId('task-detail')
    await expect(detail.getByTestId('message-row')).toHaveCount(2)
    await expect(detail.locator(`[data-message-id="${ids.other}"]`)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('task-messages.png') })

    // Reload: the hash reopens the Team page on Messages; the selection is
    // untouched (D10), so the lead's chat is one click away.
    await openTeamMessages(page, root)
    await page.reload()
    await expect(page.getByTestId('team-messages')).toBeVisible()
    // In-memory expansion does not survive the reload; expand again.
    await expandThread(page, ids.first)
    await expect(row(page, ids.first)).toBeVisible()
    await page.locator(`[data-session-id="${lead}"]`).click()
    await killChat(page)
    await expect(page.locator(`[data-session-id="${lead}"]`)).toHaveCount(0)
    await page.locator(`[data-session-id="${dev}"]`).click()
    const revived = await openTeamMessages(page, root)
    await expandThread(page, ids.first)
    await expect(row(page, ids.first)).toBeVisible()
    const panelNames = revived.getByTestId('participant-name')
    const gone = panelNames.filter({ hasText: 'Browser team lead' }).first()
    await expect(gone).toHaveText('Browser team lead (gone)')
    // D3: a killed participant is a label and no link; a live one still opens.
    await expect(revived.getByRole('button', { name: 'Browser team lead' })).toHaveCount(0)
    await expect(revived.getByRole('button', { name: 'Browser developer' }).first()).toBeVisible()
    await threadRow(page, ids.first).getByRole('button', { name: 'Open thread' }).click()
    await expect(page.getByTestId('thread-detail').getByTestId('thread-entry')).toHaveCount(2)
    await page.screenshot({ path: info.outputPath('killed-sender.png') })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E11 slice: uncertain retry keeps its recipient, history, and survives a restart', async ({ page }, info) => {
  const root = teamRoot()
  const port = process.env.KAWAI_TEAM_MESSAGES_PORT || '4192'
  const url = `http://127.0.0.1:${port}`
  const dbPath = join(root, 'agentboard.db')
  let server: ChildProcess | null = null
  let diagnostics = ''
  const start = async () => {
    // Same guard as playwright.config.ts's webServer command: the server pins
    // AGENTBOARD_STATIC_DIR, so a clean tree has to build before it can serve.
    if (!existsSync(join(process.cwd(), 'dist/client'))) {
      execFileSync('bun', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit' })
    }
    server = spawn('bun', ['src/server/index.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '1',
        PORT: port, HOSTNAME: '127.0.0.1',
        AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'),
        AGENTBOARD_DB_PATH: dbPath, LOG_FILE: join(root, 'agentboard.log'),
        TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'kawai-team-messages',
        AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
        CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
        AGENTBOARD_REMOTE_HOSTS: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
      },
    })
    server.stdout?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000) })
    server.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000) })
    await expect.poll(async () => {
      try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false }
    }, { timeout: 30_000 }).toBe(true)
  }
  const stop = async () => {
    if (!server || server.exitCode !== null) return
    const stopped = new Promise<void>(resolve => server!.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await stopped
    // The server leaves its private tmux server (TMUX_TMPDIR=root) running,
    // and that daemon's cwd is this checkout — every run would leak one and
    // pin the directory. Kill it through its own socket path, built from this
    // spec's root and uid, so no other tmux server is ever addressed; a
    // socket with no server just errors and is ignored.
    try {
      execFileSync('tmux', ['-S', join(root, `tmux-${process.getuid()}`, 'default'), 'kill-server'], { stdio: 'ignore' })
    } catch {
      // No server on that socket — nothing to clean up.
    }
    server = null
  }
  try {
    await start()
    await page.goto(url)
    const lead = await createChat(page, root, 'Recovery lead', 'leads')
    const dev = await createChat(page, root, 'Recovery developer', 'devs')
    const ids = seed({ dbPath, team: root, lead, dev, uncertain: true })
    expect(ids.held).toBeTruthy()
    expect(ids.torn).toBeTruthy()

    // The Mailbox tab keeps its delivery operations and explains the retry.
    const mailbox = await openTeamMailbox(page, root)
    const held = mailbox.locator(`[data-message-id="${ids.held}"]`)
    await held.getByTestId('mailbox-row-toggle').click()
    await expect(held).toContainText(`Retry to ${dev} with a possible-duplicate notice, or discard.`)
    await page.screenshot({ path: info.outputPath('uncertain-mailbox.png') })

    // Retry goes back to the same recipient and explains itself on the row.
    // The row itself stays in the Mailbox — queued again, or back in review if
    // dispatch re-holds an unconfirmed receipt — so disappearance is not the
    // signal; the possible-duplicate flag and the unchanged recipient are.
    await held.getByRole('button', { name: 'Retry' }).click()
    await openTeamMessages(page, root)
    const retried = row(page, ids.held!)
    await expect(retried).toBeVisible()
    await expect(retried.getByTestId('message-to')).toContainText('Recovery developer')
    await expect(retried.getByTestId('message-to')).not.toContainText('Recovery lead')
    await expect(retried.getByTestId('message-possible-duplicate')).toBeVisible()
    await expect(retried.getByTestId('message-body')).toHaveText('Receipt evidence missing')
    await threadRow(page, ids.held!).getByRole('button', { name: 'Open thread' }).click()
    const thread = page.getByTestId('thread-detail')
    await thread.getByTestId('message-events').first().locator('summary').click()
    await expectHeldHistory(thread)
    await page.screenshot({ path: info.outputPath('retry-history.png') })

    // A discard keeps its history too — the thread is the record, not the row.
    const mailboxAgain = await openTeamMailbox(page, root)
    await mailboxAgain.locator(`[data-message-id="${ids.torn}"]`)
      .getByRole('button', { name: 'Discard' }).click()
    await expect(mailboxAgain.locator(`[data-message-id="${ids.torn}"]`)).toHaveCount(0)
    await openTeamMessages(page, root)
    await threadRow(page, ids.torn!).getByRole('button', { name: 'Open thread' }).click()
    const discarded = page.getByTestId('thread-detail')
    await discarded.getByTestId('message-events').first().locator('summary').click()
    await expect(discarded.locator('[data-kind="held-uncertain"]')).toBeVisible()
    await expect(discarded.locator('[data-kind="discarded"]')).toBeVisible()

    // Restart the isolated server: the retry, the discard, and their events are
    // rows, so all of it is still on screen afterwards.
    await stop()
    await start()
    await page.goto(url)
    await openTeamMessages(page, root)
    await expect(row(page, ids.held!)).toBeVisible()
    await expect(row(page, ids.held!).getByTestId('message-possible-duplicate')).toBeVisible()
    await expect(row(page, ids.torn!)).toBeVisible()
    await threadRow(page, ids.held!).getByRole('button', { name: 'Open thread' }).click()
    const after = page.getByTestId('thread-detail')
    await after.getByTestId('message-events').first().locator('summary').click()
    await expectHeldHistory(after)
    await page.screenshot({ path: info.outputPath('after-restart.png') })
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- server ---\n${diagnostics}`)
  } finally {
    await stop()
    rmSync(root, { recursive: true, force: true })
  }
})

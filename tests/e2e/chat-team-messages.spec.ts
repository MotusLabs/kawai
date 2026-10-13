// Browser walk of the Messages view against the SDK-free fixture (E06 and the
// E11 slice): named senders, chronological thread order, task filtering, the
// delivered history in each row, click-through to a live participant, a reload
// with one sender killed, and — beside the Mailbox panel's unchanged delivery
// operations — an uncertain retry to the same recipient with its
// possible-duplicate explanation, retained retry/discard history, and survival
// across a server restart. Written for CI; not run locally against a live
// kawai (its teardown would kill it).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  await dialog.locator('input').last().fill(name)
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
    const { dbPath, team, lead, dev, uncertain } = JSON.parse(await Bun.stdin.text());
    const db = new Database(dbPath); const store = new MailboxStore(db); const tasks = new TaskStore(db, store);
    const task = tasks.create({ teamId: team, title: 'Export CSV', direction: 'Ship a CSV export', creator: { kind: 'human', sessionId: null } });
    const sent = { teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, taskId: task.id };
    const first = store.enqueue({ ...sent, toKind: 'group', toId: 'devs', body: 'Please build the CSV export' });
    store.claim(first.id, dev); store.markPushed(first.id, undefined, 1); store.markDelivered(first.id);
    const reply = store.enqueue({ ...sent, toKind: 'session', toId: lead, fromSession: dev, fromGroup: 'devs', body: 'On it — the branch is ready', inReplyTo: store.get(first.id) });
    store.claim(reply.id, lead); store.markPushed(reply.id, undefined, 1); store.markDelivered(reply.id);
    const other = store.enqueue({ teamId: team, fromSession: lead, fromGroup: 'leads', originPath: team, toKind: 'group', toId: 'devs', body: 'Unrelated status ping' });
    const out = { task: task.id, first: first.id, reply: reply.id, other: other.id };
    if (uncertain) {
      for (const body of ['Receipt evidence missing', 'Receipt evidence torn']) {
        const held = store.enqueue({ ...sent, toKind: 'session', toId: dev, body });
        store.claim(held.id, dev); store.markPushed(held.id); store.holdUncertain(held.id, 'transcript-unavailable-or-torn');
        out[body.includes('missing') ? 'held' : 'torn'] = held.id;
      }
    }
    console.log(JSON.stringify(out)); db.close();
  `], { cwd: process.cwd(), input: JSON.stringify(args), encoding: 'utf8' })) as {
    task: string; first: string; reply: string; other: string; held?: string; torn?: string
  }
}

/** Open the Messages side panel on the currently selected chat.
 *
 * Idempotent: the view is per-session state with no unmount cleanup, so it can
 * still be open when you come back to a chat — clicking the toggle again would
 * close it. Only click when the panel is not already showing. */
async function openMessages(page: Page) {
  const panel = page.getByTestId('team-messages')
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await expect(panel).toBeVisible()
}

/** Row with this id, in the Messages list or a thread. */
const row = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`)

test('E06: named senders, chronological threads, task filtering, and a killed sender', async ({ page }, info) => {
  const root = teamRoot()
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    const dev = await createChat(page, root, 'Browser developer', 'devs')
    const ids = seed({
      dbPath: process.env.AGENTBOARD_DB_PATH!, team: root, lead, dev,
    })

    // The developer's Messages list is delivered history and pending mail
    // together, newest first, naming people rather than ids.
    await page.locator(`[data-session-id="${dev}"]`).click()
    await openMessages(page)
    const panel = page.getByTestId('team-messages')
    for (const id of [ids.other, ids.reply, ids.first]) await expect(row(page, id)).toBeVisible()
    const names = panel.getByTestId('participant-name')
    await expect(names.filter({ hasText: 'Browser team lead' }).first()).toBeVisible()
    await expect(names.filter({ hasText: 'Browser developer' }).first()).toBeVisible()
    await expect(panel.getByText('Task revision 1').first()).toBeVisible()
    await page.screenshot({ path: info.outputPath('messages-list.png') })

    // Thread detail is chronological with the reply relation and each row's
    // append-only history.
    await row(page, ids.first).getByRole('button', { name: 'Open thread' }).click()
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

    // Task detail embeds the task-filtered subset: its own two rows, never the
    // unrelated ping.
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.locator('[data-task-id]').getByRole('button', { name: 'Export CSV' }).click()
    const detail = page.getByTestId('task-detail')
    await expect(detail.getByTestId('message-row')).toHaveCount(2)
    await expect(detail.locator(`[data-message-id="${ids.other}"]`)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('task-messages.png') })

    // A live participant is a link into its chat; a gone one never is.
    await openMessages(page)
    await row(page, ids.first).getByTestId('participant-name').first().click()
    await expect(page.getByTestId('chat-view')).toContainText('Browser team lead')

    // Reload, then kill that sender: its identity and the thread survive, and
    // navigation stays sound — the gone label is text, the live one still opens.
    await page.reload()
    await page.locator(`[data-session-id="${dev}"]`).click()
    await openMessages(page)
    await expect(row(page, ids.first)).toBeVisible()
    await page.locator(`[data-session-id="${lead}"]`).click()
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
    await expect(page.locator(`[data-session-id="${lead}"]`)).toHaveCount(0)
    await page.locator(`[data-session-id="${dev}"]`).click()
    await openMessages(page)
    const panelNames = panel.getByTestId('participant-name')
    const gone = panelNames.filter({ hasText: 'Browser team lead' }).first()
    await expect(gone).toHaveText('Browser team lead (gone)')
    // D3: a killed participant is a label and no link; a live one still opens.
    await expect(panel.getByRole('button', { name: 'Browser team lead' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Browser developer' }).first()).toBeVisible()
    await row(page, ids.first).getByRole('button', { name: 'Open thread' }).click()
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

    // The Mailbox keeps its delivery operations and explains the retry.
    await page.locator(`[data-session-id="${dev}"]`).click()
    await page.getByRole('button', { name: 'Mailbox', exact: true }).click()
    const mailbox = page.getByTestId('team-mailbox')
    await expect(mailbox.locator(`[data-message-id="${ids.held}"]`)).toContainText(
      `Retry to ${dev} with a possible-duplicate notice, or discard.`)
    await page.screenshot({ path: info.outputPath('uncertain-mailbox.png') })

    // Retry goes back to the same recipient and explains itself on the row.
    // The row itself stays in the Mailbox — queued again, or back in review if
    // dispatch re-holds an unconfirmed receipt — so disappearance is not the
    // signal; the possible-duplicate flag and the unchanged recipient are.
    await mailbox.locator(`[data-message-id="${ids.held}"]`).getByRole('button', { name: 'Retry' }).click()
    await openMessages(page)
    const retried = row(page, ids.held!)
    await expect(retried).toBeVisible()
    await expect(retried.getByTestId('message-to')).toContainText('Recovery developer')
    await expect(retried.getByTestId('message-to')).not.toContainText('Recovery lead')
    await expect(retried.getByTestId('message-possible-duplicate')).toBeVisible()
    await expect(retried.getByTestId('message-body')).toHaveText('Receipt evidence missing')
    await retried.getByRole('button', { name: 'Open thread' }).click()
    const thread = page.getByTestId('thread-detail')
    await thread.getByTestId('message-events').first().locator('summary').click()
    await expect(thread.locator('[data-kind="held-uncertain"]')).toBeVisible()
    await expect(thread.locator('[data-kind="retried"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath('retry-history.png') })

    // A discard keeps its history too — the thread is the record, not the row.
    await page.getByRole('button', { name: 'Mailbox', exact: true }).click()
    await page.getByTestId('team-mailbox').locator(`[data-message-id="${ids.torn}"]`)
      .getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByTestId('team-mailbox').locator(`[data-message-id="${ids.torn}"]`)).toHaveCount(0)
    await openMessages(page)
    await row(page, ids.torn!).getByRole('button', { name: 'Open thread' }).click()
    const discarded = page.getByTestId('thread-detail')
    await discarded.getByTestId('message-events').first().locator('summary').click()
    await expect(discarded.locator('[data-kind="held-uncertain"]')).toBeVisible()
    await expect(discarded.locator('[data-kind="discarded"]')).toBeVisible()

    // Restart the isolated server: the retry, the discard, and their events are
    // rows, so all of it is still on screen afterwards.
    await stop()
    await start()
    await page.goto(url)
    await page.locator(`[data-session-id="${dev}"]`).click()
    await openMessages(page)
    await expect(row(page, ids.held!)).toBeVisible()
    await expect(row(page, ids.held!).getByTestId('message-possible-duplicate')).toBeVisible()
    await expect(row(page, ids.torn!)).toBeVisible()
    await row(page, ids.held!).getByRole('button', { name: 'Open thread' }).click()
    const after = page.getByTestId('thread-detail')
    await after.getByTestId('message-events').first().locator('summary').click()
    await expect(after.locator('[data-kind="held-uncertain"]')).toBeVisible()
    await expect(after.locator('[data-kind="retried"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath('after-restart.png') })
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- server ---\n${diagnostics}`)
  } finally {
    await stop()
    rmSync(root, { recursive: true, force: true })
  }
})

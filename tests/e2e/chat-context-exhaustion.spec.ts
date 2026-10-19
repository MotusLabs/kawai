// Context-exhaustion walkthroughs against the SDK-free fixture
// (chat-context-exhaustion 2.3, 6.1): a "prompt-too-long" turn returns the
// incident's frames — the CLI's synthetic "Prompt is too long" reply and a
// success result marked is_error with terminal reason blocking_limit. A
// human-created chat shows the failed turn's error row, the navigator badge,
// the header row, and a needs-you attention item, all gone once a successful
// turn clears the flag. Lead task mail to a spawned developer is
// dead-lettered `context-exhausted`, the member is archived, the lead gets the
// decision note, and the agent-owned attention item resolves after a new
// dispatch. Fixture agents cannot call MCP tools, so the lead's task and mail
// are seeded with the server's own stores.
// Written for CI; run locally only on a spare E2E_PORT after `bun run build`.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createChat, reopenTask, resultsTeam, say } from './support/taskResults'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')
test.describe.configure({ mode: 'serial' })

function isolatedDb(): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  return dbPath
}

/** Run a script against the isolated database with the server's own stores; returns its stdout. */
function withDb(script: string, args: unknown[]): string {
  return execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { MailboxStore } from './src/server/team/mailboxStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { retryOnSqliteBusy } from './src/server/__tests__/sqliteBusyRetry';
    const [file, ...args] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000');
    // One immediate transaction against the server's live database, retried
    // whole on SQLITE_BUSY (the deferred-upgrade path skips the busy handler).
    const out = await retryOnSqliteBusy(() => db.transaction(() => { ${script} }).immediate());
    process.stdout.write(String(out ?? '')); db.close();
  `], { cwd: process.cwd(), input: JSON.stringify([isolatedDb(), ...args]), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } }).trim()
}

/** A task the lead created in the worktree, and its group task mail to devs; returns both ids. */
function seedLeadDispatch(root: string, worktree: string, lead: string, body: string): { taskId: string; messageId: string } {
  return JSON.parse(withDb(`
    const [root, worktree, lead, body] = args;
    const task = new TaskStore(db).create({ teamId: root + '/.git', title: 'Exhaust export', direction: 'Export rows',
      creator: { kind: 'agent', sessionId: lead }, worktree });
    const message = new MailboxStore(db).enqueue({ teamId: root + '/.git', fromSession: lead, fromGroup: 'leads', originPath: root,
      body, toKind: 'group', toId: 'devs', tags: [], taskId: task.id });
    return JSON.stringify({ taskId: task.id, messageId: message.id });
  `, [root, worktree, lead, body]))
}

/** The spawned member's session id and archive time in `worktree` (read-only). */
function spawnedIn(worktree: string): { sessionId: string; archivedAt: string | null } | null {
  const raw = withDb(`
    const row = db.query('SELECT session_id, archived_at FROM chat_sessions WHERE spawned = 1 AND project_path = ? ORDER BY created_at LIMIT 1').get(args[0]);
    return row ? JSON.stringify({ sessionId: row.session_id, archivedAt: row.archived_at }) : '';
  `, [worktree])
  return raw ? JSON.parse(raw) : null
}

/** Kill the chats a walkthrough made, as the UI does, so no leftover chat is auto-selected in later specs. */
async function killSessions(page: Page, sessionIds: string[]) {
  if (sessionIds.length === 0) return
  await page.evaluate(async (ids) => {
    const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    for (const sessionId of ids) ws.send(JSON.stringify({ type: 'session-kill', sessionId }))
    await new Promise(resolve => setTimeout(resolve, 500))
    ws.close()
  }, sessionIds)
  await expect.poll(() => withDb(`
    return args.filter(id => db.query('SELECT 1 FROM chat_sessions WHERE session_id = ?').get(id)).length;
  `, sessionIds), { timeout: 15_000 }).toBe('0')
}

/** Every spawned session in `worktree` (read-only). */
function spawnedAll(worktree: string): string[] {
  const raw = withDb(`
    return JSON.stringify(db.query('SELECT session_id FROM chat_sessions WHERE spawned = 1 AND project_path = ?').all(args[0]).map(row => row.session_id));
  `, [worktree])
  return raw ? JSON.parse(raw) : []
}

const queue = (page: Page) => page.getByTestId('team-attention-queue')
const exhaustedItems = (page: Page) => queue(page).locator('[data-kind="context-exhausted"]')
async function openTab(page: Page, teamKey: string, tab: string) {
  await page.evaluate(([key, name]) => { window.location.hash = `#/team/${encodeURIComponent(key!)}/${name}` }, [teamKey, tab])
  await expect(page.getByTestId('team-workspace')).toHaveAttribute('data-team-key', teamKey)
}

test('2.3/D8: a human-created chat shows the failed turn, badge, header row, and a needs-you item until a successful turn', async ({ page }, info) => {
  const team = resultsTeam()
  const made: string[] = []
  try {
    await page.goto('/')
    const chat = await createChat(page, team.root, 'CE human chat', 'leads')
    made.push(chat)
    await say(page, chat, 'go prompt-too-long')
    await expect(page.getByTestId('chat-transcript').getByRole('alert')).toContainText('Prompt is too long (blocking_limit)', { timeout: 15_000 })
    await expect(page.getByTestId('chat-status')).toHaveText('waiting', { timeout: 15_000 })
    const row = page.locator(`[data-session-id="${chat}"]`).first()
    await expect(row.getByTestId('session-exhausted-badge')).toHaveText('Context exhausted')
    await expect(page.getByTestId('chat-exhausted')).toHaveText('Context exhausted (blocking_limit) · Run /compact or start a new session')
    await page.screenshot({ path: info.outputPath('flagged-chat.png') })

    await openTab(page, team.root, 'tasks')
    const item = queue(page).getByTestId('attention-human').locator('[data-kind="context-exhausted"]')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('CE human chat stopped: context exhausted (blocking_limit)')
    await page.screenshot({ path: info.outputPath('needs-you-item.png') })
    // Its action opens the chat.
    await item.getByTestId('attention-action').click()
    await expect(page.getByTestId('chat-view')).toContainText('CE human chat')

    // A successful turn clears the flag: badge, header row, and item all go.
    await say(page, chat, 'hello')
    await expect(page.getByTestId('chat-exhausted')).toHaveCount(0, { timeout: 15_000 })
    await expect(row.getByTestId('session-exhausted-badge')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('flag-cleared.png') })
    await openTab(page, team.root, 'tasks')
    await expect(exhaustedItems(page)).toHaveCount(0)
  } finally {
    await killSessions(page, made)
    rmSync(team.root, { recursive: true, force: true })
  }
})

test('6.1: lead mail to a spawned member is dead-lettered, the member archived, the lead noted, and the item resolves on a new dispatch', async ({ page }, info) => {
  const team = resultsTeam()
  const made: string[] = []
  try {
    await page.goto('/')
    const lead = await createChat(page, team.root, 'CE lead', 'leads')
    made.push(lead)
    const seeded = seedLeadDispatch(team.root, team.worktree, lead, 'Build the export prompt-too-long')
    // Rows seeded behind the server's back wait for a dispatch pass; a turn ending in the lead's chat wakes it.
    await say(page, lead, 'hello')
    await expect(page.getByTestId('chat-status')).toHaveText('waiting', { timeout: 15_000 })

    // The spawned member's turn fails; it is released (archived) at once.
    await expect.poll(() => spawnedIn(team.worktree)?.archivedAt ?? null, { timeout: 45_000 }).not.toBeNull()

    // The lead's decision note arrives as a peer turn.
    await page.locator(`[data-session-id="${lead}"]`).first().click()
    const note = page.locator('[data-chat-role="peer"]').filter({ hasText: '[context-exhausted]' })
    await expect(note).toHaveCount(1, { timeout: 30_000 })
    await expect(note).toContainText(`Dropped message: ${seeded.messageId}`)
    await expect(note).toContainText('blocking_limit')
    await page.screenshot({ path: info.outputPath('lead-note.png') })

    // The dead letter with its readable label.
    await openTab(page, team.root, 'mailbox')
    const dead = page.getByTestId('team-mailbox').locator(`[data-message-id="${seeded.messageId}"]`)
    await expect(dead).toContainText("The recipient's context was exhausted; the message was not processed")
    await page.screenshot({ path: info.outputPath('dead-letter.png') })

    // The agent-owned attention item, owned by the lead, opens the Mailbox row.
    await openTab(page, team.root, 'tasks')
    const item = exhaustedItems(page)
    await expect(item).toHaveCount(1)
    await expect(queue(page).getByTestId('attention-human').locator('[data-kind="context-exhausted"]')).toHaveCount(0)
    await expect(item).toContainText('context exhausted (blocking_limit)')
    await expect(item).toContainText('CE lead')
    await page.screenshot({ path: info.outputPath('waiting-on-lead-item.png') })

    // A new dispatch on the task resolves it.
    await reopenTask(page, seeded.taskId, team.root)
    // The seeded mail carried no assignment row, so no notify/stop choice is asked.
    const form = page.getByTestId('task-assign-form')
    await form.getByLabel('Assignment target kind').selectOption('group')
    await form.getByLabel('Assignment group').selectOption('devs')
    await form.getByLabel('Assignment instruction').fill('Continue the export from the worktree')
    await page.getByTestId('task-assign-send').click()
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs', { timeout: 20_000 })
    await expect(exhaustedItems(page)).toHaveCount(0, { timeout: 20_000 })
    await page.screenshot({ path: info.outputPath('item-resolved.png') })
  } finally {
    // The spawned member, archived or (after the new dispatch) a fresh one, goes too.
    made.push(...spawnedAll(team.worktree))
    await killSessions(page, made)
    rmSync(team.root, { recursive: true, force: true })
  }
})

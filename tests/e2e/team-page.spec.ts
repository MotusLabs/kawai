// E2E (team-workspace-pages 6.1, the part that ships before 5.5): a
// terminal-only repository's Team page — opened from the navigator's Team
// entry with no chat selected or even existing — loads its Mailbox; a search
// narrows the sections and an expanded row survives opening a chat and coming
// back through the browser's Back button (per-team view state, D8); a reload
// reopens the same tab from the URL (D3). The selected-task assertion of the
// full scenario, and row links into a task, join when the Tasks view lands.
// Runs its own isolated server (fresh DB, private tmux socket) so the
// navigator holds only this spec's sessions; written for CI, and locally only
// on a spare port — never run test:e2e against a live kawai.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

// Workspace discovery runs on its own cadence; the entry trails the session,
// and on hosts where fs.watch cannot be allocated it waits for the 30s
// reconciliation, so the timeout must cover a full cycle.
const SNAPSHOT_TIMEOUT = 45_000

/** A throwaway git repository — a real one, so the navigator lists its Team entry. */
function repositoryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-team-page-')))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Team Page E2E'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# team page fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}

/** The spec's own isolated server, so no other run's sessions pollute the navigator. */
function useIsolatedServer(root: string) {
  // Default to E2E_PORT + 100 so a run on the suite's own port family never
  // collides; KAWAI_TEAM_PAGE_PORT still overrides.
  const port = process.env.KAWAI_TEAM_PAGE_PORT || String((Number(process.env.E2E_PORT) || 4173) + 100)
  const url = `http://127.0.0.1:${port}`
  const dbPath = join(root, 'agentboard.db')
  let server: ChildProcess | null = null
  let diagnostics = ''
  const start = async (page: Page) => {
    // Same guard as playwright.config.ts's webServer command: the server pins
    // AGENTBOARD_STATIC_DIR, so a clean tree has to build before it can serve.
    if (!existsSync(join(process.cwd(), 'dist/client'))) {
      execFileSync('bun', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit' })
    }
    // The suite's global setup pre-creates the webServer's base tmux session
    // on the suite socket; this server has its own socket, so do the same
    // here — without a base session, UI-created terminals land in filtered
    // per-connection `-ws-` sessions and never enter discovery.
    execFileSync('tmux', ['new-session', '-d', '-s', 'kawai-team-page'], {
      env: { ...process.env, TMUX_TMPDIR: root, TMUX: '' },
    })
    server = spawn('bun', ['src/server/index.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '1',
        PORT: port, HOSTNAME: '127.0.0.1',
        AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'),
        AGENTBOARD_DB_PATH: dbPath, LOG_FILE: join(root, 'agentboard.log'),
        TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'kawai-team-page',
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
    return url
  }
  const stop = async () => {
    if (!server || server.exitCode !== null) return
    const stopped = new Promise<void>(resolve => server!.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await stopped
    server = null
  }
  return { start, stop, url: () => url, dbPath: () => dbPath, diagnostics: () => diagnostics }
}

/** Expand a Mailbox section — idempotent, since kept collapse state survives the open. */
async function expandSection(mailbox: ReturnType<Page['getByTestId']>, name: string) {
  const toggle = mailbox.getByTestId(`mailbox-section-toggle-${name}`)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

/**
 * Create the terminal-only repository's one session. The command is set to
 * `bash` explicitly: the dialog's default preset runs `claude`, which CI
 * never installs, and a tmux window whose command is missing dies at once —
 * the session never registers, the repository is never seeded, and no Team
 * entry can appear (PR #142's failure; `bash` exists everywhere and keeps
 * the pane alive).
 */
async function createTerminal(page: Page, root: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('terminal')
  await dialog.getByPlaceholder('Enter command...').fill('bash')
  const projectPath = dialog.getByLabel('Project Path')
  await projectPath.fill(root)
  // The dialog initializes its fields during the open render; guard the fill
  // the way chat-teams.spec does so a late reset cannot send the wrong path.
  await expect(projectPath).toHaveValue(root)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  // `terminal-panel` renders for the empty state too, so the real signal is
  // the session registering in the navigator under the repository's path.
  const row = page.locator('[data-session-id]').filter({ has: page.locator(`[title="${root}"]`) })
  await expect(row.first()).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })
}

test('a terminal-only repository opens its Team page; view state survives a chat visit and Back; a reload keeps the tab', async ({ page }, info) => {
  test.setTimeout(200_000)
  const root = repositoryRoot()
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\n---\nBuild features')
  const isolated = useIsolatedServer(root)
  try {
    await isolated.start(page)
    await page.goto(isolated.url())
    await createTerminal(page, root)

    // One Team entry per repository, above the sections; with no chat in the
    // repository it still opens the page (team-workspace D10/E14).
    const entry = page.locator(`[data-testid="team-entry"][data-team-key="${root}"]`)
    await expect(entry).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })
    await entry.click()
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    // Tasks is the first-open tab; its view is empty until 5.5 lands.
    await expect(page.getByTestId('team-tab-body-tasks')).toBeVisible()
    await page.getByTestId('team-tab-mailbox').click()
    const mailbox = page.getByTestId('team-mailbox')
    await expect(mailbox).toBeVisible()

    // Seed three rows directly; a reload re-subscribes and shows them. The
    // queued group mail stays queued: the group exists but has no members.
    const dbPath = isolated.dbPath()
    if (!dbPath.startsWith(root)) throw new Error('Refuse seeding a non-isolated database')
    // The team of a git repository is its common dir (<root>/.git); a plain
    // directory would be the path itself, which is why the other specs seed
    // with the bare root.
    const team = join(root, '.git')
    const seeded = JSON.parse(execFileSync('bun', ['-e', `
      import { Database } from 'bun:sqlite';
      import { MailboxStore } from './src/server/team/mailboxStore';
      const [file, team] = JSON.parse(await Bun.stdin.text());
      const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000'); const store = new MailboxStore(db);
      const base = { teamId: team, fromSession: 'chat-lead', fromGroup: 'leads', originPath: team };
      const alpha = store.enqueue({ ...base, toKind: 'group', toId: 'devs', body: 'Alpha queued browser work' });
      const beta = store.enqueue({ ...base, toKind: 'group', toId: 'devs', body: 'Beta queued browser work' });
      const until = new Date(Date.now() + 3600000).toISOString();
      const later = store.enqueue({ ...base, toKind: 'group', toId: 'devs', body: 'Scheduled browser work', deliverAt: until });
      console.log(JSON.stringify({ alpha: alpha.id, beta: beta.id, later: later.id })); db.close();
    `], { cwd: process.cwd(), input: JSON.stringify([dbPath, team]), encoding: 'utf8' })) as { alpha: string; beta: string; later: string }
    await page.reload()
    await expect(mailbox.getByTestId('mailbox-section-toggle-Queued')).toBeVisible({ timeout: 10_000 })
    await expect(mailbox.getByTestId('mailbox-section-count-Queued')).toHaveText('2 messages')
    await expandSection(mailbox, 'Scheduled')
    await expect(mailbox.getByTestId('mailbox-section-count-Scheduled')).toHaveText('1 message')

    // Search narrows every section and each count reflects the match (D6).
    await mailbox.getByLabel('Search mailbox').fill('Alpha queued')
    await expect(mailbox.getByTestId('mailbox-section-count-Queued')).toHaveText('1 message')
    await expect(mailbox.getByTestId('mailbox-section-count-Scheduled')).toHaveText('0 messages')
    await expandSection(mailbox, 'Queued')
    const alpha = mailbox.locator(`[data-message-id="${seeded.alpha}"]`)
    await alpha.getByTestId('mailbox-row-toggle').click()
    await expect(alpha).toHaveAttribute('data-expanded', 'true')
    await page.screenshot({ path: info.outputPath('team-page-searched.png') })

    // Open a chat in the repository: creation selects it, the pane leaves the
    // Team page (a selection act, D3)…
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Project Path').fill(root)
    await dialog.getByLabel('Display Name').fill('Team page chatter')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-view')).toContainText('Team page chatter')

    // …and Back returns to the Team page with the same search and the same
    // row expanded (per-team view state, D8).
    await page.goBack()
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    await expect(page.getByTestId('team-mailbox').getByLabel('Search mailbox')).toHaveValue('Alpha queued')
    const kept = page.getByTestId('team-mailbox').locator(`[data-message-id="${seeded.alpha}"]`)
    await expect(kept).toHaveAttribute('data-expanded', 'true')
    await page.screenshot({ path: info.outputPath('team-page-back.png') })

    // A reload reopens the same tab from the URL; the kept view state is
    // memory only, so the search starts clean again (D3/D8).
    await page.reload()
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    await expect(page.getByTestId('team-tab-body-mailbox')).toBeVisible()
    await expect(page.getByTestId('team-mailbox').getByLabel('Search mailbox')).toHaveValue('')
    await page.screenshot({ path: info.outputPath('team-page-reloaded.png') })

    // The selected task rides the URL too (5.5): create one, let its detail
    // open, and a reload restores the same selection.
    await page.getByTestId('team-tab-tasks').click()
    const tasks = page.getByTestId('team-tasks')
    await tasks.locator('summary', { hasText: 'New task' }).click()
    await tasks.getByLabel('Task title').fill('Team page probe')
    await tasks.getByLabel('Task direction').fill('Check the URL selection')
    await tasks.getByTestId('task-create-button').click()
    const detail = page.getByTestId('task-detail')
    await expect(detail).toContainText('Team page probe', { timeout: 15_000 })
    const taskId = (await detail.getAttribute('data-task-id'))!
    await page.reload()
    await expect(page.getByTestId('team-workspace')).toBeVisible()
    await expect(page.getByTestId('task-detail')).toHaveAttribute('data-task-id', taskId)
    await page.screenshot({ path: info.outputPath('team-page-task-restored.png') })
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- server ---\n${isolated.diagnostics()}`)
  } finally {
    await isolated.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

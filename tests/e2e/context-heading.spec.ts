// E2E (chat-context-name 2.3, contract A4): the navigator heading names the
// selected session's repository and, for a name wider than the navigator,
// truncates on one line without widening it, while hovering still shows the
// server version. The browser title carries the same name. Runs its own
// isolated server (fresh DB, private tmux socket, stopped through the shared
// bounded sequence) so the navigator holds only this spec's session; never
// run test:e2e against a live kawai.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ServerProcess } from './fixtures/serverProcess'

// Workspace discovery trails the session; on hosts without fs.watch it waits
// for the 30 s reconciliation, so the timeout covers a full cycle.
const SNAPSHOT_TIMEOUT = 45_000
const LONG_NAME = 'context-heading-a-repository-name-long-enough-to-overflow-the-navigator'

/**
 * A short state directory (the tmux socket path must stay under the Unix
 * socket length limit) holding a throwaway git repository whose main
 * checkout — hence its repository name — is LONG_NAME.
 */
function repositoryRoot() {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-ctxh-')))
  const root = join(state, LONG_NAME)
  mkdirSync(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Context Heading E2E'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# context heading fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return { state, root }
}

function useIsolatedServer(state: string) {
  const port = process.env.KAWAI_CONTEXT_HEADING_PORT || String((Number(process.env.E2E_PORT) || 4173) + 110)
  const url = `http://127.0.0.1:${port}`
  const proc = new ServerProcess()
  const start = async (page: Page) => {
    if (!existsSync(join(process.cwd(), 'dist/client'))) {
      execFileSync('bun', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit' })
    }
    // A base session on the private socket, so the UI-created terminal
    // enters discovery (see team-page.spec.ts).
    execFileSync('tmux', ['new-session', '-d', '-s', 'kawai-context-heading'], {
      env: { ...process.env, TMUX_TMPDIR: state, TMUX: '' },
    })
    proc.spawn('bun', ['src/server/index.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: port, HOSTNAME: '127.0.0.1',
        AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'),
        AGENTBOARD_DB_PATH: join(state, 'agentboard.db'), LOG_FILE: join(state, 'agentboard.log'),
        TMUX_TMPDIR: state, TMUX: '', TMUX_SESSION: 'kawai-context-heading',
        AGENTBOARD_TMUX_PID_FILE: join(state, 'tmux.pid'),
        CLAUDE_CONFIG_DIR: join(state, 'claude'), CODEX_HOME: join(state, 'codex'), PI_HOME: join(state, 'pi'),
        AGENTBOARD_REMOTE_HOSTS: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
      },
    })
    await expect.poll(async () => {
      try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false }
    }, { timeout: 30_000 }).toBe(true)
    return url
  }
  return { start, stop: () => proc.stop({ tmuxRoot: state }), url: () => url, diagnostics: () => proc.diagnostics() }
}

/** A `bash` terminal in the repository (the default `claude` preset is absent on CI). */
async function createTerminal(page: Page, root: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('terminal')
  await dialog.getByPlaceholder('Enter command...').fill('bash')
  const projectPath = dialog.getByLabel('Project Path')
  await projectPath.fill(root)
  await expect(projectPath).toHaveValue(root)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const row = page.locator('[data-session-id]').filter({ has: page.locator(`[title="${root}"]`) })
  await expect(row.first()).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })
  return row.first()
}

// @covers: workspace-navigation › The navigator heading shows the context name › A long name keeps the navigator width
test('a long repository name truncates the heading on one line and keeps the navigator width', async ({ page }, info) => {
  test.setTimeout(150_000)
  const { state, root } = repositoryRoot()
  const name = basename(root)
  const isolated = useIsolatedServer(state)
  try {
    await isolated.start(page)
    await page.goto(isolated.url())
    const navigator = page.locator('header').first()
    const heading = page.getByTestId('context-heading')
    await expect(heading).toBeVisible()
    const widthBefore = (await navigator.boundingBox())!.width
    const lineHeight = (await heading.boundingBox())!.height

    const row = await createTerminal(page, root)
    await row.click()
    // The heading names the repository once discovery reports it.
    await expect(heading).toHaveText(name, { timeout: SNAPSHOT_TIMEOUT })
    await expect(page).toHaveTitle(`${name} - Kawai`)

    // One line, cut short, navigator unchanged.
    const box = (await heading.boundingBox())!
    expect(box.height).toBeLessThanOrEqual(lineHeight + 1)
    expect(await heading.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    expect(await heading.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis')
    expect((await navigator.boundingBox())!.width).toBe(widthBefore)

    // Hover keeps the version tooltip.
    const info2 = await (await page.request.get(`${isolated.url()}/api/server-info`)).json() as { version?: string }
    expect(info2.version).toBeTruthy()
    await expect(heading).toHaveAttribute('title', `Kawai v${info2.version}`)
    await page.screenshot({ path: info.outputPath('context-heading-truncated.png') })
  } catch (error) {
    console.error(isolated.diagnostics())
    throw error
  } finally {
    await isolated.stop()
    rmSync(state, { recursive: true, force: true })
  }
})

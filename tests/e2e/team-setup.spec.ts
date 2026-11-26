// The Set up team walkthrough (starter-team-setup 5.3; starter-setup-with-
// user-level-groups 3.1), on the CI development-fixture path. The spec owns
// its app — a fresh temporary HOME, a repository it creates, a database, a
// private tmux socket and a port of its own — so nothing here reads the
// developer's home or data, and the suite's shared server is left alone.
// Under a HOME with no user-level groups, a repository kawai has never seen
// opens the New Session dialog's missing-groups notice; its link closes the
// dialog and opens the team's Members tab. A user-level group file written
// under that HOME then becomes a picker option and hides the notice while Set
// up team stays offered; the preview warns that lead.md replaces that file,
// Confirm stays usable, and the write leaves the three starter groups as
// untracked files equal to the templates, the user-level file as it was. No
// chat is created. Run locally only on a spare E2E_PORT with CI=1, after
// `bun run build`.
// @reads: config/groups/**
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from '../../src/server/git/gitCommand'
import { ServerProcess } from './fixtures/serverProcess'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development fixture')

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// @covers: team-setup › The New Session dialog points a team without groups to setup › The link opens the Members tab
// @covers: team-setup › The New Session dialog points a team without groups to setup › User-level groups hide the notice
// @covers: team-setup › The setup preview names the user-level groups it would replace › A starter group that replaces a user-level group is warned
// @covers: team-setup › Set-up groups are editable files the Members tab names › Rows name the written files
// @covers: team-setup › Confirming writes the starter group files › Nothing is committed
test('from the New Session notice to the Members tab, Set up team writes the three starter groups', async ({ page }, info) => {
  // The app's HOME and the repository are separate trees: the user-level group
  // file must lie outside the repository whose team the walkthrough sets up.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-team-setup-')))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const userLead = join(home, '.kawai', 'groups', 'lead.md')
  for (const dir of [home, repo, join(root, 'claude'), join(root, 'codex'), join(root, 'pi')]) mkdirSync(dir)
  // E2E_PORT + 220: never the suite's shared server, nor a port another spec's server takes.
  const port = Number(process.env.KAWAI_TEAM_SETUP_PORT ?? (Number(process.env.E2E_PORT || 4173) + 220))
  const url = `http://127.0.0.1:${port}`
  const server = new ServerProcess()
  const env = { ...process.env, HOME: home, TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'team-setup',
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '1', AGENTBOARD_DB_PATH: join(root, 'agentboard.db'),
    LOG_FILE: join(root, 'agentboard.log'), AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', AGENTBOARD_REMOTE_HOSTS: '',
    AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'), PORT: String(port), HOSTNAME: '127.0.0.1' }
  try {
    git(['init', '-q'], repo)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
    const head = git(['rev-parse', 'HEAD'], repo).trim()
    server.spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    await expect.poll(async () => { try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false } }, { timeout: 30_000 }).toBe(true)

    await page.goto(url)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    const group = dialog.getByLabel('Group', { exact: true })
    const projectPath = dialog.getByLabel('Project Path')
    await projectPath.fill(repo)
    // The dialog initializes its fields during the open render; a late reset must not send another path.
    await expect(projectPath).toHaveValue(repo)
    // No group anywhere: the picker offers "No group" alone, and the notice shows.
    await expect(group.locator('option')).toHaveText(['No group'])
    await expect(dialog.getByTestId('missing-groups-notice')).toBeVisible()
    await page.screenshot({ path: info.outputPath('new-session-notice.png') })
    await dialog.getByTestId('missing-groups-link').click()
    await expect(dialog).toHaveCount(0)

    // The path was undiscovered: the page turns known once discovery answers.
    const workspace = page.getByTestId('team-workspace')
    await expect(workspace).toHaveAttribute('data-team-key', repo)
    await expect(page).toHaveURL(/\/members$/)

    // A user-level group appears under the app's HOME; the reload reopens the Members tab over it.
    const userBytes = '---\nlabel: Home Lead\ndescription: Plans from the user level.\n---\nPlan the work.'
    mkdirSync(join(home, '.kawai', 'groups'), { recursive: true })
    writeFileSync(userLead, userBytes)
    await page.reload()
    const leadRow = page.locator('[data-testid="member-group"][data-group-id="lead"]')
    await expect(leadRow.getByTestId('member-sources')).toContainText(`${userLead} · user file · in effect`)
    // A user-level group never withdraws the offer: only project group files do.
    const setupOpen = page.getByTestId('team-setup-open')
    await expect(setupOpen).toBeVisible()

    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await projectPath.fill(repo)
    // The user-level group is the picker's option, and with a group to choose the notice is gone.
    await expect(group.locator('option')).toHaveText(['No group', 'Home Lead'])
    await expect(dialog.getByTestId('missing-groups-notice')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('new-session-user-group.png') })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await expect(setupOpen).toBeVisible()
    await setupOpen.click()
    const preview = page.getByTestId('team-setup-preview')
    await expect(preview.getByTestId('team-setup-target')).toHaveText(join(repo, '.kawai', 'groups'))
    await expect(preview.getByTestId('team-setup-group')).toHaveCount(3)
    await expect(preview.locator('[data-group-id="reviewers"]')).toContainText('cross-model review')
    // Before any write: one warning names the user-level file and the project file that replaces it.
    const warning = `lead.md replaces ${userLead} for this project.`
    await expect(preview.getByTestId('team-setup-warnings').locator('li', { hasText: 'replaces' })).toHaveText([`Warning: ${warning}`])
    await expect(page.getByTestId('team-setup-confirm')).toBeEnabled()
    await page.screenshot({ path: info.outputPath('setup-preview.png') })
    await page.getByTestId('team-setup-confirm').click()

    await expect(page.getByTestId('team-setup-result')).toContainText('Created lead.md, devs.md, reviewers.md.')
    await expect(page.getByTestId('team-setup-open')).toHaveCount(0)
    for (const id of ['lead', 'devs', 'reviewers']) {
      const row = page.locator(`[data-testid="member-group"][data-group-id="${id}"]`)
      await expect(row.getByTestId('member-sources')).toContainText(join(repo, '.kawai', 'groups', `${id}.md`))
      const file = join(repo, '.kawai', 'groups', `${id}.md`)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(readFileSync(join(process.cwd(), 'config', 'groups', `${id}.md`), 'utf8'))
    }
    // The project file has the effect now; the user-level file is still there, as it was.
    await expect(leadRow.getByTestId('member-sources')).toContainText(`${userLead} · user file · overridden`)
    expect(readFileSync(userLead, 'utf8')).toBe(userBytes)
    await page.screenshot({ path: info.outputPath('members-after-setup.png'), fullPage: true })
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head)
    expect(git(['status', '--porcelain', '--untracked-files=all'], repo).split('\n').filter(Boolean).sort())
      .toEqual(['?? .kawai/groups/devs.md', '?? .kawai/groups/lead.md', '?? .kawai/groups/reviewers.md'])
  } finally {
    // The app's last output stays with the result, since the root that holds its log goes next.
    try {
      await info.attach('owned-app-output', { body: server.diagnostics(), contentType: 'text/plain' })
    } finally {
      await server.stop({ tmuxRoot: root })
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// The Set up team walkthrough (starter-team-setup 5.3): a repository kawai
// has never seen opens the New Session dialog's missing-groups notice; its
// link closes the dialog and opens the team's Members tab, which offers Set
// up team; the preview names the three starter groups, Confirm writes them,
// and the tab lists lead, devs, and reviewers, each naming its file in the
// main checkout — untracked, nothing staged or committed. No chat is created,
// so it runs with or without the chat fixture. Run locally only on a spare
// E2E_PORT with CI=1, after `bun run build`.
// @reads: config/groups/**
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from '../../src/server/git/gitCommand'

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// @covers: team-setup › The New Session dialog points a team without groups to setup › The link opens the Members tab
// @covers: team-setup › Set-up groups are editable files the Members tab names › Rows name the written files
// @covers: team-setup › Confirming writes the starter group files › Nothing is committed
test('from the New Session notice to the Members tab, Set up team writes the three starter groups', async ({ page }, info) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-team-setup-')))
  try {
    git(['init', '-q'], root)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], root)
    const head = git(['rev-parse', 'HEAD'], root).trim()

    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Project Path').fill(root)
    await expect(dialog.getByTestId('missing-groups-notice')).toBeVisible()
    await page.screenshot({ path: info.outputPath('new-session-notice.png') })
    await dialog.getByTestId('missing-groups-link').click()
    await expect(dialog).toHaveCount(0)

    // The path was undiscovered: the page turns known once discovery answers.
    const workspace = page.getByTestId('team-workspace')
    await expect(workspace).toHaveAttribute('data-team-key', root)
    await expect(page).toHaveURL(/\/members$/)
    await page.getByTestId('team-setup-open').click()
    const preview = page.getByTestId('team-setup-preview')
    await expect(preview.getByTestId('team-setup-target')).toHaveText(join(root, '.kawai', 'groups'))
    await expect(preview.getByTestId('team-setup-group')).toHaveCount(3)
    await expect(preview.locator('[data-group-id="reviewers"]')).toContainText('cross-model review')
    await page.screenshot({ path: info.outputPath('setup-preview.png') })
    await page.getByTestId('team-setup-confirm').click()

    await expect(page.getByTestId('team-setup-result')).toContainText('Created lead.md, devs.md, reviewers.md.')
    await expect(page.getByTestId('team-setup-open')).toHaveCount(0)
    for (const id of ['lead', 'devs', 'reviewers']) {
      const row = page.locator(`[data-testid="member-group"][data-group-id="${id}"]`)
      await expect(row.getByTestId('member-sources')).toContainText(join(root, '.kawai', 'groups', `${id}.md`))
      const file = join(root, '.kawai', 'groups', `${id}.md`)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(readFileSync(join(process.cwd(), 'config', 'groups', `${id}.md`), 'utf8'))
    }
    await page.screenshot({ path: info.outputPath('members-after-setup.png'), fullPage: true })
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(head)
    expect(git(['status', '--porcelain', '--untracked-files=all'], root).split('\n').filter(Boolean).sort())
      .toEqual(['?? .kawai/groups/devs.md', '?? .kawai/groups/lead.md', '?? .kawai/groups/reviewers.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

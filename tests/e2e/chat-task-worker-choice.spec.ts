// Browser walkthrough of the human worker choice against the SDK-free fixture
// (dispatch-worker-choice 4.3/5.1): the New task form's worker picker lists
// the group's workers by provider, the dispatch preview names the choice, and
// a create-and-assign on Z.AI spawns its member on GLM Flash in the task's
// worktree although the group prefers Claude. Once that provider cools (the
// fixture's `rate-limit` turn records a final 429), the picker shows the
// cooldown and the next task chosen on it waits in the Mailbox with a reason
// naming the choice and its retry time — never spawned on Claude instead.
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from '../../src/server/git/gitCommand'
import { createChat, openTeamView, say, spawnedSession } from './support/taskResults'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A repository with two linked worktrees and a devs group preferring Claude over Z.AI. */
function teamRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-worker-choice-')))
  mkdirSync(join(root, '.kawai/groups'), { recursive: true })
  writeFileSync(join(root, '.kawai/groups/leads.md'), '---\nlabel: Team leads\n---\nCoordinate work')
  writeFileSync(join(root, '.kawai/groups/devs.md'), '---\nlabel: Developers\nprofiles: [sonnet, glm-flash]\nmax: 4\n---\nBuild features')
  git(['init', '-q', root])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], root)
  for (const branch of ['feat-export', 'feat-import']) git(['worktree', 'add', '-q', '-b', branch, join(root, `.wt-${branch}`)], root)
  return root
}

test('a worker chosen in the New task form spawns on that provider; a cooling choice waits in the Mailbox with its reason', async ({ page }, info) => {
  const root = teamRoot()
  const exportRoot = join(root, '.wt-feat-export')
  const importRoot = join(root, '.wt-feat-import')
  try {
    await page.goto('/')
    const lead = await createChat(page, root, 'Browser team lead', 'leads')
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTeamView(page, 'tasks')
    const panel = page.getByTestId('team-tasks')

    const newTask = async (title: string, worktree: string, instruction: string) => {
      const back = panel.getByRole('button', { name: 'All tasks' })
      if (await back.isVisible().catch(() => false)) await back.click()
      await panel.locator('summary', { hasText: 'New task' }).click()
      await panel.getByLabel('Task title').fill(title)
      await panel.getByLabel('Task direction').fill(`Implement ${title}`)
      await panel.getByLabel('Target worktree').fill(worktree)
      await panel.getByLabel('Assignment target kind').selectOption('group')
      await panel.getByLabel('Assignment group').selectOption('devs')
      await panel.getByLabel('Assignment instruction').fill(instruction)
    }

    // The picker shows for the group target: its workers by provider, with usage.
    await newTask('Export CSV', exportRoot, 'Build the export')
    const picker = panel.getByTestId('task-assign-worker')
    await expect(picker.getByTestId('task-assign-worker-provider-claude')).toContainText('Claude')
    await expect(picker.getByTestId('task-assign-worker-provider-zai')).toContainText('Z.AI')
    await picker.getByLabel('Assignment worker').selectOption('zai')
    // The preview names the choice.
    await panel.getByTestId('task-assign-preview-button').click()
    await expect(panel.getByTestId('task-preview-worker')).toContainText('zai', { timeout: 15_000 })
    await page.screenshot({ path: info.outputPath('01-worker-picker-and-preview.png'), fullPage: true })
    await panel.getByTestId('task-create-assign-button').click()
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs', { timeout: 20_000 })

    // The member spawns on Z.AI's model in the task's worktree.
    const member = await spawnedSession(page, exportRoot)
    await page.locator(`[data-session-id="${member}"]`).click()
    await expect(page.getByTestId('chat-view')).toContainText('GLM Flash', { timeout: 15_000 })
    await expect(page.locator('[data-chat-role="peer"]').filter({ hasText: 'Build the export' }).first()).toBeVisible({ timeout: 20_000 })
    await page.screenshot({ path: info.outputPath('02-member-spawned-on-zai.png') })

    // Z.AI cools: the member's next turn ends on a final 429.
    await say(page, member, 'rate-limit')
    await expect(page.getByTestId('chat-view')).toContainText('API Error: 429', { timeout: 15_000 })

    // The picker now reads the provider's cooldown; the next task chooses it anyway.
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTeamView(page, 'tasks')
    await newTask('Import CSV', importRoot, 'Build the import')
    await expect(picker.getByTestId('task-assign-worker-provider-zai')).toContainText('cooling until', { timeout: 15_000 })
    await picker.getByLabel('Assignment worker').selectOption('zai')
    await page.screenshot({ path: info.outputPath('03-picker-shows-cooldown.png'), fullPage: true })
    await panel.getByTestId('task-create-assign-button').click()
    await expect(page.getByTestId('task-outstanding-assignment')).toContainText('group devs', { timeout: 20_000 })

    // The Mailbox row waits on the choice with its retry time.
    await page.getByTestId('team-tab-mailbox').click()
    const mailbox = page.getByTestId('team-mailbox')
    await mailbox.getByTestId('mailbox-section-toggle-Queued').click()
    const row = mailbox.locator('[data-message-id]').filter({ hasText: 'Build the import' }).first()
    await row.getByTestId('mailbox-row-toggle').click()
    await expect(row.getByTestId('waiting-reason')).toContainText(/Waiting for the chosen worker zai \(cooling until .+\)/, { timeout: 15_000 })
    await page.screenshot({ path: info.outputPath('04-mailbox-row-waits-on-choice.png'), fullPage: true })
    await row.screenshot({ path: info.outputPath('05-mailbox-row-reason.png') })
    // Never routed elsewhere: this team's only spawned session is still the Z.AI
    // member — scoped to the team's checkouts, since earlier specs on the same
    // server leave spawned sessions of their own teams in the navigator.
    const ours = page.locator('[data-session-id^="chat-"]').filter({ has: page.getByTestId('session-spawned-badge') })
      .filter({ has: page.locator([root, exportRoot, importRoot].map(path => `[title="${path}"]`).join(', ')) })
    await expect(ours).toHaveCount(1)
    await expect(ours).toHaveAttribute('data-session-id', member)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

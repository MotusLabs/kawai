// The unified approval default walkthrough against the SDK-free fixture
// (unify-approval-defaults 5.3): the Members tab names a group whose
// `approval: auto` has no effect until the team default is auto; the New
// Session dialog then seeds Auto-approve from that team default and captions
// its source, a teamless path seeds manual, and Settings → Chat has no
// approval control. Written for CI; run locally only on a spare E2E_PORT
// after `bun run build`.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChat, resultsTeam } from './support/taskResults'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function openTab(page: Page, teamKey: string, tab: string) {
  await page.evaluate(([key, name]) => { window.location.hash = `#/team/${encodeURIComponent(key!)}/${name}` }, [teamKey, tab])
  await expect(page.getByTestId('team-workspace')).toHaveAttribute('data-team-key', teamKey)
}

async function openNewSession(page: Page, projectPath: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Project Path').fill(projectPath)
  return dialog
}

// @covers: team-workspace › The Members tab sets the team's default approval policy › Groups asking for auto are named next to the control
// @covers: chat-sessions › New chats start from their team's default approval policy › Team default seeds new chats
test('a group asking for auto is named until the team default is auto, which then seeds new chats', async ({ page }, info) => {
  const team = resultsTeam()
  writeFileSync(join(team.root, '.kawai/groups/reviewers.md'), '---\nlabel: Reviewers\nmax: 3\napproval: auto\n---\nReview results')
  const teamless = realpathSync(mkdtempSync(join(tmpdir(), 'kawai-teamless-')))
  try {
    await page.goto('/')
    await createChat(page, team.root, 'Unified approval lead', 'leads')

    // Members: the ignored key is named next to the control and on the row.
    await openTab(page, team.root, 'members')
    const notice = page.getByTestId('team-approval-default-auto-requested')
    await expect(notice).toContainText('reviewers')
    await expect(notice).toContainText('for auto; set the default to auto to grant it.')
    const reviewers = page.locator('[data-testid="member-group"][data-group-id="reviewers"]')
    await expect(reviewers.getByTestId('member-approval')).toHaveText('manual · built-in')
    await expect(reviewers).toContainText('approval: auto has no effect')
    await page.screenshot({ path: info.outputPath('1-members-auto-requested.png') })

    await page.getByTestId('team-approval-default-auto').click()
    await expect(page.getByTestId('team-approval-default-value')).toHaveText('Set to auto-approve.')
    await expect(notice).toHaveCount(0)
    await expect(reviewers.getByTestId('member-approval')).toHaveText('auto · team default')
    await page.screenshot({ path: info.outputPath('2-members-default-auto.png') })

    // New Session in the team: checked, captioned with the team default.
    const dialog = await openNewSession(page, team.root)
    await expect(dialog.getByTestId('chat-auto-approve-source')).toHaveText('Team default: auto.')
    await expect(dialog.getByLabel('Auto-approve tools')).toBeChecked()
    await page.screenshot({ path: info.outputPath('3-new-session-team-auto.png') })

    // A teamless path re-seeds the untouched checkbox to manual.
    await dialog.getByLabel('Project Path').fill(teamless)
    await expect(dialog.getByTestId('chat-auto-approve-source')).toHaveText('No team default applies: starts on manual.')
    await expect(dialog.getByLabel('Auto-approve tools')).not.toBeChecked()
    await page.screenshot({ path: info.outputPath('4-new-session-teamless.png') })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Settings → Chat points to the Members tab and has no approval control.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Chat' }).click()
    const chatPanel = page.getByRole('tabpanel', { name: 'Chat' })
    await expect(chatPanel.getByTestId('default-approval-policy-hint')).toContainText("Team page's Members tab")
    await expect(chatPanel.getByRole('radio', { name: 'Auto-approve', exact: true })).toHaveCount(0)
    await page.waitForTimeout(250)
    await page.screenshot({ path: info.outputPath('5-settings-chat.png') })
  } finally {
    rmSync(team.root, { recursive: true, force: true })
    rmSync(teamless, { recursive: true, force: true })
  }
})

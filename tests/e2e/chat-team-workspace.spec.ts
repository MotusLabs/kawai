// Team workspace walkthroughs against the SDK-free fixture (team-workspace
// 9.1–9.3, 11.3): E05 an approval is a human-required attention item whose
// link opens the chat's card, urgent direct mail waits on the approval and
// follows it, urgent group mail leaves a busy agent alone; E13 the morning
// summary buckets, converging counts, and no duplicate toast; E14 a narrow
// viewport's list/detail/Back, keyboard-only handling with focus restored,
// and a second repository's isolated team. Fixture agents cannot call MCP
// tools, so rows they would write are seeded with the server's own stores.
// Written for CI; run locally only on a spare E2E_PORT after `bun run build`.
import { expect, test, type Page } from '@playwright/test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChat, createTask, openTaskId, resultsTeam, say, seedResult, spawnedSession } from './support/taskResults'
import { discardMail, seedMail } from './support/workspaceSeed'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')
test.describe.configure({ mode: 'serial' })

const queue = (page: Page) => page.getByTestId('team-attention-queue')
const allow = (page: Page) => page.getByRole('button', { name: 'Allow', exact: true })
/** Open a team's tab through its URL (the Team page replaces the chat pane). */
async function openTab(page: Page, teamKey: string, tab: string) {
  await page.evaluate(([key, name]) => { window.location.hash = `#/team/${encodeURIComponent(key!)}/${name}` }, [teamKey, tab])
  await expect(page.getByTestId('team-workspace')).toHaveAttribute('data-team-key', teamKey)
}

const peers = (page: Page) => page.locator('[data-chat-role="peer"]')

/** A repository team with a lead chat and a developer spawned by an assigned task in its worktree. */
async function teamWithSpawnedDev(page: Page, title: string) {
  const team = resultsTeam()
  await page.goto('/')
  const lead = await createChat(page, team.root, `WS lead ${title}`, 'leads')
  await openTab(page, team.root, 'tasks')
  await createTask(page, { title, direction: 'Export rows', worktree: team.worktree, assign: 'devs' })
  const dev = await spawnedSession(page, team.worktree)
  return { ...team, lead, dev }
}

test('E05: an approval is a human-required item linking to its card; urgent mail waits for it; urgent group mail waits for idle', async ({ page }, info) => {
  const team = await teamWithSpawnedDev(page, 'WS approval')
  try {
    await say(page, team.dev, 'approval')
    await expect(allow(page)).toBeVisible()
    await openTab(page, team.root, 'tasks')
    const item = queue(page).getByTestId('attention-human').locator('[data-kind="approval"]')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('Approval requested: Bash')
    await page.screenshot({ path: info.outputPath('workspace-approval-item.png') })
    // The link opens the chat whose card is waiting.
    await item.getByTestId('attention-action').click()
    await expect(allow(page)).toBeVisible()
    // Urgent direct mail reports its wait on the pending card…
    seedMail({ root: team.root, fromSession: team.lead, fromGroup: 'leads', body: 'Urgent direct note', toKind: 'session', toId: team.dev, priority: 'urgent' })
    // Rows seeded behind the server's back wait for a dispatch pass; a turn ending in the lead's chat is the wake-up.
    await say(page, team.lead, 'hello')
    await expect(page.getByTestId('chat-transcript')).toContainText('Fixture response')
    await openTab(page, team.root, 'mailbox')
    await page.getByTestId('mailbox-section-toggle-Queued').click()
    await expect(page.getByTestId('team-mailbox')).toContainText('awaiting an approval or answer')
    // …and is delivered only after the approval resolves.
    await page.locator(`[data-session-id="${team.dev}"]`).click()
    await expect(peers(page).filter({ hasText: 'Urgent direct note' })).toHaveCount(0)
    await allow(page).click()
    await expect(peers(page).filter({ hasText: 'Urgent direct note' })).toHaveCount(1, { timeout: 30_000 })
    // Urgent group mail does not interrupt a busy agent: it waits for idle.
    await page.getByLabel('Message Claude').fill('thinking')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    seedMail({ root: team.root, fromSession: team.lead, fromGroup: 'leads', body: 'Urgent group note', toKind: 'group', toId: 'devs', priority: 'urgent' })
    await expect(peers(page).filter({ hasText: 'Urgent group note' })).toHaveCount(0)
    await expect(peers(page).filter({ hasText: 'Urgent group note' })).toHaveCount(1, { timeout: 30_000 })
  } finally { rmSync(team.root, { recursive: true, force: true }) }
})

test('E13 + Phase 2: the morning summary fills each bucket, an accepted result is counted once, and a reload converges with no toast', async ({ page }, info) => {
  const team = resultsTeam()
  writeFileSync(join(team.root, '.kawai/groups/solo.md'), '---\nlabel: Solo\nmax: 1\n---\nOne at a time')
  try {
    await page.goto('/')
    const lead = await createChat(page, team.root, 'WS lead summary', 'leads')
    await createChat(page, team.root, 'WS solo member', 'solo')
    await openTab(page, team.root, 'tasks')
    // A task dispatched to the full Solo group waits on its cap.
    await createTask(page, { title: 'WS cap wait', direction: 'Wait for a slot', worktree: team.worktree, assign: 'solo' })
    // A task whose developer finishes a turn without submitting a result.
    await createTask(page, { title: 'WS summary', direction: 'Export rows', worktree: team.worktree, assign: 'devs' })
    const taskId = await openTaskId(page)
    const dev = await spawnedSession(page, team.worktree)
    await expect(page.locator(`[data-session-id="${dev}"]`)).toBeVisible()
    // An open approval, an uncertain delivery, and a submitted (unaccepted) result.
    await say(page, dev, 'approval')
    await expect(allow(page)).toBeVisible()
    seedMail({ root: team.root, fromSession: lead, fromGroup: 'leads', body: 'Held for review', toKind: 'session', toId: dev, uncertainFor: dev })
    // Submitted by another session, so the developer's own finished turn stays result-less.
    const resultId = seedResult(taskId, lead, team.worktree)
    await say(page, lead, 'hello')
    await expect(page.getByTestId('chat-transcript')).toContainText('Fixture response')
    await openTab(page, team.root, 'tasks')
    await page.getByTestId('band-toggle-summary').click()
    const bucket = (name: string) => page.locator(`[data-testid="summary-bucket"][data-bucket="${name}"]`)
    await expect(bucket('Completed results')).toContainText('awaiting acceptance')
    await expect(bucket('Capacity waits')).toContainText('at capacity')
    await expect(bucket('Capacity waits').getByTestId('summary-runtime-only')).toContainText('Runtime only')
    await expect(bucket('Approvals').getByTestId('summary-item')).toHaveCount(1)
    // The fixture writes no CLI transcript, so its own delivered mail also lands uncertain.
    await expect(bucket('Uncertain deliveries').getByTestId('summary-item').first()).toContainText('Delivery uncertain')
    await expect(bucket('Finished turns without a result')).toContainText('finished with no result')
    // A finished turn is never a completion: the result belongs to the other bucket.
    await expect(bucket('Completed results').getByTestId('summary-item')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('workspace-summary.png') })
    // Phase 2: the unaccepted result is a stage and a human-required item.
    const row = page.locator(`[data-task-id="${taskId}"]`)
    await expect(row.getByTestId('task-stage')).toHaveText('Awaiting acceptance')
    const pending = queue(page).locator(`[data-item-id="pending-acceptance:${resultId}"]`)
    await expect(pending).toBeVisible()
    await pending.getByTestId('attention-action').click()
    await expect(page.getByTestId('task-detail')).toHaveAttribute('data-task-id', taskId)
    await page.getByTestId('task-accept').click()
    await page.getByTestId('task-accept-confirm-button').click()
    await expect(page.getByTestId('task-detail')).toContainText(/accepted/i)
    await openTab(page, team.root, 'tasks')
    await expect(queue(page).locator(`[data-item-id="pending-acceptance:${resultId}"]`)).toHaveCount(0)
    await expect(bucket('Completed results')).toContainText('— accepted')
    // Resolve the approval, drop the connection with a reload: counts converge, no toast.
    await page.locator(`[data-session-id="${dev}"]`).click()
    await allow(page).click()
    await openTab(page, team.root, 'tasks')
    await page.reload()
    await expect(page.getByTestId('attention-summary')).not.toContainText('loading')
    await expect(queue(page).locator('[data-kind="approval"]')).toHaveCount(0)
    await expect(page.getByText(/^Answer approval:/)).toHaveCount(0)
  } finally { rmSync(team.root, { recursive: true, force: true }) }
})

test('E14: narrow list/detail/Back keeps filters and drafts; keyboard handling restores focus; a second repository is isolated', async ({ page, browser }, info) => {
  const team = resultsTeam()
  const other = resultsTeam()
  const second = await browser.newPage()
  try {
    await page.goto('/')
    const lead = await createChat(page, team.root, 'WS lead narrow', 'leads')
    await createChat(page, other.root, 'WS lead other', 'leads')
    await page.locator(`[data-session-id="${lead}"]`).click()
    await openTab(page, team.root, 'tasks')
    await createTask(page, { title: 'WS narrow in worktree', direction: 'Has a worktree', worktree: team.worktree })
    const worktreeTask = await openTaskId(page)
    await createTask(page, { title: 'WS narrow elsewhere', direction: 'No worktree' })
    // Narrow viewport: filter by worktree, open the task, Back — the list is as it was left.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'All tasks' }).click()
    await page.getByTestId('task-filter-worktree').selectOption(team.worktree)
    await expect(page.locator('[data-testid="task-row"]')).toHaveCount(1)
    await page.locator(`[data-task-id="${worktreeTask}"] button`).first().click()
    await expect(page.getByTestId('task-detail')).toHaveAttribute('data-task-id', worktreeTask)
    await page.getByRole('button', { name: 'All tasks' }).click()
    await expect(page.getByTestId('task-filter-worktree')).toHaveValue(team.worktree)
    await expect(page.locator('[data-testid="task-row"]')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('workspace-narrow-list.png') })
    // A composer draft survives a visit to the Team page and back.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator(`[data-session-id="${lead}"]`).click()
    await page.getByLabel('Message Claude').fill('unsent draft')
    await openTab(page, team.root, 'tasks')
    await page.locator(`[data-session-id="${lead}"]`).click()
    await expect(page.getByLabel('Message Claude')).toHaveValue('unsent draft')
    await page.getByLabel('Message Claude').fill('')

    // Keyboard only: two uncertain deliveries; resolving the focused one moves focus inside the queue.
    const first = seedMail({ root: team.root, fromSession: lead, fromGroup: 'leads', body: 'Held one', toKind: 'session', toId: lead, uncertainFor: lead })
    const next = seedMail({ root: team.root, fromSession: lead, fromGroup: 'leads', body: 'Held two', toKind: 'session', toId: lead, uncertainFor: lead })
    await second.goto(page.url().split('#')[0]!)
    await openTab(page, team.root, 'tasks')
    const action = (id: string) => queue(page).locator(`[data-item-id="uncertain-delivery:${id}"] [data-testid="attention-action"]`)
    // A change in the team (a turn in the second tab) refreshes the snapshot with the seeded rows.
    await second.locator(`[data-session-id="${lead}"]`).click()
    await second.getByLabel('Message Claude').fill('hello')
    await second.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(action(first)).toBeVisible()
    await expect(action(next)).toBeVisible()
    await expect(queue(page).getByTestId('attention-kind').first()).toHaveText('Uncertain delivery')
    await action(first).focus()
    await expect(action(first)).toBeFocused()
    discardMail(first)
    await second.getByLabel('Message Claude').fill('again')
    await second.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(action(first)).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="team-attention-queue"]') !== null)).toBe(true)
    // Enter on the remaining item's action opens its Mailbox row; the row's own controls are reachable.
    await action(next).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('team-mailbox')).toBeVisible()
    await expect(page.locator(`[data-message-id="${next}"]`).getByRole('button', { name: 'Discard' })).toBeVisible()
    await page.locator(`[data-message-id="${next}"]`).getByRole('button', { name: 'Discard' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(`[data-message-id="${next}"]`)).toHaveCount(0)

    // A second repository lists only its own team, and a task id of the first is not found there.
    await openTab(page, other.root, 'tasks')
    await createTask(page, { title: 'WS other repo task', direction: 'Elsewhere' })
    await expect(page.locator('[data-testid="task-row"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'All tasks' }).click()
    await expect(page.locator('[data-testid="task-row"]')).toHaveCount(1)
    await expect(page.getByTestId('team-tasks')).not.toContainText('WS narrow')
    await page.evaluate(([key, id]) => { window.location.hash = `#/team/${encodeURIComponent(key!)}/tasks/${id}` }, [other.root, worktreeTask])
    await expect(page.getByTestId('team-workspace-notice')).toContainText('was not found')
  } finally {
    await second.close()
    rmSync(team.root, { recursive: true, force: true })
    rmSync(other.root, { recursive: true, force: true })
  }
})

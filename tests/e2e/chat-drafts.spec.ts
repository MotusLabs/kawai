import { expect, test } from '@playwright/test'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

const composer = (page: import('@playwright/test').Page) => page.getByLabel('Message Claude')

/**
 * Best-effort cleanup kill, deliberately unasserted: the workspace navigator
 * intermittently keeps a killed chat's row in its worktree section even
 * though every `sessions` broadcast after the kill omits it (observed ~1 in 4
 * runs — a pre-existing client navigator issue, not draft behavior), and the
 * view's fate depends on which session the fallback selection picks.
 */
async function killOpenChat(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
}

async function openChat(page: import('@playwright/test').Page, name: string) {
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

async function createChat(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.locator('input').first().fill(process.cwd())
  await dialog.locator('input').last().fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

test('composer drafts are kept per chat while switching and cleared per session on submit', async ({ page }, info) => {
  await page.goto('/')
  await openChat(page, 'Chat fixture')
  await createChat(page, 'Drafts B')

  // Each chat's unsubmitted text stays its own across switches.
  await composer(page).fill('draft for B')
  await openChat(page, 'Chat fixture')
  await expect(composer(page)).toHaveValue('')
  await composer(page).fill('draft for A')
  await openChat(page, 'Drafts B')
  await expect(composer(page)).toHaveValue('draft for B')
  await page.screenshot({ path: info.outputPath('switching-keeps-both-drafts.png') })
  await openChat(page, 'Chat fixture')
  await expect(composer(page)).toHaveValue('draft for A')

  // Submitting clears only the submitting chat's draft.
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('chat-transcript')).toContainText('draft for A')
  await expect(composer(page)).toHaveValue('')
  await openChat(page, 'Drafts B')
  await expect(composer(page)).toHaveValue('draft for B')

  await killOpenChat(page)
})

test('a draft survives archive and restore but not a page reload', async ({ page }, info) => {
  await page.goto('/')
  await openChat(page, 'Chat fixture')
  await createChat(page, 'Drafts C')
  await composer(page).fill('draft after restore')

  // Archiving closes the view; the session collects in the docked Archive pane.
  await page.getByTestId('chat-archive-button').click()
  await expect(page.getByTestId('chat-view')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand Archive section' }).click()
  // Archived rows drag-disable themselves (dnd-kit marks the wrapper
  // aria-disabled), so force the click through to the row's own handler.
  const archivedRow = page.getByTestId('archive-rows')
    .locator('[data-session-id^="chat-"]', { hasText: 'Drafts C' }).first()
  await archivedRow.click({ force: true })
  await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
  await expect(composer(page)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('archived-hides-composer.png') })

  // Restoring brings the composer back with the pre-archive draft.
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(composer(page)).toBeVisible()
  await expect(composer(page)).toHaveValue('draft after restore')
  await page.screenshot({ path: info.outputPath('restore-returns-draft.png') })

  // Drafts are client-side only: a reload drops them.
  await page.reload()
  await expect(composer(page)).toBeVisible()
  await expect(composer(page)).toHaveValue('')
  await page.screenshot({ path: info.outputPath('reload-clears-draft.png') })

  await killOpenChat(page)
})

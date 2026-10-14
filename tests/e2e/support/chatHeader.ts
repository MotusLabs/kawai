// Chat header actions in the session menu (chat-header-layout D4/D5): Debug,
// Archive, and Kill session live behind the header's "Session actions"
// trigger, and Kill asks for confirmation first.
import { expect, type Page } from '@playwright/test'

export async function openSessionMenu(page: Page) {
  await page.getByTestId('chat-view').getByRole('button', { name: 'Session actions', exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

/** Toggle the debug panel from the session menu. */
export async function toggleDebug(page: Page) {
  await openSessionMenu(page)
  await page.getByRole('menuitemcheckbox', { name: 'Debug' }).click()
}

/** Archive the open chat from the session menu (any turn confirmation is the caller's). */
export async function archiveChat(page: Page) {
  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
}

/** Kill the open chat from the session menu and confirm. */
export async function killChat(page: Page) {
  await openSessionMenu(page)
  await page.getByRole('menuitem', { name: 'Kill session', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Kill', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

import { expect, test, type Page } from '@playwright/test'

// New Session default kind (§ generic open): the keyboard shortcut opens the
// dialog on Claude chat, and the dialog stays keyboard-operable while the
// profile catalog is still loading — Create cannot take focus yet, so the
// provisional focus settles on the always-enabled session-kind select and is
// promoted to Create only once the catalog settles and the user has not moved
// it. The change-section counterpart (Terminal preselected, first-prompt
// selector offered) is asserted in change-seeding.spec.ts, which already
// drives that entry point.

async function pressNewSessionShortcut(page: Page) {
  // Same modifier resolution as App.tsx: auto is ⌃⌥ on macOS and ⌃⇧
  // elsewhere. The task phrasing "⌘N" names this shortcut, not a literal
  // Command+N binding.
  const isMac = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  )
  await page.keyboard.press(isMac ? 'Control+Alt+N' : 'Control+Shift+N')
}

/**
 * Wait out the initial session attach. `terminal-ready` focuses xterm once
 * attach completes, which would otherwise race the dialog's provisional
 * focus — a user opening the dialog does so from an idle app, not during
 * first paint.
 */
async function waitForAppIdle(page: Page) {
  await expect(page.getByTestId('terminal-panel')).toBeVisible()
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)
  await page.waitForTimeout(500)
}

test('shortcut opens the dialog on Claude chat and keeps it keyboard-operable while profiles load', async ({ page }, info) => {
  // Hold the catalog so the loading state is observable in the browser: the
  // deferred route resolves only when the test releases it.
  let releaseCatalog!: () => void
  const catalogHeld = new Promise<void>(resolve => {
    releaseCatalog = resolve
  })
  await page.route('**/api/chat/profiles*', async route => {
    await catalogHeld
    await route.continue()
  })

  await page.goto('/')
  await expect(
    page.getByRole('button', { name: 'New session', exact: true }).first()
  ).toBeVisible()
  await waitForAppIdle(page)

  await pressNewSessionShortcut(page)
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await expect(dialog).toBeVisible()

  // Generic open preselects Claude chat: profile selector, no terminal-only
  // command/host fields.
  await expect(dialog.getByLabel('Session kind')).toHaveValue('chat')
  await expect(dialog.getByTestId('command-select')).toHaveCount(0)
  await expect(dialog.getByTestId('host-select')).toHaveCount(0)

  // While the catalog loads, Create is disabled — a disabled button cannot
  // take focus, so the provisional focus settles on the session-kind select
  // and the dialog is already keyboard-operable.
  await expect(dialog.getByText('Loading profiles…')).toBeVisible()
  const create = dialog.getByRole('button', { name: 'Create', exact: true })
  await expect(create).toBeDisabled()
  await expect(dialog.getByLabel('Session kind')).toBeFocused()
  await page.screenshot({ path: info.outputPath('chat-default-loading.png') })

  // Tab is trapped by the dialog and cycles its focusable elements. The
  // Profile select is disabled while the catalog loads, so the next stop is
  // Project Path — proof the keyboard is live before Create is enabled.
  await page.keyboard.press('Tab')
  await expect(dialog.getByLabel('Session kind')).not.toBeFocused()
  const focusInsideDialog = await page.evaluate(
    () => document.activeElement?.closest('[role="dialog"]') != null
  )
  expect(focusInsideDialog).toBe(true)
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByLabel('Session kind')).toBeFocused()

  // Settle the catalog with focus still on the provisional element: the
  // catch-up promotes it to the now-enabled Create.
  releaseCatalog()
  await expect(create).toBeEnabled()
  await expect(create).toBeFocused()
  await expect(dialog.getByLabel('Profile')).toHaveValue('default')
  await page.screenshot({ path: info.outputPath('chat-default-ready.png') })
})

test('a user-moved focus is not stolen when the catalog settles', async ({ page }) => {
  let releaseCatalog!: () => void
  const catalogHeld = new Promise<void>(resolve => {
    releaseCatalog = resolve
  })
  await page.route('**/api/chat/profiles*', async route => {
    await catalogHeld
    await route.continue()
  })

  await page.goto('/')
  await expect(
    page.getByRole('button', { name: 'New session', exact: true }).first()
  ).toBeVisible()
  await waitForAppIdle(page)

  await pressNewSessionShortcut(page)
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Session kind')).toBeFocused()

  // The user moves focus themselves: type into Project Path.
  const pathInput = dialog.locator('input.input.text-sm').first()
  await pathInput.click()
  await expect(pathInput).toBeFocused()

  releaseCatalog()
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  // Focus stays where the user put it — the catch-up only promotes a focus
  // the dialog still owns.
  await expect(pathInput).toBeFocused()
})

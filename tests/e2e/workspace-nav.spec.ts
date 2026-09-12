// E2E: the grouped workspace navigator on both layouts. The e2e tmux window's
// pane starts in this repository checkout, so workspace discovery seeds from
// its live session path and publishes a worktree group. These specs assert
// selection and collapse through DOM state on the desktop sidebar and the
// mobile drawer (same navigator, two surfaces).
import { test, expect } from '@playwright/test'

// Workspace discovery runs on its own coordinator cadence (watchers plus
// reconciliation), so the first snapshot can trail the session list.
const SNAPSHOT_TIMEOUT = 20_000

test('desktop sidebar groups sessions by worktree with selection and collapse', async ({ page }) => {
  await page.goto('/')

  // The flat list gives way to the grouped navigator once a snapshot lands.
  const header = page.getByTestId('worktree-group-header').first()
  await expect(header).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })

  // Session rows render inside their worktree group and stay selectable.
  const group = page.getByTestId('worktree-group').first()
  const card = group.getByTestId('session-card').first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(card).toHaveClass(/selected/)
  await expect(page.getByTestId('terminal-panel')).toBeVisible()

  // Collapsing hides the group's rows while the header stays.
  const collapseButton = header.getByRole('button').first()
  await expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
  await collapseButton.click()
  await expect(group.getByTestId('session-card')).toHaveCount(0)
  await expect(header).toBeVisible()
  await expect(collapseButton).toHaveAttribute('aria-expanded', 'false')

  // Expanding brings the rows back.
  await collapseButton.click()
  await expect(group.getByTestId('session-card').first()).toBeVisible()
})

test.describe('mobile drawer', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('shows the same groups, closes on in-group selection, collapses from the drawer', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Open session menu' }).tap()
    const drawer = page.locator('.session-drawer')
    await expect(drawer).toHaveClass(/open/)

    const header = drawer.getByTestId('worktree-group-header').first()
    await expect(header).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })

    // Selection from inside a group still attaches the terminal and closes
    // the drawer.
    const card = drawer.getByTestId('session-card').first()
    await expect(card).toBeVisible()
    await card.evaluate((el) => (el as HTMLElement).click())
    await expect(drawer).not.toHaveClass(/open/)
    await expect(page.locator('.xterm').first()).toBeVisible()

    // Collapse works from the drawer too.
    await page.getByRole('button', { name: 'Open session menu' }).tap()
    await expect(drawer).toHaveClass(/open/)
    const drawerGroup = drawer.getByTestId('worktree-group').first()
    const collapseButton = header.getByRole('button').first()
    await collapseButton.tap()
    await expect(drawerGroup.getByTestId('session-card')).toHaveCount(0)
    await expect(header).toBeVisible()
  })
})

// E2E: the sectioned workspace navigator on both layouts. The e2e tmux
// window's pane starts in this repository checkout, so workspace discovery
// seeds from its live session path and publishes sections. These specs
// assert selection and collapse through DOM state on the desktop sidebar and
// the mobile drawer (same navigator, two surfaces). The section model is
// change-sections-first, then unmatched worktrees; which kind holds the
// suite's session depends on the checkout's live registry, so the locators
// target whichever section contains a session card.
import { test, expect } from '@playwright/test'

// Workspace discovery runs on its own coordinator cadence (watchers plus
// reconciliation), so the first snapshot can trail the session list.
const SNAPSHOT_TIMEOUT = 20_000

/** The first section (change or worktree) that renders a session card. */
function sessionSection(page: import('@playwright/test').Page) {
  return page
    .locator(
      'section[data-testid="change-section"], section[data-testid="worktree-section"]'
    )
    .filter({ has: page.getByTestId('session-card') })
    .first()
}

test('desktop sidebar groups sessions in sections with selection and collapse', async ({ page }) => {
  await page.goto('/')

  // The flat list gives way to the sectioned navigator once a snapshot lands.
  const section = sessionSection(page)
  await expect(section).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })
  // Pin the section by its stable key: the card-based filter stops matching
  // once collapsing hides the section's rows.
  const sectionKey = await section.getAttribute('data-section-key')
  const pinned = page.locator(`section[data-section-key="${sectionKey}"]`)

  // Session rows render inside their section and stay selectable.
  const card = pinned.getByTestId('session-card').first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(card).toHaveClass(/selected/)
  await expect(page.getByTestId('terminal-panel')).toBeVisible()

  // Collapsing hides the section's rows while the header stays.
  const collapseButton = pinned.locator('button[aria-expanded]')
  await expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
  await collapseButton.click()
  await expect(pinned.getByTestId('session-card')).toHaveCount(0)
  await expect(pinned.getByTestId('section-header')).toBeVisible()
  await expect(collapseButton).toHaveAttribute('aria-expanded', 'false')

  // Expanding brings the rows back.
  await collapseButton.click()
  await expect(pinned.getByTestId('session-card').first()).toBeVisible()
})

test.describe('mobile drawer', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('shows the same sections, closes on in-section selection, collapses from the drawer', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Open session menu' }).tap()
    const drawer = page.locator('.session-drawer')
    await expect(drawer).toHaveClass(/open/)

    const section = drawer
      .locator(
        'section[data-testid="change-section"], section[data-testid="worktree-section"]'
      )
      .filter({ has: page.getByTestId('session-card') })
      .first()
    await expect(section).toBeVisible({ timeout: SNAPSHOT_TIMEOUT })
    const sectionKey = await section.getAttribute('data-section-key')
    const pinned = drawer.locator(`section[data-section-key="${sectionKey}"]`)

    // Selection from inside a section still attaches the terminal and closes
    // the drawer.
    const card = pinned.getByTestId('session-card').first()
    await expect(card).toBeVisible()
    await card.evaluate((el) => (el as HTMLElement).click())
    await expect(drawer).not.toHaveClass(/open/)
    await expect(page.locator('.xterm').first()).toBeVisible()

    // Collapse works from the drawer too.
    await page.getByRole('button', { name: 'Open session menu' }).tap()
    await expect(drawer).toHaveClass(/open/)
    const collapseButton = pinned.locator('button[aria-expanded]')
    await collapseButton.tap()
    await expect(pinned.getByTestId('session-card')).toHaveCount(0)
    await expect(pinned.getByTestId('section-header')).toBeVisible()
  })
})

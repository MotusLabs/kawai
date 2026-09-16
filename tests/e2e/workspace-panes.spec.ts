// E2E: the Workspace and Remote fallback panes docked at the bottom of the
// workspace navigator. The remote host comes from the config's stub ssh
// (AGENTBOARD_REMOTE_HOSTS), so the Remote pane holds a batch of synthetic
// rows; a tmux window outside every discovered worktree feeds the Workspace
// pane. These specs measure real layout: the default 25% share, independent
// scrolling, drag resize surviving reload, proportional shrink at a short
// viewport, and a drag inside the mobile drawer that neither scrolls nor
// closes it.
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

// Workspace discovery and the remote poller both run on their own cadence.
const PANES_TIMEOUT = 20_000

function tmux(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Pixel measurements of the navigator's regions, from real layout. */
async function paneMetrics(page: Page) {
  return page.evaluate(() => {
    const navigator = document.querySelector('[data-testid="workspace-navigator"]')
    const flow = navigator?.querySelector('[data-testid="workspace-flow-region"]')
    const workspace = document.querySelector('section[data-testid="workspace-section"]')
    const remote = document.querySelector('section[data-testid="remote-section"]')
    const navBox = navigator?.getBoundingClientRect()
    return {
      navigatorHeight: navBox?.height ?? 0,
      flowHeight: flow?.getBoundingClientRect().height ?? 0,
      workspaceHeight: workspace?.getBoundingClientRect().height ?? 0,
      remoteHeight: remote?.getBoundingClientRect().height ?? 0,
      navigatorBottom: navBox?.bottom ?? 0,
      workspaceBottom: workspace?.getBoundingClientRect().bottom ?? 0,
      remoteBottom: remote?.getBoundingClientRect().bottom ?? 0,
      remoteHeaderBottom: remote
        ?.querySelector('[data-testid="fallback-section-header"]')
        ?.getBoundingClientRect().bottom ?? 0,
      workspaceHeaderBottom: workspace
        ?.querySelector('[data-testid="fallback-section-header"]')
        ?.getBoundingClientRect().bottom ?? 0,
    }
  })
}

/** Fresh layout preferences: the share assertions assume no stored fractions. */
async function clearPersistedLayout(page: Page) {
  await page.evaluate(() => {
    localStorage.removeItem('agentboard-settings')
  })
}

test('Remote pane holds a quarter of the navigator, scrolls alone, and resize survives reload', async ({ page }) => {
  await page.goto('/')
  await clearPersistedLayout(page)
  await page.reload()

  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')

  // A window outside every discovered worktree feeds the Workspace pane;
  // several windows inside this checkout (already a discovered section)
  // give the change/worktree flow region enough rows to overflow.
  const fallbackDir = mkdtempSync(join(tmpdir(), 'ab-pane-fallback-'))
  const repoDir = process.cwd()
  const created = tmux(['new-window', '-t', `=${session}`, '-n', 'pane-fallback', '-c', fallbackDir, 'sleep 600'])
  expect(created.status, created.stderr).toBe(0)
  const flowWindows: string[] = []
  for (let i = 0; i < 8; i++) {
    const name = `pane-flow-${i}`
    const ok = tmux(['new-window', '-t', `=${session}`, '-n', name, '-c', repoDir, 'sleep 600'])
    expect(ok.status, ok.stderr).toBe(0)
    flowWindows.push(name)
  }

  try {
    const remotePane = page.locator('section[data-testid="remote-section"]')
    await expect(remotePane).toBeVisible({ timeout: PANES_TIMEOUT })
    await expect(page.locator('section[data-testid="workspace-section"]')).toBeVisible({
      timeout: PANES_TIMEOUT,
    })

    // Default share: both panes at ~25% of the navigator height.
    const defaults = await paneMetrics(page)
    expect(defaults.remoteHeight / defaults.navigatorHeight).toBeGreaterThan(0.22)
    expect(defaults.remoteHeight / defaults.navigatorHeight).toBeLessThan(0.28)
    expect(defaults.workspaceHeight / defaults.navigatorHeight).toBeGreaterThan(0.22)
    expect(defaults.workspaceHeight / defaults.navigatorHeight).toBeLessThan(0.28)

    // Independent scrolling: the remote pane overflows on its own, and each
    // region keeps its scroll position while the other scrolls. The flow
    // rows arrive on the session refresh cadence, so poll for the overflow.
    const remoteScroll = remotePane.getByTestId('fallback-pane-scroll')
    expect(
      await remoteScroll.evaluate((el) => el.scrollHeight > el.clientHeight)
    ).toBe(true)
    const flow = page.getByTestId('workspace-flow-region')
    await expect
      .poll(() => flow.evaluate((el) => el.scrollHeight > el.clientHeight), {
        timeout: PANES_TIMEOUT,
      })
      .toBe(true)
    await remoteScroll.evaluate((el) => {
      el.scrollTop = 40
    })
    await flow.evaluate((el) => {
      el.scrollTop = 30
    })
    expect(await remoteScroll.evaluate((el) => el.scrollTop)).toBe(40)
    expect(await flow.evaluate((el) => el.scrollTop)).toBe(30)

    // Drag the remote handle upward by 80px: its share grows by that share
    // of the navigator height; the stored fraction persists across reload.
    const handle = remotePane.getByTestId('pane-resize-handle')
    const box = await handle.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2, box!.y - 80, { steps: 8 })
    await page.mouse.up()

    const dragged = await paneMetrics(page)
    const draggedShare = dragged.remoteHeight / dragged.navigatorHeight
    const expectedShare = defaults.remoteHeight / defaults.navigatorHeight + 80 / defaults.navigatorHeight
    expect(Math.abs(draggedShare - expectedShare)).toBeLessThan(0.03)

    await page.reload()
    await expect(remotePane).toBeVisible({ timeout: PANES_TIMEOUT })
    const reloaded = await paneMetrics(page)
    expect(Math.abs(reloaded.remoteHeight / reloaded.navigatorHeight - draggedShare)).toBeLessThan(0.02)
  } finally {
    tmux(['kill-window', '-t', `=${session}:pane-fallback`])
    for (const name of flowWindows) {
      tmux(['kill-window', '-t', `=${session}:${name}`])
    }
  }
})

test('at a short viewport the panes shrink while the flow region keeps its floor', async ({ page }) => {
  // Desktop width keeps the sidebar layout (below md the navigator moves
  // into the drawer). The shrink regime is narrow — navigator height must
  // fall between the sum of all floors (~178px) and the height where two
  // 25% panes plus the 96px flow floor just fit (~192px) — so measure the
  // app chrome first and aim the viewport at the middle of that window.
  await page.setViewportSize({ width: 900, height: 600 })
  await page.goto('/')
  await clearPersistedLayout(page)
  await page.reload()

  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')

  const fallbackDir = mkdtempSync(join(tmpdir(), 'ab-pane-short-'))
  const windowName = 'pane-short-fallback'
  const created = tmux(['new-window', '-t', `=${session}`, '-n', windowName, '-c', fallbackDir, 'sleep 600'])
  expect(created.status, created.stderr).toBe(0)

  try {
    const remotePane = page.locator('section[data-testid="remote-section"]')
    await expect(remotePane).toBeVisible({ timeout: PANES_TIMEOUT })
    await expect(page.locator('section[data-testid="workspace-section"]')).toBeVisible({
      timeout: PANES_TIMEOUT,
    })

    const targetNavigatorHeight = 184
    const initial = await paneMetrics(page)
    const chrome = 600 - initial.navigatorHeight
    await page.setViewportSize({ width: 900, height: chrome + targetNavigatorHeight })
    await page.waitForTimeout(100)

    const metrics = await paneMetrics(page)
    expect(Math.abs(metrics.navigatorHeight - targetNavigatorHeight)).toBeLessThanOrEqual(2)
    // The change/worktree region keeps its minimum height floor.
    expect(metrics.flowHeight).toBeGreaterThanOrEqual(95)
    // Both panes shrank below their default 25% share...
    expect(metrics.remoteHeight / metrics.navigatorHeight).toBeLessThan(0.25)
    expect(metrics.workspaceHeight / metrics.navigatorHeight).toBeLessThan(0.25)
    // ...proportionally, so the two panes stay close in size.
    expect(
      Math.abs(metrics.remoteHeight - metrics.workspaceHeight)
    ).toBeLessThanOrEqual(4)
    // No header is clipped: both headers finish inside the navigator.
    expect(metrics.workspaceHeaderBottom).toBeLessThanOrEqual(metrics.navigatorBottom + 0.5)
    expect(metrics.remoteHeaderBottom).toBeLessThanOrEqual(metrics.navigatorBottom + 0.5)
    expect(metrics.remoteBottom).toBeLessThanOrEqual(metrics.navigatorBottom + 0.5)
  } finally {
    tmux(['kill-window', '-t', `=${session}:${windowName}`])
  }
})

test.describe('mobile drawer', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a pane drag inside the drawer resizes without scrolling or closing the drawer', async ({ page }) => {
    await page.goto('/')
    await clearPersistedLayout(page)
    await page.reload()

    const session = process.env.E2E_TMUX_SESSION
    test.skip(!session, 'E2E_TMUX_SESSION not set')

    await page.getByRole('button', { name: 'Open session menu' }).click()
    const drawer = page.locator('.session-drawer')
    await expect(drawer).toHaveClass(/open/)
    // Let the slide-in transition settle so bounding boxes are final.
    await page.waitForTimeout(350)

    const remotePane = drawer.locator('section[data-testid="remote-section"]')
    await expect(remotePane).toBeVisible({ timeout: PANES_TIMEOUT })

    // The handle opts out of touch scrolling so a drag stays a drag.
    const handle = remotePane.getByTestId('pane-resize-handle')
    const touchAction = await handle.evaluate((el) => getComputedStyle(el).touchAction)
    expect(touchAction).toBe('none')

    const drawerScrollTopBefore = await drawer.evaluate((el) => el.scrollTop)
    const before = await drawer.evaluate((root) => {
      const remote = root.querySelector('section[data-testid="remote-section"]')
      const navigator = root.querySelector('[data-testid="workspace-navigator"]')
      return (
        (remote?.getBoundingClientRect().height ?? 0) /
        (navigator?.getBoundingClientRect().height ?? 1)
      )
    })

    const box = await handle.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2, box!.y - 60, { steps: 6 })
    await page.mouse.up()

    // The drawer stayed open and did not scroll; the pane grew.
    await expect(drawer).toHaveClass(/open/)
    expect(await drawer.evaluate((el) => el.scrollTop)).toBe(drawerScrollTopBefore)
    const after = await drawer.evaluate((root) => {
      const remote = root.querySelector('section[data-testid="remote-section"]')
      const navigator = root.querySelector('[data-testid="workspace-navigator"]')
      return (
        (remote?.getBoundingClientRect().height ?? 0) /
        (navigator?.getBoundingClientRect().height ?? 1)
      )
    })
    expect(after - before).toBeGreaterThan(0.03)
  })
})

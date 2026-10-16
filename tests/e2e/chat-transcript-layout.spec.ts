// The chat transcript and header layout in a real browser against the
// development fixture (chat-transcript-layout 2.1, 2.2, 4.1): message metadata
// sits in a gutter beside the body in a wide transcript and stacks above it in
// a narrow one — by the transcript's own width, so Debug and a larger chat
// font reflow it like a narrow window; tool rows align with the body column;
// the header wraps long labels without clipping a control; an archived chat
// keeps the same layout. Screenshots land in the test output directory.
import { expect, test, type Page } from '@playwright/test'
import { archiveChat, killChat, toggleDebug } from './support/chatHeader'

test.describe.configure({ mode: 'serial' })

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

const LONG_NAME = 'Transcript layout walkthrough with a deliberately long chat name that has to wrap'

async function createChat(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.getByLabel('Project Path').fill(process.cwd())
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-name')).toHaveText(name)
}

/** Send a fixture prompt and wait for its own turn to complete. */
/**
 * Open a chat from the navigator after a reload. A worktree section header's
 * sr-only label (SectionHeader, outside this change) overflows the document,
 * so the row click can scroll the window; reset it so screenshots show the header.
 */
async function openFromNavigator(page: Page, name: string) {
  await page.reload()
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: name }).first().click()
  await expect(page.getByTestId('chat-transcript').first().getByText(/Turn complete/).last()).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
}

async function send(page: Page, text: string) {
  const completions = page.getByTestId('chat-transcript').first().getByText(/Turn complete/)
  const before = await completions.count()
  await page.getByLabel('Message Claude').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(completions).toHaveCount(before + 1, { timeout: 30_000 })
}

/** Where each message row's metadata sits relative to its body, plus overflow facts. */
function transcriptFacts(page: Page) {
  return page.getByTestId('chat-transcript').first().evaluate(root => {
    const rows = [...root.querySelectorAll(':scope > [data-chat-role]')].map(row => {
      const meta = row.querySelector(':scope > .chat-row-meta')!.getBoundingClientRect()
      const body = row.querySelector(':scope > .chat-row-body')!.getBoundingClientRect()
      const placement = meta.right <= body.left + 0.5 && meta.top < body.bottom ? 'gutter'
        : meta.bottom <= body.top + 0.5 ? 'stacked' : 'overlap'
      return { role: row.getAttribute('data-chat-role'), placement, bodyLeft: Math.round(body.left), bodyWidth: body.width }
    })
    const asides = [...root.querySelectorAll(':scope > .chat-row-aside > .chat-row-body')]
      .map(body => Math.round(body.getBoundingClientRect().left))
    // The container query's condition: content width against 34em of the container's font.
    const style = getComputedStyle(root)
    const content = root.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    const wide = content >= 34 * Number.parseFloat(style.fontSize)
    return { content, wide, overflow: root.scrollWidth - root.clientWidth, rows, asides }
  })
}

function headerFacts(page: Page) {
  return page.getByTestId('chat-view').locator('header[data-layout]').evaluate(h => {
    const box = h.getBoundingClientRect()
    const clipped = [...h.querySelectorAll('button, [role="switch"], [data-testid="chat-name"], [data-testid="chat-status"]')]
      .filter(node => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5 || rect.bottom > box.bottom + 0.5)
      })
      .map(node => node.getAttribute('aria-label') || node.textContent)
    return { clipped, overflow: h.scrollWidth - h.clientWidth, layout: h.dataset.layout }
  })
}

/** Check every message row's placement — `expected`, else what the container's width implies. */
async function expectLayout(page: Page, expected?: 'gutter' | 'stacked') {
  const facts = await transcriptFacts(page)
  const placement = expected ?? (facts.wide ? 'gutter' : 'stacked')
  expect(facts.wide, JSON.stringify(facts)).toBe(placement === 'gutter')
  expect(facts.overflow).toBeLessThanOrEqual(0)
  expect(facts.rows.length).toBeGreaterThanOrEqual(2)
  expect(facts.asides.length, 'tool and summary rows').toBeGreaterThan(0)
  for (const row of facts.rows) expect(row, JSON.stringify(row)).toMatchObject({ placement })
  // Message bodies and tool rows share one column, and bodies stay readable.
  const lefts = new Set([...facts.rows.map(row => row.bodyLeft), ...facts.asides])
  expect(lefts.size, JSON.stringify(facts)).toBe(1)
  for (const row of facts.rows) expect(row.bodyWidth).toBeGreaterThan(200)
  const header = await headerFacts(page)
  expect(header.clipped).toEqual([])
  expect(header.overflow).toBeLessThanOrEqual(0)
  return facts
}

test('message metadata takes a gutter when wide and stacks when narrow', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createChat(page, LONG_NAME)
  await send(page, 'hello')
  await send(page, 'tool')
  const transcript = page.getByTestId('chat-transcript').first()
  // The agent label comes from the agent kind; times are semantic <time> with a full hover.
  await expect(transcript.locator('[data-chat-role="assistant"] [data-testid="chat-row-author"]').first()).toHaveText('Claude')
  await expect(transcript.locator('[data-chat-role="user"] time').first()).toHaveAttribute('title', /\d{4}/)

  await expectLayout(page, 'gutter')
  await page.screenshot({ path: info.outputPath('wide.png') })

  // Debug narrows the transcript inside the same window.
  await toggleDebug(page)
  await expect(page.getByTestId('chat-debug-panel')).toBeVisible()
  await expectLayout(page)
  await page.screenshot({ path: info.outputPath('wide-debug.png') })
  await toggleDebug(page)

  // A mid window at the default 15px chat font still keeps the gutter.
  await page.setViewportSize({ width: 820, height: 900 })
  await expectLayout(page, 'gutter')

  // A wider navigator at a mid window narrows the chat column.
  await page.setViewportSize({ width: 900, height: 900 })
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('agentboard-settings') ?? '{"state":{},"version":7}')
    raw.state.sidebarWidth = 400
    localStorage.setItem('agentboard-settings', JSON.stringify(raw))
  })
  await openFromNavigator(page, 'Transcript layout walkthrough')
  await expectLayout(page)
  await page.screenshot({ path: info.outputPath('mid-wide-navigator.png') })

  // Phone width: metadata stacks above every body.
  await page.setViewportSize({ width: 390, height: 844 })
  await expectLayout(page, 'stacked')
  await page.screenshot({ path: info.outputPath('narrow.png'), fullPage: true })
  await killChat(page)
})

test('a larger chat font reflows by ems and an archived chat keeps the layout', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await createChat(page, 'Transcript font and archive')
  await send(page, 'tool')
  await expectLayout(page, 'gutter')

  // At 20px (the setting's maximum) the same transcript is fewer ems wide.
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('agentboard-settings') ?? '{"state":{},"version":7}')
    raw.state.chatFontSize = 20
    localStorage.setItem('agentboard-settings', JSON.stringify(raw))
  })
  await openFromNavigator(page, 'Transcript font and archive')
  await expectLayout(page, 'gutter')
  await page.screenshot({ path: info.outputPath('font-20.png') })
  // 820px keeps a 15px transcript wide (see the first test's navigator step)
  // but is under 34em at 20px: the rows stack.
  await page.setViewportSize({ width: 820, height: 900 })
  await expectLayout(page, 'stacked')
  await page.screenshot({ path: info.outputPath('font-20-820.png') })

  await page.setViewportSize({ width: 1100, height: 900 })
  await archiveChat(page)
  // Archiving may select another chat left by earlier specs; open ours from the Archive pane.
  await page.getByRole('button', { name: 'Expand Archive section' }).click()
  // Archived rows drag-disable themselves, so force the click through.
  await page.getByTestId('archive-rows').getByText('Transcript font and archive').click({ force: true })
  await expect(page.getByTestId('chat-name')).toHaveText('Transcript font and archive')
  await expect(page.getByTestId('chat-archived-bar')).toBeVisible()
  await expect(page.getByTestId('chat-transcript').first().getByText(/Turn complete/).last()).toBeVisible()
  await expectLayout(page, 'gutter')
  await page.screenshot({ path: info.outputPath('archived.png') })
  await killChat(page)
})

// Task and paused context come from team state the SDK-free fixture cannot
// produce (a spawned task member, provider-limit parking), so this test
// decorates the server's session broadcasts for one chat name on the wire —
// the client renders exactly what a real broadcast would carry.
const DECORATED = 'Header context walkthrough'
const LONG_TASK = 'Implement the responsive transcript layout across every chat surface without clipping a single control'

function decorate(session: Record<string, unknown>) {
  if (session.name !== DECORATED) return session
  return {
    ...session, taskId: 'task-long', taskTitle: LONG_TASK, spawned: true,
    parked: { messageId: 'msg-1', until: new Date(Date.now() + 3_600_000).toISOString(), profileId: 'default', reason: 'Provider limit on default' },
  }
}

test('long task and paused context wrap in their own row at every width', async ({ page }, info) => {
  await page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => server.send(message))
    server.onMessage(message => {
      if (typeof message !== 'string') return ws.send(message)
      const parsed = JSON.parse(message) as { type: string; sessions?: Record<string, unknown>[]; session?: Record<string, unknown> }
      if (parsed.type === 'sessions' && parsed.sessions) parsed.sessions = parsed.sessions.map(decorate)
      if ((parsed.type === 'session-update' || parsed.type === 'session-created') && parsed.session) parsed.session = decorate(parsed.session)
      ws.send(JSON.stringify(parsed))
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await createChat(page, DECORATED)
  await send(page, 'tool')
  const header = page.getByTestId('chat-view').locator('header[data-layout]')
  const context = header.getByTestId('chat-context-row')
  await expect(context).toContainText(LONG_TASK)
  await expect(context).toContainText(/paused/i)
  for (const [width, font] of [[1440, 15], [820, 15], [390, 15], [1100, 20]] as const) {
    await page.setViewportSize({ width, height: 900 })
    if (font !== 15) {
      await page.evaluate(size => {
        const raw = JSON.parse(localStorage.getItem('agentboard-settings') ?? '{"state":{},"version":7}')
        raw.state.chatFontSize = size
        localStorage.setItem('agentboard-settings', JSON.stringify(raw))
      }, font)
      await openFromNavigator(page, DECORATED)
    }
    // The whole task title stays readable: it wraps inside the header, never clipped or scrolled.
    const chip = await context.evaluate(row => {
      const box = row.closest('header')!.getBoundingClientRect()
      const task = row.querySelector('[data-testid="chat-task"]')!
      const rect = task.getBoundingClientRect()
      return { inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5, clipped: task.scrollWidth > task.clientWidth + 1 }
    })
    expect(chip, `${width}px at ${font}px`).toEqual({ inside: true, clipped: false })
    await expectLayout(page)
    await header.screenshot({ path: info.outputPath(`context-${width}-${font}.png`) })
  }
  await killChat(page)
})

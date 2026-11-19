// Real app, isolated server/DB and deterministic wire projections; no model calls.
import { expect, test, type Page } from '@playwright/test'
import { documentScrollFixture, expectViewport, scrollOracles, viewportFacts } from './fixtures/teamDocumentScroll'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1200, height: 758 } })
test.setTimeout(120_000)
let fixture: ReturnType<typeof documentScrollFixture>
test.beforeAll(async ({ browser }) => {
  fixture = documentScrollFixture({ ...process.env, AGENTBOARD_CHAT_FIXTURE: '1' })
  const page = await browser.newPage()
  try { await fixture.start(page) } finally { await page.close() }
})
test.afterAll(async () => { await fixture?.stop() })

async function checkO1(page: Page) {
  await fixture.openChat(page)
  await page.getByTestId('workspace-flow-region').evaluate(el => { el.scrollTop = 900 })
  await fixture.team(page)
  await expect(page.getByTestId('section-header').last().locator('.sr-only')).toContainText('dirty')
  const facts = await viewportFacts(page)
  expect(facts.extent).toBeLessThanOrEqual(facts.height + 1)
  await expectViewport(page)
}

async function checkO2(page: Page) {
  await fixture.openChat(page)
  await expect(page.getByTestId('chat-transcript').locator('time .sr-only').first()).toHaveText(/2026/)
  await expect(page.getByTestId('chat-row-author').last()).toHaveClass('sr-only')
  await expect(page.getByTestId('chat-message-copy-status')).toHaveCount(90)
  await expectViewport(page)
  await fixture.team(page)
  await expectViewport(page)
  await page.goBack()
  await expect(page.getByTestId('chat-name')).toHaveText('Scroll fixture chat')
  await expectViewport(page)
}

test('O1/O2 controls: removing local label containment recreates document overflow', async ({ page }) => {
  await fixture.openChat(page)
  await expectViewport(page)
  for (const css of [
    '[data-testid="section-header"] button { position: static !important; }',
    '.chat-row-meta, .chat-row-copy, .chat-row-stamp time { position: static !important; }',
  ]) {
    const mutant = await page.addStyleTag({ content: css })
    const facts = await viewportFacts(page)
    expect(facts.extent).toBeGreaterThan(facts.height + 1)
    await mutant.evaluate(el => el.remove())
    await expectViewport(page)
  }
})

async function prepare(page: Page) {
  await fixture.openChat(page)
  await page.getByTestId('workspace-flow-region').evaluate(el => { el.scrollTop = 900 })
  await fixture.team(page, 'plans', fixture.planId)
  await expect(page.locator('#plan-title')).toBeFocused()
}

const card = (page: Page) => page.locator(`#decision-card-${fixture.cardId}`)
const change = (page: Page) => page.locator('#plan-change-scroll-change')
const pane = (page: Page) => page.locator('[data-plan-scroll-container]')
const action = (page: Page, kind: 'card' | 'change') => kind === 'card'
  ? page.getByTestId('attention-item').filter({ hasText: 'Which scroll behavior?' }).getByTestId('attention-action')
  : page.locator('[data-kind="plan-stop"]').getByTestId('attention-action')
const otherScrolls = (page: Page) => page.evaluate(() => [
  document.scrollingElement, document.querySelector('#root'), document.querySelector('#root > div'),
  document.querySelector('[data-testid="team-workspace"]'),
  document.querySelector('[data-testid="workspace-flow-region"]'), document.querySelector('#attention'),
].map(el => el?.scrollTop ?? 0))

async function reveal(page: Page, kind: 'card' | 'change', keyboard = false, hostile = false) {
  const button = action(page, kind)
  await button.scrollIntoViewIfNeeded()
  if (keyboard) await button.focus()
  const before = await otherScrolls(page)
  if (keyboard) await button.press('Enter')
  else await button.click()
  const target = kind === 'card' ? card(page) : change(page)
  await expect(target).toBeFocused()
  await expect.poll(async () => {
    const outer = (await pane(page).boundingBox())!
    const rect = (await target.boundingBox())!
    return rect.y >= outer.y - 1 && rect.y + rect.height <= outer.y + outer.height + 1
  }).toBe(true)
  expect(await otherScrolls(page)).toEqual(before)
  await expectViewport(page, !hostile)
}

const checks: Record<typeof scrollOracles[number][0], (page: Page) => Promise<void>> = {
  O1: checkO1, O2: checkO2,
  O3: async page => { await prepare(page); await reveal(page, 'card'); await reveal(page, 'card', true) },
  O4: async page => { await prepare(page); await reveal(page, 'change') },
  O5: async page => {
    await prepare(page)
    fixture.update({ tall: true })
    await expect(card(page)).toContainText('Tall card')
    await action(page, 'card').click()
    await expect(card(page)).toBeFocused()
    const outer = (await pane(page).boundingBox())!
    const target = (await card(page).boundingBox())!
    expect(target.height).toBeGreaterThan(outer.height)
    expect(Math.abs(target.y - outer.y)).toBeLessThanOrEqual(1)
    const before = await pane(page).evaluate(el => el.scrollTop)
    await pane(page).evaluate(el => { el.scrollTop += 200 })
    expect(await pane(page).evaluate(el => el.scrollTop)).toBeGreaterThan(before)
    await expectViewport(page)
  },
  O6: async page => {
    await prepare(page)
    fixture.update({ missing: true })
    await expect(card(page)).toHaveCount(0)
    await action(page, 'card').click()
    await expect(page.locator('#plan-title')).toBeFocused()
    expect(await pane(page).evaluate(el => el.scrollTop)).toBeLessThan(60)
    await page.getByTestId('plan-back').focus()
    const scroll = await pane(page).evaluate(el => el.scrollTop)
    fixture.update({ missing: false })
    await expect(card(page)).toHaveCount(1)
    await expect(page.getByTestId('plan-back')).toBeFocused()
    expect(await pane(page).evaluate(el => el.scrollTop)).toBe(scroll)
    await expectViewport(page)
  },
  O7: async page => {
    await prepare(page)
    await reveal(page, 'card')
    await card(page).getByTestId('plan-decision-answer').click()
    const answer = card(page).getByTestId('plan-decision-answer-dialog')
    await expect(answer).toBeVisible()
    await answer.getByLabel('Another choice').fill('Keep the viewport')
    await answer.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expectViewport(page)
    await reveal(page, 'change')
    await page.getByTestId('plan-execution-retry-command').click()
    const retry = page.getByTestId('plan-execution-retry-command-dialog')
    await expect(retry).toBeVisible()
    await retry.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expectViewport(page)
    await fixture.team(page, 'tasks', fixture.taskId)
    const task = page.getByTestId('task-detail')
    await expect(task).toBeVisible()
    await task.getByLabel('Assignment target kind').selectOption('session')
    await task.getByLabel('Assignment session').selectOption({ index: 1 })
    await task.getByLabel('Assignment instruction').fill('Fixture instruction that will not be sent')
    await task.getByTestId('task-assign-send').click()
    await expect(task.getByText('This task already has an outstanding assignment:', { exact: false })).toBeVisible()
    await task.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(task.getByLabel('Assignment instruction')).toHaveValue('Fixture instruction that will not be sent')
    await expectViewport(page)
  },
  O8: async page => {
    await fixture.openChat(page)
    await fixture.team(page)
    await page.getByTestId('plan-list').getByRole('button', { name: /Scroll regression plan/ }).click()
    await expect(page.locator('#plan-title')).toBeFocused()
    const title = (await page.locator('#plan-title').boundingBox())!
    const outer = (await pane(page).boundingBox())!
    expect(title.y).toBeGreaterThanOrEqual(outer.y - 1)
    expect(title.y + title.height).toBeLessThanOrEqual(outer.y + outer.height + 1)
    await expectViewport(page)
  },
}

for (const [id, input, command, result, mutant] of scrollOracles) {
  // The parameterized test covers the scenario belonging to each oracle row.
  // @covers: team-workspace › Hidden labels retain accessibility without document overflow › Long navigator retains state labels
  // @covers: team-workspace › Hidden labels retain accessibility without document overflow › Return from a long chat transcript
  // @covers: team-workspace › Team navigation preserves the application viewport › Answer a plan question from attention
  // @covers: team-workspace › Team navigation preserves the application viewport › Open a stopped change from attention
  // @covers: team-workspace › Team navigation preserves the application viewport › Use controls inside a selected record
  // @covers: team-workspace › Plan reveals scroll only the owning content pane › Reveal a card that fits
  // @covers: team-workspace › Plan reveals scroll only the owning content pane › Reveal a target taller than the pane
  // @covers: team-workspace › Plan reveals scroll only the owning content pane › A reveal target no longer exists
  test(`${id}: ${command}`, async ({ page }, info) => {
    info.annotations.push({ type: 'oracle', description: `${input} → ${result}; mutant: ${mutant}` })
    await checks[id](page)
  })
}

test('O3/O4/O8 boundary: hostile document cannot mask unrestricted reveal mutants', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const overflow = document.createElement('div')
    overflow.id = 'test-owned-overflow'
    overflow.style.cssText = 'position:absolute;top:3000px;height:1px;width:1px'
    document.body.append(overflow)
  })
  expect((await viewportFacts(page)).extent).toBeGreaterThan(3000)
  for (const kind of ['card', 'change'] as const) {
    await reveal(page, kind, false, true)
    const id = kind === 'card' ? `decision-card-${fixture.cardId}` : 'plan-change-scroll-change'
    await page.evaluate(id => {
      const original = Element.prototype.scrollTo
      Element.prototype.scrollTo = function(options?: ScrollToOptions | number, y?: number) {
        if (this.hasAttribute('data-plan-scroll-container')) document.getElementById(id)!.scrollIntoView({ block: 'center' })
        else if (typeof options === 'number') original.call(this, options, y ?? 0)
        else original.call(this, options)
      }
      Object.assign(window, { restoreScrollMutant: () => { Element.prototype.scrollTo = original; window.scrollTo(0, 0) } })
    }, id)
    try {
      await action(page, kind).click()
      await expect.poll(async () => (await viewportFacts(page)).documentScroll).toBeGreaterThan(1)
    } finally {
      await page.evaluate(() => (window as unknown as { restoreScrollMutant: () => void }).restoreScrollMutant())
    }
  }
  await page.evaluate(() => document.getElementById('test-owned-overflow')!.remove())
  await expectViewport(page)
})

test('P-I1: 32 seeded production reveals preserve every non-owning scroll offset', async ({ page }) => {
  await prepare(page)
  let seed = 0x51c011
  for (let i = 0; i < 32; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    await page.setViewportSize(i & 1 ? { width: 1024, height: 600 } : { width: 1200, height: 758 })
    fixture.update({ goalWords: 400 + seed % 1000 })
    await page.getByTestId('workspace-flow-region').evaluate((el, top) => { el.scrollTop = top }, seed % 1300)
    await page.locator('#attention').evaluate((el, top) => { el.scrollTop = top }, seed % 60)
    await pane(page).evaluate(el => { el.scrollTop = 0 })
    await reveal(page, seed & 2 ? 'card' : 'change', !!(seed & 4))
  }
  await page.setViewportSize({ width: 1200, height: 758 })
  await page.addStyleTag({ content: 'html,body {font-size:16px}' })
  await reveal(page, 'card', true)
})

// Real app, isolated server/DB and deterministic wire projections; no model calls.
import { expect, test } from '@playwright/test'
import { documentScrollFixture, expectViewport, viewportFacts } from './fixtures/teamDocumentScroll'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1200, height: 758 } })
test.setTimeout(120_000)
let fixture: ReturnType<typeof documentScrollFixture>
test.beforeAll(async ({ browser }) => {
  fixture = documentScrollFixture()
  const page = await browser.newPage()
  try { await fixture.start(page) } finally { await page.close() }
})
test.afterAll(async () => { await fixture?.stop() })

// @covers: team-workspace › Hidden labels retain accessibility without document overflow › Long navigator retains state labels
test('O1: navigator state labels stay accessible without document overflow', async ({ page }) => {
  await fixture.openChat(page)
  await page.getByTestId('workspace-flow-region').evaluate(el => { el.scrollTop = 900 })
  await fixture.team(page)
  await expect(page.getByTestId('section-header').last().locator('.sr-only')).toContainText('dirty')
  const facts = await viewportFacts(page)
  expect(facts.extent).toBeLessThanOrEqual(facts.height + 1)
  await expectViewport(page)
})

// @covers: team-workspace › Hidden labels retain accessibility without document overflow › Return from a long chat transcript
test('O2: long transcript metadata stays accessible without document overflow', async ({ page }) => {
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
})

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

// @covers: team-workspace › Team navigation preserves the application viewport › Answer a plan question from attention
// @covers: team-workspace › Plan reveals scroll only the owning content pane › Reveal a card that fits
test('O3: Answer the question reveals the card without shifting the document', async ({ page }) => {
  await fixture.openChat(page)
  await page.getByTestId('workspace-flow-region').evaluate(el => { el.scrollTop = 900 })
  await fixture.team(page)
  await page.getByTestId('team-attention-queue').getByRole('button', { name: /Answer the question/ }).click()
  await expect(page.locator(`#decision-card-${fixture.cardId}`)).toBeFocused()
  await expectViewport(page)
})

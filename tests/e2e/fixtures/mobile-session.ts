// Wait for the selected terminal attachment, including its one-shot autofocus.
// A visible xterm or an enabled control alone can precede terminal-ready.
import { expect, type Page } from '@playwright/test'

export async function selectMobileSession(page: Page, name: string) {
  const readySessions = new Set<string>()
  page.on('websocket', socket => socket.on('framereceived', event => {
    const message = JSON.parse(String(event.payload))
    if (message.type === 'terminal-ready') readySessions.add(message.sessionId)
  }))
  await page.goto('/')
  // The mobile drawer card is attached but hidden until the drawer opens.
  const card = page.getByTestId('session-card').filter({ hasText: name }).first()
  await card.waitFor({ state: 'attached', timeout: 20000 })
  const sessionId = await card.getAttribute('data-session-id')
  expect(sessionId).toBeTruthy()
  await card.evaluate(element => (element as HTMLElement).click())
  await expect.poll(() => readySessions.has(sessionId!), { timeout: 20000 }).toBe(true)
  await expect(page.locator('.xterm')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeEnabled()
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0)
}

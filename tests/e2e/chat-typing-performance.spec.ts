// Fresh bundle, isolated server and synthetic wire history; no model calls.
// Run: NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4189 bunx playwright test tests/e2e/chat-typing-performance.spec.ts --workers=1
import { expect, test, type Page } from '@playwright/test'
import type { ChatCommandState } from '../../src/shared/chat'
import type { ServerMessage } from '../../src/shared/types'
import { typingHistory } from './support/chatTypingFixture'
import { killChat } from './support/chatHeader'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')
test.setTimeout(180_000)

async function createChat(page: Page, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.getByLabel('Project Path').fill(process.cwd())
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-name')).toHaveText(name)
  await expect(page.getByLabel('Message Claude')).toBeEnabled()
}

for (const count of [0, 500]) {
  for (const streaming of [false, true]) {
    test(`${count} messages, ${streaming ? 'streaming' : 'idle'}: input and transcript stay usable`, async ({ page }, info) => {
      const commands: ChatCommandState = { status: 'ready', commands: [{ name: 'context', description: 'Show context', aliases: [], source: 'builtin' }] }
      let sessionId = ''
      let sequence = 0
      let push: ((message: ServerMessage) => void) | undefined
      await page.routeWebSocket(/\/ws$/, ws => {
        const server = ws.connectToServer()
        push = message => ws.send(JSON.stringify(message))
        ws.onMessage(message => server.send(message))
        server.onMessage(message => {
          if (typeof message !== 'string') return ws.send(message)
          const parsed = JSON.parse(message) as ServerMessage
          if (parsed.type === 'session-created' && !sessionId) sessionId = parsed.session.id
          if (parsed.type === 'chat-snapshot' && parsed.sessionId === sessionId) {
            parsed.events = typingHistory(count)
            parsed.throughSequence = 0
            parsed.commands = commands
          }
          if (parsed.type === 'chat-commands') parsed.state = commands
          ws.send(JSON.stringify(parsed))
        })
      })
      await page.goto('/')
      await createChat(page, `Typing ${count} ${streaming}`)
      const input = page.getByLabel('Message Claude')
      const transcript = page.getByTestId('chat-transcript').first()
      await expect(transcript.locator('[data-chat-role]')).toHaveCount(count)
      const disclosure = transcript.locator('details').first()
      if (count) await disclosure.evaluate(node => { (node as HTMLDetailsElement).open = true })
      await input.fill('warmup')
      await input.clear()
      // Measure keydown to the frame after React's input commit. Two rAFs
      // include a paint opportunity; Playwright/network time is excluded.
      await input.evaluate(node => {
        const state = { samples: [] as number[] }
        Object.assign(window, { typingMeasurement: state })
        node.addEventListener('keydown', event => {
          if ((event as KeyboardEvent).key.length !== 1) return
          const start = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => state.samples.push(performance.now() - start)))
        })
      })
      const timer = streaming ? setInterval(() => push?.({ type: 'chat-events', sessionId, events: [{
        type: 'assistant_text', id: `stream-${++sequence}`, sequence: 0, at: '2026-10-16T10:00:00.000Z',
        turnId: 'stream', messageId: 'stream-message', text: `Live output ${sequence}`,
      }] }), 100) : undefined
      try {
        await input.focus()
        await input.pressSequentially('Typing through a long conversation with markdown.', { delay: 20 })
        await expect(input).toHaveValue('Typing through a long conversation with markdown.')
        if (streaming) await expect(transcript).toContainText('Live output')
        const samples = await page.evaluate(() => (window as unknown as { typingMeasurement: { samples: number[] } }).typingMeasurement.samples.sort((a, b) => a - b))
        const metrics = { count, streaming, samples: samples.length, medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.floor(samples.length * 0.95)] }
        expect(samples.length).toBeGreaterThan(30)
        await info.attach('typing-latency', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
        console.log(JSON.stringify(metrics))
        await input.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(7, 14))
        await page.waitForTimeout(250)
        expect(await input.evaluate(node => ({ focused: document.activeElement === node, start: (node as HTMLTextAreaElement).selectionStart, end: (node as HTMLTextAreaElement).selectionEnd })))
          .toEqual({ focused: true, start: 7, end: 14 })
      } finally { clearInterval(timer) }
      if (count) await expect(disclosure).toHaveAttribute('open', '')
      await page.screenshot({ path: info.outputPath('typing.png') })
      await input.fill('/cont')
      await expect(page.getByTestId('slash-command-menu')).toBeVisible()
      await input.press('Tab')
      await expect(input).toHaveValue('/context ')
      await input.fill('draft kept across switches')
      await createChat(page, 'Other typing chat')
      await expect(input).toHaveValue('')
      await page.locator('[data-session-id^="chat-"]').filter({ hasText: `Typing ${count} ${streaming}` }).first().click()
      await expect(input).toHaveValue('draft kept across switches')
      await input.fill('submitted performance draft')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(input).toHaveValue('')
      await expect(transcript).toContainText('submitted performance draft')
      await killChat(page)
      await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Other typing chat' }).first().click()
      await killChat(page)
    })
  }
}

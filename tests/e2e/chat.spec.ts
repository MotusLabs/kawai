import { expect, test } from '@playwright/test'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

async function openFixture(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Chat fixture' }).first().click()
  await expect(page.getByTestId('chat-view')).toBeVisible()
}

test('chat modal toggles local chat fields and creates a chat session', async ({ page }, info) => {
  const creations: Array<{ kind?: string; name?: string }> = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload))
    if (message.type === 'session-create') creations.push({ kind: message.kind, name: message.name })
  }))
  await page.goto('/')
  await expect(page.locator('[data-session-id^="chat-"]').first()).toBeVisible()
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  // Claude chat is the default kind: no terminal-only fields on open.
  await expect(dialog.getByLabel('Session kind')).toHaveValue('chat')
  await expect(dialog.getByTestId('command-select')).toHaveCount(0)
  await expect(dialog.getByTestId('host-select')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('chat-modal.png') })
  await dialog.getByLabel('Session kind').selectOption('terminal')
  await expect(dialog.getByTestId('command-select')).toBeVisible()
  await dialog.getByLabel('Session kind').selectOption('chat')
  await expect(dialog.getByTestId('command-select')).toHaveCount(0)
  await dialog.locator('input').first().fill(process.cwd())
  await dialog.locator('input').last().fill('Browser chat')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => creations).toEqual([{ kind: 'chat', name: 'Browser chat' }])
  await expect(page.getByTestId('chat-view')).toContainText('Browser chat')
  await page.getByLabel('Message Claude').fill('hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('chat-transcript')).toContainText('Fixture response')
  await page.getByRole('button', { name: 'Kill session', exact: true }).click()
  await expect(page.locator('[data-session-id^="chat-"]').filter({ hasText: 'Browser chat' })).toHaveCount(0)
})

test('approval, questions, streaming reconnect, two-client resolution, and stop', async ({ page, context }, info) => {
  await openFixture(page)
  const second = await context.newPage()
  await openFixture(second)
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('chat-approval.png') })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(second.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('chat-transcript')).toContainText('Request accepted.')

  await page.getByLabel('Message Claude').fill('approval')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page.getByTestId('chat-transcript')).toContainText('Request denied.')

  await page.getByLabel('Message Claude').fill('question')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByLabel('Blue', { exact: false }).check()
  await page.getByLabel('Green', { exact: false }).check()
  await page.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)
  await expect(second.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)

  // The answered tool still runs for a moment (the fixture holds it so the
  // activity row's restarted clock is observable). A send before the turn's
  // result frame is queued into the live turn and its output is dropped
  // (driver frames after turn end are ignored), so wait for the third
  // "Turn complete" — approval, denial, question — before streaming.
  await expect(page.getByText('Turn complete')).toHaveCount(3)

  await page.getByLabel('Message Claude').fill('stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('chat-transcript')).toContainText('Streaming')
  await page.reload()
  await expect(page.getByTestId('chat-transcript')).toContainText('Streaming a response across reconnect.')
  await expect(page.getByText('Streaming a response across reconnect.', { exact: true })).toHaveCount(1)

  await page.getByLabel('Message Claude').fill('approval')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(second.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('chat-transcript')).toContainText('Turn stopped')
  await page.screenshot({ path: info.outputPath('chat-complete.png') })
  await second.close()
})

test('debug view shows protocol frames live, pages older frames, and survives reload', async ({ page }, info) => {
  await openFixture(page)
  const debug = page.getByRole('button', { name: 'Debug', exact: true })
  const panel = page.getByTestId('chat-debug-panel')
  await expect(debug).toHaveAttribute('aria-pressed', 'false')
  await debug.click()
  await expect(debug).toHaveAttribute('aria-pressed', 'true')
  await expect(panel).toBeVisible()

  // A fresh approval turn streams its permission request and response live.
  const allow = page.getByRole('button', { name: 'Allow', exact: true })
  if (await allow.count()) await allow.click()
  const requests = panel.getByText('control_request · can_use_tool')
  const responses = panel.getByText('control_response · success')
  // Wait for the initial history snapshot before measuring live additions.
  await expect(panel.locator('[data-frame-seq]').first()).toBeVisible()
  await expect(panel.getByText('Loading…', { exact: true })).toHaveCount(0)
  const requestsBefore = await requests.count()
  const responsesBefore = await responses.count()
  await page.getByLabel('Message Claude').fill('approval')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(requests).toHaveCount(requestsBefore + 1)
  await allow.click()
  await expect(page.getByTestId('chat-transcript')).toContainText('Request accepted.')
  await expect(responses).toHaveCount(responsesBefore + 1)
  await expect(panel.getByText('result · success').last()).toBeVisible()

  // Expanding a frame shows its pretty-printed JSON.
  await responses.last().click()
  await expect(panel.locator('pre').last()).toContainText('"behavior": "allow"')
  await page.screenshot({ path: info.outputPath('chat-debug.png') })

  // Enough short turns to exceed one page (200 frames), then walk back.
  const composer = page.getByLabel('Message Claude')
  for (let index = 0; index < 70; index += 1) {
    await composer.fill(`ping ${index}`)
    await composer.press('Enter')
  }
  await expect(page.getByTestId('chat-transcript')).toContainText('ping 69')
  await expect(page.getByTestId('chat-view').getByText('waiting', { exact: true })).toBeVisible()
  const rows = panel.locator('[data-frame-seq]')
  // Live frames all stay loaded while the panel is open; re-opening fetches
  // only the newest page, leaving older frames to load on demand.
  await debug.click()
  await debug.click()
  await expect(panel.getByRole('button', { name: 'Load older' })).toBeVisible()
  await expect(rows).toHaveCount(200)
  const before = await rows.count()
  const oldestBefore = Number(await rows.first().getAttribute('data-frame-seq'))
  await panel.getByRole('button', { name: 'Load older' }).click()
  await expect.poll(() => rows.count()).toBeGreaterThan(before)
  const seqs = (await rows.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-frame-seq')))))
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(seqs.length)
  expect(seqs[0]).toBeLessThan(oldestBefore)

  // Toggling off keeps the conversation; frames persist across a reload.
  await debug.click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('chat-transcript')).toContainText('Request accepted.')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Debug', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Debug', exact: true }).click()
  await expect(rows.last()).toHaveAttribute('data-frame-seq', String(seqs.at(-1)))
  await expect(rows).toHaveCount(200)
})

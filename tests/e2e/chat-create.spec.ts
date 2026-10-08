import { expect, test, type Page } from '@playwright/test'

// New Session dialog → Claude chat create form. These checks need no chat
// fixture: the form's own validation runs in the browser, and a create the
// server refuses (this harness pins auth empty) is exactly the "nothing
// happened" failure that must surface visible feedback.

const CREATION_ERROR = /Chat sessions need Claude authentication/i

async function openChatCreateDialog(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Session kind').selectOption('chat')
  return dialog
}

function trackCreations(page: Page) {
  const creations: Array<{ kind?: string; name?: string; projectPath?: string }> = []
  const errors: string[] = []
  page.on('websocket', socket =>
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'session-create') {
        creations.push({ kind: message.kind, name: message.name, projectPath: message.projectPath })
      }
    })
  )
  page.on('websocket', socket =>
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'error') errors.push(String(message.message))
    })
  )
  return { creations, errors }
}

test('chat kind hides terminal-only fields and restores them', async ({ page }, info) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  // Claude chat is the default kind: terminal-only fields start hidden.
  await expect(dialog.getByLabel('Session kind')).toHaveValue('chat')
  await expect(dialog.getByTestId('command-select')).toHaveCount(0)
  await expect(dialog.getByTestId('host-select')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('chat-create-modal.png') })

  await dialog.getByLabel('Session kind').selectOption('terminal')
  await expect(dialog.getByTestId('command-select')).toBeVisible()

  await dialog.getByLabel('Session kind').selectOption('chat')
  await expect(dialog.getByTestId('command-select')).toHaveCount(0)
})

test('empty project path refuses create with inline validation', async ({ page }) => {
  const { creations } = trackCreations(page)
  const dialog = await openChatCreateDialog(page)

  // Force the empty state regardless of any prefilled default.
  await dialog.locator('input').first().fill('')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(dialog.getByTestId('project-path-error')).toHaveText(
    'Enter a project path to create the session.'
  )
  // The dialog stays up and nothing is sent: Create is not a silent no-op.
  await expect(dialog).toBeVisible()
  expect(creations).toEqual([])

  // Typing clears the refusal so the user can proceed.
  await dialog.locator('input').first().fill('/tmp')
  await expect(dialog.getByTestId('project-path-error')).toHaveCount(0)
})

test('a create the server refuses surfaces the reason', async ({ page }) => {
  const { creations, errors } = trackCreations(page)
  const dialog = await openChatCreateDialog(page)

  await dialog.locator('input').first().fill(process.cwd())
  await dialog.locator('input').last().fill('Refused chat')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()

  // The request is well-formed and does leave the browser…
  await expect.poll(() => creations).toEqual([
    { kind: 'chat', name: 'Refused chat', projectPath: process.cwd() },
  ])
  // …and the refusal is visible rather than dropped on the floor.
  await expect.poll(() => errors).toHaveLength(1)
  expect(errors[0]).toMatch(CREATION_ERROR)
  await expect(page.getByText(CREATION_ERROR)).toBeVisible()
  await expect(page.locator('[data-session-id]', { hasText: 'Refused chat' })).toHaveCount(0)
})

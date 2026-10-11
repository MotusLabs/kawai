// Settings Save must persist provider drafts before closing the modal.
import { expect, test } from '@playwright/test'

const endpoint = '/api/settings/chat-provider-env'

test.describe('provider settings Save', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ request }) => {
    const response = await request.put(endpoint, {
      data: { env: { ANTHROPIC_MODEL: 'before', ANTHROPIC_AUTH_TOKEN: 'test-secret' } },
    })
    expect(response.ok()).toBe(true)
  })

  test.afterEach(async ({ request }) => {
    await request.delete(endpoint)
  })

  test('persists edits and preserves credentials across a page reload', async ({ page, request }, info) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await page.getByLabel('Value for ANTHROPIC_MODEL', { exact: true }).fill('after')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-provider-settings')).toHaveCount(0)

    const stored = await (await request.get(endpoint)).json()
    expect(stored.env.ANTHROPIC_MODEL).toBe('after')
    expect(stored.redacted).toContain('ANTHROPIC_AUTH_TOKEN')
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await expect(page.getByLabel('Value for ANTHROPIC_MODEL', { exact: true })).toHaveValue('after')
    await expect(page.getByLabel('Value for ANTHROPIC_AUTH_TOKEN', { exact: true })).toHaveAttribute('placeholder', 'Stored — leave blank to keep')
    await page.getByTestId('chat-provider-settings').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('provider-saved.png') })
  })

  test('keeps failed edits open and allows retry', async ({ page }, info) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    await page.getByLabel('Value for ANTHROPIC_MODEL', { exact: true }).fill('retry-model')
    await page.route(endpoint, async route => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 500, json: { error: 'Unable to persist chat provider environment' } })
      } else {
        await route.continue()
      }
    })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-provider-error')).toHaveText('Unable to persist chat provider environment')
    await expect(page.getByLabel('Value for ANTHROPIC_MODEL', { exact: true })).toHaveValue('retry-model')
    await page.getByTestId('chat-provider-settings').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('provider-save-error.png') })
    await page.unroute(endpoint)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-provider-settings')).toHaveCount(0)
  })
})

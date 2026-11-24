// Settings Save must send typed credential drafts before closing the modal,
// and the write-only editor never shows a stored value back
// (provider-credential-store A2/P2). Synthetic values only, through the
// development chat fixture's isolated data (V5): the ordinary pass skips it.
import { expect, test } from '@playwright/test'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

const endpoint = '/api/settings/credentials'
const NAME = 'PCS_E2E_MODEL'
const VALUE = 'pcs-e2e-synthetic-value'

async function openChatSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await expect(page.getByTestId('chat-provider-settings')).toBeVisible()
}

test.describe('provider settings Save', () => {
  test.describe.configure({ mode: 'serial' })

  test.afterEach(async ({ request }) => {
    await request.delete(`${endpoint}/${NAME}`)
  })

  test('saves a typed value and lists set/source metadata with an empty editor after reload', async ({ page, request }, info) => {
    await page.goto('/')
    await openChatSettings(page)
    await page.getByLabel('New variable name', { exact: true }).fill(NAME)
    await page.getByLabel('New variable value', { exact: true }).fill(VALUE)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-provider-settings')).toHaveCount(0)

    const response = await request.get(endpoint)
    const text = await response.text()
    expect(text).not.toContain(VALUE)
    const row = (JSON.parse(text) as { rows: { name: string; state: string; source: string; kind: string }[] }).rows.find(r => r.name === NAME)
    expect(row).toMatchObject({ state: 'set', source: 'store', kind: 'launch-env' })

    await page.reload()
    await openChatSettings(page)
    await expect(page.getByTestId(`credential-row-${NAME}`)).toContainText('set')
    await expect(page.getByTestId(`credential-row-${NAME}`)).toContainText('Saved here')
    await expect(page.getByLabel(`New value for ${NAME}`, { exact: true })).toHaveValue('')
    await expect(page.getByTestId('chat-provider-settings')).not.toContainText(VALUE)
    await page.getByTestId('chat-provider-settings').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('provider-saved.png') })
  })

  test('keeps a failed draft open and allows retry', async ({ page, request }, info) => {
    await page.goto('/')
    await openChatSettings(page)
    await page.getByLabel('New variable name', { exact: true }).fill(NAME)
    await page.getByLabel('New variable value', { exact: true }).fill(VALUE)
    const failure = 'The user credential store could not be written; the previous contents stand.'
    await page.route(`**${endpoint}/*`, async route => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 500, json: { code: 'write-failed', error: failure } })
      } else {
        await route.continue()
      }
    })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-provider-error')).toHaveText(failure)
    await expect(page.getByLabel('New variable name', { exact: true })).toHaveValue(NAME)
    await expect(page.getByLabel('New variable value', { exact: true })).toHaveValue(VALUE)
    await page.getByTestId('chat-provider-settings').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('provider-save-error.png') })
    await page.unroute(`**${endpoint}/*`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-provider-settings')).toHaveCount(0)
    const listing = await (await request.get(endpoint)).json() as { rows: { name: string; state: string }[] }
    expect(listing.rows.find(r => r.name === NAME)).toMatchObject({ state: 'set' })
  })
})

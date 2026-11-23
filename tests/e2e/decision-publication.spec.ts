import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChat } from './fixtures/planWalkthrough'
import type { ClientMessage, ServerMessage } from '../../src/shared/types'
import { cleanGitEnv } from '../../src/server/git/gitCommand'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

interface Seed {
  planId: string
  cards: Array<{ cardId: string; taskId: string; question: string }>
}

function seed(repo: string, lead: string): Seed {
  const stdout = execFileSync('bun', ['tests/e2e/fixtures/decisionPublicationSeed.ts'], {
    input: JSON.stringify({ repo, lead }), encoding: 'utf8',
  })
  const marker = 'PUBLICATION_SEED '
  const result = stdout.split('\n').find(line => line.startsWith(marker))
  if (!result) throw new Error('No isolated decision publication fixture was written')
  return JSON.parse(result.slice(marker.length)) as Seed
}

test('W10 Plans reviews the bound edit and recovers a committed approval after its reply is lost', async ({ page }) => {
  const repo = mkdtempSync(join(tmpdir(), 'kawai-browser-decision-publication-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env: cleanGitEnv() })
  git(['init', '-q'])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'base'])
  mkdirSync(join(repo, '.kawai/groups'), { recursive: true })
  writeFileSync(join(repo, '.kawai/groups/leads.md'), '---\nlabel: Leads\ncanCreateTasks: true\n---\nPrepare export directions')
  let suppressReceipt = false
  let lostResult = false
  let approvals = 0
  await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(message => {
      if (typeof message === 'string' && (JSON.parse(message) as ClientMessage).type === 'team-plan-approve-publication') approvals++
      server.send(message)
    })
    server.onMessage(message => {
      if (suppressReceipt && typeof message === 'string') {
        const frame = JSON.parse(message) as ServerMessage
        if (frame.type === 'team-plan-detail' && frame.detail.decisions?.some(view => view.publication?.receipt)) return
        if (frame.type === 'team-plan-result' && frame.publication) {
          suppressReceipt = false
          lostResult = true
          socket.close({ code: 1012, reason: 'Fixture drops the committed reply' })
          server.close()
          return
        }
      }
      socket.send(message)
    })
  })
  try {
    await page.goto('/')
    const lead = await createChat(page, repo, 'Publication Lead', 'leads')
    const { cards: [first, second] } = seed(repo, lead)
    await page.evaluate(team => { window.location.hash = `#/team/${encodeURIComponent(team)}` }, repo)
    const attention = page.getByTestId('attention-human')
    await attention.getByTestId('attention-item').filter({ hasText: first!.question }).getByTestId('attention-action').click()
    const card = page.locator(`#decision-card-${first!.cardId}`)
    await expect(card).toBeFocused()
    await card.getByRole('button', { name: 'Review prepared publication…' }).click()
    const review = card.getByRole('group', { name: 'Prepared task publication' })
    await expect(review.getByRole('region', { name: 'Before', exact: true })).toContainText('Base direction for approved')
    await expect(review.getByRole('region', { name: 'After publication' })).toContainText('Prepared direction for approved')
    await expect(review.getByText('The first row contains headers.', { exact: false })).toHaveCount(2)
    await expect(review).toContainText('src/export.ts')
    await review.getByLabel('Owner rationale (optional)').fill('Reviewed in the browser')
    suppressReceipt = true
    await review.getByRole('button', { name: 'Approve and publish', exact: true }).click()
    await expect.poll(() => lostResult).toBe(true)
    await expect(card.getByTestId('plan-publication-receipt')).toContainText('Published task revision 2')
    expect(approvals).toBe(1)
    await page.reload()
    await expect(card.getByTestId('plan-publication-receipt')).toContainText('Published task revision 2')
    await card.getByText('Published task revision 2', { exact: true }).click()
    await expect(card.getByText('Requester message', { exact: true })).toBeVisible()

    const stale = page.locator(`#decision-card-${second!.cardId}`)
    await stale.getByRole('button', { name: 'Review prepared publication…' }).click()
    const staleReview = stale.getByRole('group', { name: 'Prepared task publication' })
    const confirm = staleReview.getByRole('button', { name: 'Approve and publish', exact: true })
    await expect(confirm).toBeEnabled()
    // An independent human connection advances the base with the same contract.
    const advanced = await page.evaluate(async ({ teamPath, taskId }) => {
      const address = new URL('/ws', location.href)
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:'
      const connection = new WebSocket(address)
      return new Promise<Extract<ServerMessage, { type: 'team-task-result' }>>((resolve, reject) => {
        connection.addEventListener('error', reject, { once: true })
        connection.addEventListener('open', () => connection.send(JSON.stringify({
          type: 'team-task-publish', teamPath, taskId, baseRevision: 1, requestId: 'intervening',
          requestKey: 'intervening-publication', direction: 'Independent direction', rationale: 'Move the base', notify: false,
        } satisfies ClientMessage)), { once: true })
        connection.addEventListener('message', event => {
          const response = JSON.parse(event.data) as ServerMessage
          if (response.type !== 'team-task-result' || response.requestId !== 'intervening') return
          connection.close()
          resolve(response)
        })
      })
    }, { teamPath: repo, taskId: second!.taskId })
    expect(advanced.error).toBeUndefined()
    expect(advanced.revision).toBe(2)
    await confirm.click()
    await expect(staleReview.getByRole('alert')).toContainText('base moved from revision 1 to 2')
    await expect(confirm).toBeDisabled()
    await expect(stale.getByRole('button', { name: 'Answer without publishing…' })).toBeEnabled()
    await expect(stale.getByTestId('plan-publication-receipt')).toHaveCount(0)
    expect(approvals).toBe(2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

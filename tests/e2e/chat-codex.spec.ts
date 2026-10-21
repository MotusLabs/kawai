// Codex chat e2e (codex-chat-sessions 8.1): under the fixture a Codex chat
// runs the real app-server driver against the fake app-server through
// KAWAI_CODEX_PATH (the codexGatesApply carve-out) — creation gates on the
// fake's version and the config's fake login, a manual approval card
// round-trips, a blocking question card answers, and a team-mailbox peer
// message delivers live: the human composer sends direct mail to the idle
// chat, the driver delivers the envelope as a peer turn, and the peer row
// renders. (The rollout replay of a peer turn is unit-covered —
// codexRollout.test.ts — but unreachable in one server life: the history
// memo never re-reads a rollout once live events exist, so this spec drives
// the live delivery path instead.)
import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Script, THREAD_ID } from '../../tests/fixtures/codexTranscript'
import { killChat } from './support/chatHeader'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

const COMMAND = { type: 'commandExecution', id: 'cmd-1', command: 'git push origin', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null }

test('a Codex chat drives the app-server: approval card, question card, and a live peer turn', async ({ page }, info) => {
  const project = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'agentboard-e2e-codex-')))
  try {
    await mkdir(path.join(project, '.kawai'), { recursive: true })
    // Codex entries are legal at project level; only codexHome/network are
    // trusted-tier, so this entry names neither — the server's CODEX_HOME
    // (the temporary codexDir with its fake auth.json) applies.
    await writeFile(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      codex: { label: 'Codex E2E', runtime: 'codex' },
    }))
    // The rollout the boot reports — the bare append after the peer turn
    // writes the envelope row there, so the delivery receipt can confirm.
    const rollout = path.join(process.env.E2E_TMUX_TMPDIR ?? os.tmpdir(), 'codex-e2e-rollout.jsonl')
    // Run 1: boot + the 7.1 rate-limits fill read, the approval turn, the
    // question turn, then the live peer delivery's turn (ct-3).
    const script = new Script()
      .boot('thread/start', 'gpt-test', rollout)
      .request('account/rateLimits/read', {})
      .turn('ct-1')
      .item('started', 'ct-1', COMMAND)
      .serverRequest(100, 'item/commandExecution/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'cmd-1', command: 'git push origin', reason: 'network' })
      .item('completed', 'ct-1', { ...COMMAND, status: 'completed', exitCode: 0 })
      .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: 'approved and ran', questions: null })
      .completed('ct-1')
      .turn('ct-2')
      .serverRequest(101, 'item/tool/requestUserInput', {
        threadId: THREAD_ID, turnId: 'ct-2', itemId: 'q-item',
        questions: [{ id: 'q1', header: 'Branch', question: 'Which branch?', options: [{ label: 'alpha', description: 'first' }, { label: 'beta' }] }],
      })
      .item('completed', 'ct-2', { type: 'agentMessage', id: 'msg-2', text: 'answered: beta', questions: null })
      .completed('ct-2')
      .turn('ct-3')
      // Without a line the fake writes the rollout user row of the latest
      // turn/start input — the delivered envelope, carrying the message id.
      .append(rollout)
      .completed('ct-3')
    // Script.write picks a random name; the fake reads FAKE_TRANSCRIPT.
    await writeFile(process.env.FAKE_TRANSCRIPT!, script.lines.map(line => JSON.stringify(line)).join('\n') + '\n')

    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New Session' })
    await dialog.getByLabel('Session kind').selectOption('chat')
    await dialog.getByLabel('Project Path').fill(project)
    const profile = dialog.getByLabel('Profile')
    await expect(profile.locator('option', { hasText: 'Codex E2E' })).toHaveCount(1)
    await profile.selectOption('codex')
    await dialog.getByLabel('Display Name').fill('Codex e2e chat')
    await page.screenshot({ path: info.outputPath('codex-create.png') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-profile')).toHaveText('Codex · Codex E2E')

    // Turn 1: the manual command approval card round-trips.
    await page.getByLabel('Message Claude').fill('push it')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const allow = page.getByRole('button', { name: 'Allow', exact: true })
    await expect(allow).toBeVisible()
    await page.screenshot({ path: info.outputPath('codex-approval.png') })
    await allow.click()
    await expect(page.getByTestId('chat-transcript')).toContainText('approved and ran')

    // Turn 2: the blocking question card answers by checkbox.
    await page.getByLabel('Message Claude').fill('which branch')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByLabel('beta', { exact: true }).check()
    await page.getByRole('button', { name: 'Submit answers' }).click()
    await expect(page.getByTestId('chat-transcript')).toContainText('answered: beta')

    // The peer turn: the chat's plain-directory team is the project itself,
    // so its Messages tab composes direct mail to the idle chat.
    await page.evaluate(team => { window.location.hash = `#/team/${encodeURIComponent(team)}/messages` }, project)
    const messages = page.getByTestId('team-messages')
    await expect(messages).toBeVisible()
    const composer = messages.getByTestId('message-composer')
    // The recipient select is disabled until the body has text.
    await composer.getByLabel('Message body').fill('Peer hello from the team mailbox.')
    await composer.getByLabel('Recipient').selectOption({ label: 'Codex e2e chat' })
    await page.screenshot({ path: info.outputPath('codex-compose.png') })
    await composer.getByRole('button', { name: 'Send message' }).click()

    // Back to the chat (the team route is one history entry) for the live
    // peer row — the driver delivered the envelope as a peer turn.
    await page.goBack()
    await expect(page.getByTestId('chat-transcript')).toBeVisible()
    await expect(page.locator('[data-chat-role="peer"]').last()).toContainText('Peer hello from the team mailbox.')
    await page.screenshot({ path: info.outputPath('codex-peer-live.png') })
    await killChat(page)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

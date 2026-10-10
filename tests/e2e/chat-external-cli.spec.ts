import { expect, test } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Chat regression against the externally installed Claude Code executable.
// Everything runs against a loopback mock Anthropic endpoint with a
// synthetic key: no credentials, no live provider, no cost. Opt-in because
// it needs `claude` on PATH (CI does not install one):
//   KAWAI_EXTERNAL_CLI_TEST=1 bunx playwright test tests/e2e/chat-external-cli.spec.ts
// Set KAWAI_PRECHANGE_CLAUDE_PATH to the SDK's formerly bundled CLI (2.1.289,
// e.g. a pre-change checkout's node_modules/@anthropic-ai/claude-agent-sdk-
// linux-x64/claude) to create the conversation on the pre-change runtime and
// resume it on the PATH executable after the restart.
const claudeOnPath = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout?.trim()
test.skip(
  process.env.KAWAI_EXTERNAL_CLI_TEST !== '1' || !claudeOnPath,
  'Opt-in test requires KAWAI_EXTERNAL_CLI_TEST=1 and claude on PATH'
)

/** Loopback Anthropic endpoint; behavior is keyed by the last user text. */
function startMock(markerAllow: string, markerDeny: string) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      const messages = (body.messages ?? []) as Array<{ role?: string; content: unknown }>
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const content = lastUser?.content
      const lastUserText =
        typeof content === 'string'
          ? content
          : JSON.stringify(content ?? '')
      // Only the newest message matters: earlier turns' tool_results stay in history.
      const hasToolResult = JSON.stringify(messages.at(-1)?.content ?? '').includes('"tool_result"')
      const sseHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
      const writeSse = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      const text = (chunks_: string[], stopReason: string) => {
        res.writeHead(200, sseHeaders)
        writeSse('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        writeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (const piece of chunks_) {
          writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
        }
        writeSse('content_block_stop', { type: 'content_block_stop', index: 0 })
        writeSse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
        writeSse('message_stop', { type: 'message_stop' })
        res.end()
      }
      const toolUse = (name: string, input: Record<string, unknown>) => {
        res.writeHead(200, sseHeaders)
        writeSse('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        writeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tool_${Date.now()}`, name, input: {} } })
        writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
        writeSse('content_block_stop', { type: 'content_block_stop', index: 0 })
        writeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
        writeSse('message_stop', { type: 'message_stop' })
        res.end()
      }
      if (!hasToolResult && lastUserText.includes('run the marker command')) {
        return toolUse('Bash', { command: `echo ran > ${markerAllow}`, description: 'Write the allow marker' })
      }
      if (!hasToolResult && lastUserText.includes('run the forbidden command')) {
        return toolUse('Bash', { command: `echo ran > ${markerDeny}`, description: 'Write the deny marker' })
      }
      if (!hasToolResult && lastUserText.includes('ask me a question')) {
        return toolUse('AskUserQuestion', {
          questions: [{
            question: 'Tea or coffee?', header: 'Drink', multiSelect: false,
            options: [{ label: 'Tea', description: 'A cup of tea' }, { label: 'Coffee', description: 'A cup of coffee' }],
          }],
        })
      }
      if (!hasToolResult && lastUserText.includes('write slowly')) {
        // Delayed deltas so the UI can observe streaming and Stop mid-turn.
        res.writeHead(200, sseHeaders)
        writeSse('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        writeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        let index = 0
        const pieces = ['Slowly ', 'streaming ', 'the ', 'external ', 'answer.']
        const tick = () => {
          if (res.destroyed) return
          if (index < pieces.length) {
            writeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: pieces[index] } })
            index += 1
            setTimeout(tick, 700)
          } else {
            writeSse('content_block_stop', { type: 'content_block_stop', index: 0 })
            writeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
            writeSse('message_stop', { type: 'message_stop' })
            res.end()
          }
        }
        setTimeout(tick, 300)
        return
      }
      return text(['ack'], 'end_turn')
    })
  })
  return {
    listen: () => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function readChatSessions(dbPath: string): Array<{ session_id: string; sdk_session_id: string | null }> {
  const result = spawnSync('bun', ['-e', [
    'import { Database } from "bun:sqlite"',
    `const db = new Database(process.env.DB_PATH!, { readonly: true })`,
    'console.log(JSON.stringify(db.query("select session_id, sdk_session_id from chat_sessions").all()))',
  ].join('\n')], { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' })
  return JSON.parse(result.stdout)
}

test('external CLI chat: streaming, approvals, question, interrupt, debug, resume, kill, missing-executable error', async ({ page }, info) => {
  test.setTimeout(360_000)
  const root = mkdtempSync(join(tmpdir(), 'kawai-external-cli-'))
  const project = join(root, 'project')
  const claudeConfig = join(root, 'claude-config')
  const markerAllow = join(root, 'marker-allow.txt')
  const markerDeny = join(root, 'marker-deny.txt')
  mkdirSync(project)
  mkdirSync(claudeConfig)
  const mock = startMock(markerAllow, markerDeny)
  const mockPort = await mock.listen()
  const port = process.env.KAWAI_EXTERNAL_CLI_PORT || '4191'
  const url = `http://127.0.0.1:${port}`
  const dbPath = join(root, 'agentboard.db')
  const serverEnv = (extra: Record<string, string | undefined>) => ({
    ...process.env,
    NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '0',
    PORT: port, HOSTNAME: '127.0.0.1',
    AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client'),
    AGENTBOARD_DB_PATH: dbPath,
    LOG_FILE: join(root, 'agentboard.log'),
    TMUX_TMPDIR: root, TMUX: '', TMUX_SESSION: 'kawai-external-cli',
    AGENTBOARD_TMUX_PID_FILE: join(root, 'tmux.pid'),
    CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: join(root, 'codex'), PI_HOME: join(root, 'pi'),
    AGENTBOARD_REMOTE_HOSTS: '',
    AGENTBOARD_CHAT_ENV: `ANTHROPIC_BASE_URL=http://127.0.0.1:${mockPort}/probe;ANTHROPIC_API_KEY=synthetic-external-cli-key`,
    ...extra,
  })
  let server: ChildProcess | null = null
  let diagnostics = ''
  const start = async (extra: Record<string, string | undefined> = {}) => {
    server = spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), env: serverEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000) })
    server.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000) })
    await expect.poll(async () => {
      try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false }
    }, { timeout: 30_000 }).toBe(true)
  }
  const stop = async () => {
    if (!server || server.exitCode !== null) return
    const stopped = new Promise<void>(resolve => server!.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await stopped
    server = null
  }
  const send = async (text: string) => {
    await page.getByLabel('Message Claude').fill(text)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
  }
  const seenEvents: string[] = []
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'chat-events') for (const event of message.events) seenEvents.push(`${event.sequence}:${event.type}`)
      if (message.type === 'chat-snapshot') seenEvents.push(`snapshot-through:${message.throughSequence}`)
      if (message.type === 'error') seenEvents.push(`server-error:${message.message}`)
    } catch { /* non-JSON frame */ }
  }))
  const transcript = page.getByTestId('chat-transcript')
  const prechangeClaude = process.env.KAWAI_PRECHANGE_CLAUDE_PATH
  try {
    await start(prechangeClaude ? { KAWAI_CLAUDE_PATH: prechangeClaude } : {})
    await page.goto(url)
    await expect(page.getByRole('button', { name: 'New session', exact: true }).first()).toBeVisible()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const modal = page.getByRole('dialog', { name: 'New Session' })
    await modal.getByLabel('Session kind').selectOption('chat')
    await modal.getByLabel('Project Path').fill(project)
    await modal.locator('input').last().fill('External CLI check')
    await modal.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByTestId('chat-view')).toBeVisible()
    await page.screenshot({ path: info.outputPath('created.png') })

    // Each turn must finish before the next send: a message sent between a
    // turn's final text and its result folds into that turn (pre-existing
    // driver queue semantics), so gate on the completed-turn count.
    const completions = transcript.getByText(/^Turn complete ·/)
    const nextCompletion = async () => {
      const before = await completions.count()
      return () => expect(completions).toHaveCount(before + 1, { timeout: 60_000 })
    }

    // Streaming: delayed deltas land progressively.
    let completed = await nextCompletion()
    await send('please write slowly')
    await expect(transcript).toContainText('Slowly ', { timeout: 30_000 })
    await expect(transcript).toContainText('the external answer.', { timeout: 30_000 })
    await completed()
    await page.screenshot({ path: info.outputPath('streaming.png') })

    // Approval allow: the real Bash tool writes the marker file.
    completed = await nextCompletion()
    await send('run the marker command')
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('approval.png') })
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect.poll(() => existsSync(markerAllow), { timeout: 30_000 }).toBe(true)
    await completed()
    await expect(transcript).toContainText('Tool: Bash')
    await expect(transcript).toContainText('Request allowed')

    // Approval deny: the tool never runs.
    completed = await nextCompletion()
    await send('run the forbidden command')
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
    await completed()
    await expect(transcript).toContainText('Request denied')
    expect(existsSync(markerDeny)).toBe(false)
    await page.screenshot({ path: info.outputPath('denied.png') })

    // AskUserQuestion bridged through the question card.
    completed = await nextCompletion()
    await send('ask me a question')
    await page.getByRole('radio', { name: /^Tea/ }).check()
    await page.getByRole('button', { name: 'Submit answers' }).click()
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)
    await completed()
    await expect(transcript).toContainText('Request answered')
    await page.screenshot({ path: info.outputPath('question.png') })

    // Debug panel shows the live protocol frames of the external CLI.
    const debug = page.getByRole('button', { name: 'Debug', exact: true })
    await debug.click()
    const panel = page.getByTestId('chat-debug-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-frame-seq]').first()).toBeVisible()
    await expect(panel.getByText('control_request · can_use_tool').first()).toBeVisible()
    await expect(panel.getByText('result · success').last()).toBeVisible()
    await page.screenshot({ path: info.outputPath('debug-frames.png') })
    await debug.click()

    // Interrupt a slow turn.
    await send('please write slowly')
    await expect(transcript.getByText(/Slowly/)).toHaveCount(2, { timeout: 30_000 })
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(transcript).toContainText('Turn stopped', { timeout: 30_000 })
    await page.screenshot({ path: info.outputPath('interrupted.png') })

    // Restart the server: the conversation resumes with the same identity.
    const beforeRestart = readChatSessions(dbPath).find(() => true)
    expect(beforeRestart?.sdk_session_id).toBeTruthy()
    await stop()
    await start()
    await page.goto(url)
    await page.getByText('External CLI check', { exact: true }).first().click()
    await expect(page.getByTestId('chat-view')).toBeVisible()
    await expect(transcript).toContainText('run the marker command', { timeout: 30_000 })
    completed = await nextCompletion()
    await send('after restart')
    await completed()
    await expect(transcript).toContainText('after restart')
    const afterRestart = readChatSessions(dbPath).find(() => true)
    expect(afterRestart?.sdk_session_id).toBe(beforeRestart?.sdk_session_id)
    await page.screenshot({ path: info.outputPath('resumed.png') })
    const spawns = readFileSync(join(root, 'chat-wire', `${afterRestart!.session_id}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { dir: string; raw: string })
      .filter(frame => frame.dir === 'lifecycle').map(frame => JSON.parse(frame.raw) as { event: string; command?: string; args?: string[] })
      .filter(event => event.event === 'spawn')
    expect(spawns[0]!.command).toBe(prechangeClaude ?? claudeOnPath)
    const resumed = spawns.at(-1)!
    expect(resumed.command).toBe(claudeOnPath)
    expect(resumed.args).toContain(`--resume=${beforeRestart!.sdk_session_id}`)

    // Kill removes the session and its process.
    await page.getByRole('button', { name: 'Kill session', exact: true }).click()
    await expect(page.getByText('External CLI check', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('killed.png') })

    // Missing executable: creation fails with the actionable error.
    await stop()
    const strippedBin = join(root, 'stripped-bin')
    mkdirSync(strippedBin)
    // The Playwright worker runs under Node, so resolve the real bun binary.
    const bunPath = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim()
    symlinkSync(bunPath, join(strippedBin, 'bun'))
    await start({
      KAWAI_CLAUDE_PATH: '/nonexistent',
      PATH: `${strippedBin}:/usr/local/bin:/usr/bin:/bin`,
    })
    await page.goto(url)
    await expect(page.getByRole('button', { name: 'New session', exact: true }).first()).toBeVisible()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const errorModal = page.getByRole('dialog', { name: 'New Session' })
    await errorModal.getByLabel('Session kind').selectOption('chat')
    await errorModal.getByLabel('Project Path').fill(project)
    await errorModal.getByRole('button', { name: 'Create', exact: true }).click()
    // Creation errors surface in the app's error banner.
    await expect(page.getByText(/Claude Code executable not found at \/nonexistent\..*KAWAI_CLAUDE_PATH/)).toBeVisible()
    await page.screenshot({ path: info.outputPath('missing-executable.png') })
    expect(readChatSessions(dbPath)).toHaveLength(0)
  } catch (error) {
    console.error('server diagnostics:', diagnostics)
    console.error('ws events:', seenEvents.join(' '))
    throw error
  } finally {
    await stop()
    await mock.close()
    if (!process.env.KAWAI_EXTERNAL_CLI_KEEP) rmSync(root, { recursive: true, force: true })
    else console.error('KEEP_ROOT', root)
  }
})

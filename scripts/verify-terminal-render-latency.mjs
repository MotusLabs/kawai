// Reproducible rendered-echo verification under eight flooding tmux windows.
// Run after `bun run build`: bun scripts/verify-terminal-render-latency.mjs
// Private tmux server and application state; artifacts are retained under /tmp.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const seconds = Number(process.env.VERIFY_SECONDS ?? 60)
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('VERIFY_SECONDS must be positive')
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-render-latency-'))
const socketDir = path.join(artifacts, 'tmux')
fs.mkdirSync(socketDir, { mode: 0o700 })
for (const dir of ['claude/projects', 'codex/sessions', 'pi/agent/sessions']) {
  fs.mkdirSync(path.join(artifacts, dir), { recursive: true })
}
const env = { ...process.env, TMUX_TMPDIR: socketDir }
delete env.TMUX
const session = 'render-latency'
function tmux(args) {
  const result = Bun.spawnSync(['tmux', ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let server, browser
try {
  const flood = path.join(artifacts, 'flood.sh')
  fs.writeFileSync(flood, `#!/bin/sh\nwhile :; do\n  i=0\n  while [ "$i" -lt 24 ]; do\n    printf '\\033[32mFLOOD padding-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\\033[0m\\n'\n    i=$((i+1))\n  done\n  sleep 0.12\ndone\n`)
  tmux(['new-session', '-d', '-s', session, '-n', 'catwin', '-c', artifacts, '-x', '120', '-y', '40', 'cat'])
  for (let i = 1; i <= 8; i++) tmux(['new-window', '-t', session, '-n', `flood-${i}`, '-c', artifacts, 'sh', flood])
  for (const name of ['catwin', ...Array.from({ length: 8 }, (_, i) => `flood-${i + 1}`)]) {
    tmux(['set-option', '-w', '-t', `${session}:${name}`, 'automatic-rename', 'off'])
    tmux(['set-option', '-w', '-t', `${session}:${name}`, 'allow-rename', 'off'])
  }
  const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = reservation.port
  reservation.stop(true)
  const serverOutput = fs.openSync(path.join(artifacts, 'server.stdout.log'), 'w')
  server = Bun.spawn(['bun', 'src/server/index.ts'], {
    env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1', TMUX_SESSION: session,
      DISCOVER_PREFIXES: '', NODE_ENV: 'production', AGENTBOARD_STATIC_DIR: path.resolve('dist/client'),
      AGENTBOARD_TMUX_PID_FILE: path.join(artifacts, 'tmux-server.pid'),
      AGENTBOARD_REMOTE_HOSTS: '', AGENTBOARD_DB_PATH: path.join(artifacts, 'agentboard.db'), LOG_FILE: path.join(artifacts, 'agentboard.log'),
      LOG_LEVEL: 'debug', CLAUDE_CONFIG_DIR: path.join(artifacts, 'claude'),
      CODEX_HOME: path.join(artifacts, 'codex'), PI_HOME: path.join(artifacts, 'pi'),
    }, stdout: serverOutput, stderr: serverOutput,
  })
  fs.closeSync(serverOutput)
  const healthDeadline = Date.now() + 30000
  while (true) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break } catch { /* startup */ }
    if (Date.now() > healthDeadline) throw new Error('Server startup timed out')
    await sleep(100)
  }
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_PATH ??
      (fs.existsSync('/opt/playwright/chromium-1243/chrome-linux64/chrome')
        ? '/opt/playwright/chromium-1243/chrome-linux64/chrome' : chromium.executablePath()),
    args: ['--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(() => {
    // Timestamp the actual terminal-input send, on the browser's monotonic clock.
    const original = WebSocket.prototype.send
    window.__renderCheck = { inputs: [], samples: [], expected: '', consumed: 0 }
    WebSocket.prototype.send = function(data) {
      try {
        const message = JSON.parse(data)
        if (message.type === 'terminal-input' && /^[a-zA-Z0-9]+$/.test(message.data)) {
          const state = window.__renderCheck
          state.expected += message.data
          state.inputs.push({ t: performance.now(), expected: state.expected.slice(-24) })
        }
      } catch { /* non-protocol send */ }
      return original.call(this, data)
    }
  })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${port}`)
  await page.getByTestId('session-card').filter({ hasText: 'catwin' }).click()
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' })
  await sleep(1500)
  await page.evaluate(() => {
    // Discover the mounted xterm ref through React's DOM fiber, without adding
    // instrumentation to shipped code. Fail explicitly if React changes shape.
    let terminal
    for (const node of document.querySelectorAll('*')) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
      for (let fiber = key && node[key]; fiber && !terminal; fiber = fiber.return) {
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const value = hook.memoizedState?.current
          if (value?.buffer?.active && typeof value.onRender === 'function' && typeof value.write === 'function') {
            terminal = value
            break
          }
        }
      }
      if (terminal) break
    }
    if (!terminal) throw new Error('Mounted xterm ref not found')
    const state = window.__renderCheck
    terminal.onRender(() => {
      const buffer = terminal.buffer.active
      let text = ''
      // Concatenate the visible lines so wrapping does not break echo matching.
      for (let i = buffer.viewportY; i < buffer.viewportY + terminal.rows; i++) {
        text += buffer.getLine(i)?.translateToString(true) ?? ''
      }
      state.renderText = text
      let index = state.consumed
      while (index < state.inputs.length && text.includes(state.inputs[index].expected)) index++
      if (index === state.consumed) return
      const observed = state.inputs.slice(state.consumed, index)
      state.consumed = index
      // onRender means xterm drew the changed rows. The next animation frame
      // includes a browser paint opportunity after that draw (a conservative
      // observable bound, not a claim about physical display scanout).
      requestAnimationFrame(() => {
        for (const input of observed) state.samples.push(performance.now() - input.t)
      })
    })
  })
  await page.locator('.xterm-helper-textarea').focus()
  const count = Math.ceil(seconds * 1000 / 115)
  // A deterministic nonrepeating suffix prevents an old alphabet cycle from
  // being mistaken for a newly rendered echo.
  let seed = 123456789
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const chars = Array.from({ length: count }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return alphabet[seed % alphabet.length]
  }).join('')
  await page.keyboard.type(chars, { delay: 115 })
  await page.waitForFunction(() => window.__renderCheck.samples.length === window.__renderCheck.inputs.length,
    null, { timeout: 5000 }).catch(() => {})
  const result = await page.evaluate(() => {
    const state = window.__renderCheck
    const sorted = [...state.samples].sort((a, b) => a - b)
    const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1] ?? null
    return { typed: state.inputs.length, rendered: sorted.length, p50Ms: percentile(.5),
      p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null,
      expected: state.inputs.at(-1)?.expected, renderText: state.renderText,
      nextExpected: state.inputs[state.consumed]?.expected }
  })
  await page.screenshot({ path: path.join(artifacts, 'terminal.png') })
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ artifacts, seconds, ...result }, null, 2))
  if (result.typed !== result.rendered || result.p95Ms > 150 || result.maxMs > 400) {
    throw new Error('Rendered-echo latency target failed')
  }
} finally {
  await browser?.close()
  if (server) { server.kill(); await server.exited }
  try { tmux(['kill-server']) } catch { /* already stopped */ }
}

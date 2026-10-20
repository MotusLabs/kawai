// Bundled SDK smoke check: all routing is loopback and credentials are synthetic.
// The second run drives a credentialed provider (openrouter-provider D3): its
// named token must reach the gateway as the bearer, with no x-api-key, even
// though the server and project settings both carry an API key.
// The third section probes which transport variables Claude Code applies from
// the flag layer's settings.env, against loopback gateways only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mockMessageResponse } from './lib/claudeProfileMock'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeProfile } from '../src/server/chat/ClaudeProfiles'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-smoke-'))
const captured: Record<string, unknown>[] = []
const headers: { authorization: string | null; apiKey: string | null }[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 })
  const body = await req.json() as Record<string, unknown>
  captured.push(body)
  headers.push({ authorization: req.headers.get('authorization'), apiKey: req.headers.get('x-api-key') })
  return mockMessageResponse(body)
} })
const configDir = path.join(dir, 'config')
const projectDir = path.join(dir, 'project')
fs.mkdirSync(configDir)
fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true })
const conflict = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'conflicting-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'conflicting-alias' }, model: 'conflicting-model', outputStyle: 'Explanatory' }
fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(conflict))
fs.writeFileSync(path.join(projectDir, '.claude/settings.json'), JSON.stringify(conflict))
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 25000)
const launch = resolveClaudeProfile('glm-flash', {
  CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'synthetic-test-key',
  CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDECODE: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}, { homeDir: path.join(dir, 'no-home') })
// Substitute only routing so the catalog's model/alias/settings precedence is
// exercised without contacting the real gateway.
const baseUrl = `http://127.0.0.1:${server.port}`
launch.env!.ANTHROPIC_BASE_URL = baseUrl
if (typeof launch.settings === 'object') launch.settings.env!.ANTHROPIC_BASE_URL = baseUrl
const options = (run: typeof launch) => ({
  ...run, cwd: projectDir, settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
  permissionMode: 'default' as const, canUseTool: async () => ({ behavior: 'deny' as const, message: 'Smoke test' }),
  abortController: controller, maxTurns: 1,
})
const stream = query({ prompt: 'Reply with verified.', options: options(launch) })
let credentialed: ReturnType<typeof query> | undefined
try {
  const init = await stream.initializationResult()
  console.log('Project output style:', init.output_style)
  for await (const event of stream) {
    if (event.type === 'result') console.log('Result:', event.subtype)
  }
  if (!captured.some((body) => String(body.model).startsWith('glm-5.3-flash'))) throw new Error('Profile Sonnet alias did not reach loopback provider')
  if (init.output_style !== 'Explanatory') throw new Error('Unrelated project output style did not load')
  console.log('Verified routing, startup model, alias mapping, and unrelated project settings')

  // A user-level credentialed provider routed to the loopback mock.
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    mockor: {
      label: 'Mock OR', authTokenEnv: 'MOCK_OR_KEY', balanceKeyEnv: 'MOCK_OR_MANAGEMENT_KEY',
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_DEFAULT_SONNET_MODEL: 'mock-or-sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mock-or-haiku', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mock-or-opus', ANTHROPIC_DEFAULT_FABLE_MODEL: 'mock-or-opus' },
      models: { 'mockor-sonnet': { model: 'sonnet' } },
    },
  }))
  fs.writeFileSync(path.join(projectDir, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'synthetic-project-key' } }))
  const orLaunch = resolveClaudeProfile('mockor-sonnet', {
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'synthetic-test-key',
    MOCK_OR_KEY: 'synthetic-or-token', MOCK_OR_MANAGEMENT_KEY: 'synthetic-or-management',
    CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, { homeDir: home })
  for (const name of ['MOCK_OR_KEY', 'MOCK_OR_MANAGEMENT_KEY']) {
    if (orLaunch.env && name in orLaunch.env) throw new Error(`${name} reached the agent environment`)
  }
  const before = headers.length
  credentialed = query({ prompt: 'Reply with verified.', options: options(orLaunch) })
  for await (const event of credentialed) {
    if (event.type === 'result') console.log('Credentialed result:', event.subtype)
  }
  const seen = headers.slice(before)
  if (seen.length === 0) throw new Error('Credentialed provider sent no message request')
  if (!seen.every((h) => h.authorization === 'Bearer synthetic-or-token')) throw new Error('Named token did not reach the gateway as the bearer')
  if (seen.some((h) => h.apiKey !== null)) throw new Error('An x-api-key header reached the credentialed gateway')
  console.log('Verified credentialed provider: bearer token from its named variable, no x-api-key, key variables withheld')
} finally {
  clearTimeout(timer)
  controller.abort()
  stream.close()
  credentialed?.close()
  server.stop(true)
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- Transport-variable probe (openrouter-provider D3) ---------------------
// Which transport variables Claude Code applies from the flag layer's
// settings.env. Each case mutates only the resolved launch: the value rides
// in settings.env with the variable deleted from the process env, so an
// observation says the settings layer alone routed the request. Loopback
// gateways only; the synthetic token from the second run.
type TransportCase = {
  name: string
  scheme: 'http' | 'https'
  settingsEnv: Record<string, string>
  deleteFromEnv: string[]
  serverEnv?: Record<string, string>
  /** Proxy observation expected for the request to count as routed. */
  expectProxy: 'connect' | 'absolute' | 'none'
  /** When false the case only reports; a failed run is the expected outcome. */
  expectSuccess: boolean
}

/** A minimal recording HTTP proxy: CONNECT tunnels and absolute-form requests. */
function startRecordProxy(): { url: string; seen: string[]; stop: () => void } {
  const seen: string[] = []
  const pending = new Map<object, Buffer>()
  const tunnels = new Map<object, { upstream: { write: (d: Uint8Array) => unknown; end: () => void } }>()
  const server = Bun.listen<{ upstream?: unknown }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        const tunnel = tunnels.get(socket)
        if (tunnel) {
          tunnel.upstream.write(chunk)
          return
        }
        // Buffer arithmetic throughout: content-length counts bytes, and a
        // utf8-decoded string's length counts characters, so any multi-byte
        // body byte would wait forever.
        const text = Buffer.concat([pending.get(socket) ?? Buffer.alloc(0), chunk])
        const headEnd = text.indexOf('\r\n\r\n')
        if (headEnd === -1) {
          pending.set(socket, text)
          return
        }
        const head = text.slice(0, headEnd).toString()
        const requestLine = head.split('\r\n')[0] ?? ''
        if (requestLine.startsWith('CONNECT')) {
          const target = requestLine.split(' ')[1] ?? ''
          seen.push(requestLine)
          pending.delete(socket)
          const [host, port] = target.split(':')
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
          Bun.connect({
            hostname: host || '127.0.0.1',
            port: Number(port) || 443,
            socket: {
              data(_, upChunk) { socket.write(upChunk) },
              error() { socket.end() },
              close() { socket.end() },
            },
          }).then(upstream => {
            tunnels.set(socket, { upstream })
          }).catch(() => socket.end())
          return
        }
        // Absolute-form request: wait until the declared body is fully
        // received, then forward it and relay the whole response, so the
        // client gets an exact content-length (fetch already decoded any
        // transfer encoding, and a bare EOF framing reads as a broken body).
        const lines = head.split('\r\n')
        const headers: Record<string, string> = {}
        let contentLength = 0
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          const name = line.slice(0, colon).trim().toLowerCase()
          const value = line.slice(colon + 1).trim()
          headers[name] = value
          if (name === 'content-length') contentLength = Number(value) || 0
        }
        const bodyEnd = headEnd + 4 + contentLength
        if (text.length < bodyEnd) {
          pending.set(socket, text)
          return
        }
        seen.push(requestLine)
        pending.delete(socket)
        const url = requestLine.split(' ')[1] ?? ''
        const method = requestLine.split(' ')[0] ?? 'GET'
        const body = text.slice(headEnd + 4, bodyEnd)
        void (async () => {
          try {
            const response = await fetch(url, {
              method, headers,
              ...(body ? { body } : {}),
            })
            const responseBody = new Uint8Array(await response.arrayBuffer())
            const statusText = response.status === 200 ? 'OK' : 'Error'
            const responseHeaders = [...response.headers.entries()]
              .filter(([name]) => !['transfer-encoding', 'content-encoding', 'content-length'].includes(name))
              .map(([name, value]) => `${name}: ${value}`)
            socket.write(`HTTP/1.1 ${response.status} ${statusText}\r\ncontent-length: ${responseBody.length}\r\n${responseHeaders.join('\r\n')}\r\n\r\n`)
            socket.write(responseBody)
          } catch {
            socket.write('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n')
            socket.end()
          }
        })()
      },
      error(socket) { pending.delete(socket); tunnels.delete(socket) },
      close(socket) {
        pending.delete(socket)
        tunnels.get(socket)?.upstream.end()
        tunnels.delete(socket)
      },
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

async function runTransportProbe(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-transport-'))
  const projectDir = path.join(dir, 'project')
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, '.kawai'), { recursive: true })
  // The project settings file must exist but stay empty: every case writes
  // its value into the launch's flag layer directly, not into a file.
  fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), '{}')
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), '{}')
  // A self-signed certificate for the HTTPS gateway, so the TLS-trust cases
  // have something real to accept or reject.
  const certPath = path.join(dir, 'cert.pem')
  const keyPath = path.join(dir, 'key.pem')
  const gen = Bun.spawnSync([
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ])
  const tlsAvailable = gen.exitCode === 0 && fs.existsSync(certPath)
  if (!tlsAvailable) console.log('openssl unavailable; TLS-trust cases are skipped')

  const gatewayHits = { count: 0 }
  const tlsServer = tlsAvailable
    ? Bun.serve({
        hostname: '127.0.0.1', port: 0,
        tls: { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
        async fetch(req) {
          if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 })
          gatewayHits.count++
          return mockMessageResponse(await req.json() as Record<string, unknown>)
        },
      })
    : undefined
  const plainServer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 })
      gatewayHits.count++
      return mockMessageResponse(await req.json() as Record<string, unknown>)
    },
  })
  const httpsUrl = tlsServer ? `https://127.0.0.1:${tlsServer.port}/api` : ''
  const httpUrl = `http://127.0.0.1:${plainServer.port}/api`

  const cases: TransportCase[] = [
    { name: 'HTTP_PROXY', scheme: 'http', settingsEnv: { HTTP_PROXY: 'PROXY' }, deleteFromEnv: ['HTTP_PROXY'], expectProxy: 'absolute', expectSuccess: true },
    // The tunneled cases also pin NODE_EXTRA_CA_CERTS: the tunnel must
    // complete TLS against the self-signed gateway for the route to be
    // observable; certificate trust is not the variable under test there.
    { name: 'HTTPS_PROXY', scheme: 'https', settingsEnv: { HTTPS_PROXY: 'PROXY', NODE_EXTRA_CA_CERTS: tlsAvailable ? certPath : '' }, deleteFromEnv: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'], expectProxy: 'connect', expectSuccess: true },
    { name: 'NO_PROXY', scheme: 'https', settingsEnv: { HTTPS_PROXY: 'PROXY', NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: tlsAvailable ? certPath : '' }, deleteFromEnv: ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'], expectProxy: 'none', expectSuccess: true },
    ...(tlsAvailable ? [
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', scheme: 'https', settingsEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, deleteFromEnv: ['NODE_TLS_REJECT_UNAUTHORIZED'], expectProxy: 'none', expectSuccess: true },
      { name: 'NODE_EXTRA_CA_CERTS', scheme: 'https', settingsEnv: { NODE_EXTRA_CA_CERTS: certPath }, deleteFromEnv: ['NODE_EXTRA_CA_CERTS'], expectProxy: 'none', expectSuccess: true },
    ] as TransportCase[] : []),
  ]

  const applied: string[] = []
  const skipped: string[] = []
  try {
    for (const probe of cases) {
      const proxy = startRecordProxy()
      try {
        const baseUrl = probe.scheme === 'https' ? httpsUrl : httpUrl
        fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
          mockor: {
            label: 'Mock OR', authTokenEnv: 'MOCK_OR_KEY',
            env: { ANTHROPIC_BASE_URL: baseUrl },
            models: { 'mockor-sonnet': { model: 'sonnet' } },
          },
        }))
        const launch = resolveClaudeProfile('mockor-sonnet', {
          CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
          ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '',
          MOCK_OR_KEY: 'synthetic-or-token',
          CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        }, { homeDir: home })
        for (const name of probe.deleteFromEnv) delete launch.env![name]
        Object.assign(launch.settings!.env!, Object.fromEntries(
          Object.entries(probe.settingsEnv).map(([name, value]) => [name, value === 'PROXY' ? proxy.url : value]),
        ))
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 25000)
        const hitsBefore = gatewayHits.count
        let succeeded = false
        try {
          const { executable: _profileExecutable, ...options } = launch
          const stream = query({
            prompt: 'Reply with verified.',
            options: {
              ...options,
              cwd: projectDir, settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
              permissionMode: 'default' as const,
              canUseTool: async () => ({ behavior: 'deny' as const, message: 'Probe' }),
              abortController: controller, maxTurns: 1,
            },
          })
          for await (const event of stream) {
            if (event.type === 'result') { succeeded = (event as { subtype?: string }).subtype === 'success'; break }
          }
          stream.close()
        } finally {
          clearTimeout(timer)
          controller.abort()
        }
        const routed = gatewayHits.count > hitsBefore
        const viaProxy = probe.expectProxy === 'none'
          ? proxy.seen.length === 0
          : probe.expectProxy === 'connect'
            ? proxy.seen.some(entry => entry.startsWith('CONNECT'))
            : proxy.seen.some(entry => !entry.startsWith('CONNECT'))
        const ok = routed && viaProxy && succeeded
        if (ok) applied.push(probe.name)
        else skipped.push(probe.name)
        console.log(`Transport ${probe.name}: ${ok ? 'applied from settings env' : `NOT applied (routed=${routed}, viaProxy=${viaProxy}, success=${succeeded})`}`)
      } catch (error) {
        skipped.push(probe.name)
        console.log(`Transport ${probe.name}: NOT applied (run failed: ${error instanceof Error ? error.message.slice(0, 120) : error})`)
      } finally {
        proxy.stop()
      }
    }
    console.log(`Transport variables applied from settings env: ${applied.join(', ') || '(none)'}`)
    console.log(`Transport variables not applied: ${skipped.join(', ') || '(none)'}`)

    // The pin's own guarantee, end to end: a project settings file naming a
    // proxy must not route a credentialed launch — the flag layer's pinned
    // empty value wins, and the request reaches the gateway directly.
    {
      const proxy = startRecordProxy()
      try {
        fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: proxy.url } }))
        fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
          mockor: {
            label: 'Mock OR', authTokenEnv: 'MOCK_OR_KEY',
            // The plain gateway: a direct (unproxied) request must complete,
            // so the route is observable without certificate-trust variables.
            env: { ANTHROPIC_BASE_URL: httpUrl },
            models: { 'mockor-sonnet': { model: 'sonnet' } },
          },
        }))
        const launch = resolveClaudeProfile('mockor-sonnet', {
          CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
          ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '',
          MOCK_OR_KEY: 'synthetic-or-token',
          CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        }, { homeDir: home })
        if (launch.settings && typeof launch.settings === 'object' && launch.settings.env!.HTTPS_PROXY !== '') {
          throw new Error('The pinned settings layer lost its empty HTTPS_PROXY')
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 25000)
        const hitsBefore = gatewayHits.count
        let succeeded = false
        try {
          const { executable: _profileExecutable, ...options } = launch
          const stream = query({
            prompt: 'Reply with verified.',
            options: {
              ...options,
              cwd: projectDir, settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
              permissionMode: 'default' as const,
              canUseTool: async () => ({ behavior: 'deny' as const, message: 'Probe' }),
              abortController: controller, maxTurns: 1,
            },
          })
          for await (const event of stream) {
            if (event.type === 'result') { succeeded = (event as { subtype?: string }).subtype === 'success'; break }
          }
          stream.close()
        } finally {
          clearTimeout(timer)
          controller.abort()
        }
        const routed = gatewayHits.count > hitsBefore
        if (!routed || proxy.seen.length > 0 || !succeeded) {
          throw new Error(`Project settings did not deliver the launch to the gateway (routed=${routed}, proxy saw ${proxy.seen.length}, success=${succeeded})`)
        }
        console.log('Pin defense: a project proxy setting did not route the credentialed launch')
      } finally {
        proxy.stop()
        fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), '{}')
      }
    }
  } finally {
    tlsServer?.stop(true)
    plainServer.stop(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

await runTransportProbe()

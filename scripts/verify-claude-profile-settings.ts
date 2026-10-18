// Bundled SDK smoke check: all routing is loopback and credentials are synthetic.
// The second run drives a credentialed provider (openrouter-provider D3): its
// named token must reach the gateway as the bearer, with no x-api-key, even
// though the server and project settings both carry an API key.
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

// Bundled SDK smoke check: all routing is loopback and credentials are synthetic.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mockMessageResponse } from './lib/claudeProfileMock'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeProfile } from '../src/server/chat/ClaudeProfiles'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-smoke-'))
const captured: Record<string, unknown>[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 })
  const body = await req.json() as Record<string, unknown>
  captured.push(body)
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
const launch = resolveClaudeProfile('glm', {
  CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'synthetic-test-key',
  CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDECODE: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})
// Substitute only routing so the catalog's model/alias/settings precedence is
// exercised without contacting the real gateway.
const baseUrl = `http://127.0.0.1:${server.port}`
launch.env!.ANTHROPIC_BASE_URL = baseUrl
if (typeof launch.settings === 'object') launch.settings.env!.ANTHROPIC_BASE_URL = baseUrl
const stream = query({ prompt: 'Reply with verified.', options: {
  ...launch, cwd: projectDir, settingSources: ['user', 'project', 'local'],
  permissionMode: 'default', canUseTool: async () => ({ behavior: 'deny', message: 'Smoke test' }),
  abortController: controller, maxTurns: 1,
} })
try {
  const init = await stream.initializationResult()
  console.log('Project output style:', init.output_style)
  for await (const event of stream) {
    if (event.type === 'result') console.log('Result:', event.subtype)
  }
  if (!captured.some((body) => String(body.model).startsWith('glm-5.3-flash'))) throw new Error('Profile Sonnet alias did not reach loopback provider')
  if (init.output_style !== 'Explanatory') throw new Error('Unrelated project output style did not load')
  console.log('Verified routing, startup model, alias mapping, and unrelated project settings')
} finally {
  clearTimeout(timer)
  controller.abort()
  stream.close()
  server.stop(true)
  fs.rmSync(dir, { recursive: true, force: true })
}

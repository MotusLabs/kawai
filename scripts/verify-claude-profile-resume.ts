// Real SDK concurrent-profile/approval/restart check. Gateways are substituted
// with independent loopback routes; only synthetic credentials are supplied.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager, type ChatQueryFactory } from '../src/server/chat/ChatSessionManager'
import { SessionRegistry } from '../src/server/SessionRegistry'
import { initDatabase } from '../src/server/db'
import type { ChatEvent } from '../src/shared/chat'
import { mockMessageResponse } from './lib/claudeProfileMock'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-resume-'))
const oldConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = path.join(dir, 'config')
fs.mkdirSync(configDir)
process.env.CLAUDE_CONFIG_DIR = configDir
const captured: { route: string; model: string }[] = []
const toolSent = new Set<string>()
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const route = new URL(req.url).pathname
  if (!route.endsWith('/messages')) return Response.json({ input_tokens: 1 })
  const body = await req.json() as Record<string, unknown>
  captured.push({ route, model: String(body.model) })
  const tool = !toolSent.has(route)
  toolSent.add(route)
  return mockMessageResponse(body, tool)
} })
const db = initDatabase({ path: path.join(dir, 'sessions.db') })
const events: { sessionId: string; event: ChatEvent }[] = []
const secret = 'synthetic-profile-resume-key'
const factory: ChatQueryFactory = ({ prompt, options }) => {
  const route = options.model === 'sonnet' ? 'glm' : 'minimax'
  const expected = route === 'glm' ? 'https://zai.ruslan.casa/api/anthropic' : 'https://api.minimax.io/anthropic'
  if (options.env?.ANTHROPIC_BASE_URL !== expected) throw new Error('Incorrect selected catalog routing')
  const baseUrl = `http://127.0.0.1:${server.port}/${route}`
  const settings = typeof options.settings === 'object' ? options.settings : {}
  return query({ prompt, options: { ...options, env: { ...options.env, ANTHROPIC_BASE_URL: baseUrl },
    settings: { ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: baseUrl } } } })
}
const globalEnv = {
  CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}
let manager!: ChatSessionManager
const createManager = () => new ChatSessionManager({ db, registry: new SessionRegistry(), queryFactory: factory,
  getProviderEnv: () => globalEnv, onEvent: (sessionId, event) => {
    events.push({ sessionId, event })
    if (event.type === 'approval_request') {
      // UI decisions resolve the same manager bridge; schedule after pending
      // request registration has completed.
      queueMicrotask(() => manager.resolveApproval(sessionId, event.requestId, 'allow'))
    }
  },
})
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 25000
  while (!condition()) {
    const failure = events.find(item => item.event.type === 'error')
    if (failure?.event.type === 'error') throw new Error(failure.event.message)
    if (Date.now() > deadline) throw new Error('SDK fixture timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
try {
  manager = createManager()
  const results = ['glm', 'minimax'].map(claudeProfileId => manager.createSession({ projectPath: dir, claudeProfileId }))
  const ids = results.map(result => { if (!result.ok) throw new Error(result.error); return result.session.id })
  await Promise.all(ids.map(id => manager.send(id, 'Verify the approval bridge.')))
  await waitFor(() => ids.every(id => events.some(item => item.sessionId === id && item.event.type === 'turn_completed')))
  if (!ids.every(id => events.some(item => item.sessionId === id && item.event.type === 'approval_request'))) throw new Error('Missing profile approval cards')
  const sdkIds = ids.map(id => db.getChatSession(id)!.sdkSessionId)
  if (sdkIds.some(id => !id)) throw new Error('Missing SDK conversation IDs')
  if (JSON.stringify(results).includes(secret)) throw new Error('Credential leaked to session metadata')
  manager.shutdown()
  manager = createManager()
  const completedBefore = events.filter(item => item.event.type === 'turn_completed').length
  await Promise.all(ids.map(id => manager.send(id, 'Continue the stored conversation.')))
  await waitFor(() => events.filter(item => item.event.type === 'turn_completed').length === completedBefore + 2)
  if (!ids.every((id, index) => db.getChatSession(id)?.sdkSessionId === sdkIds[index])) throw new Error('Conversation identity changed on resume')
  if (!captured.some(item => item.route.startsWith('/glm/') && item.model.startsWith('glm-5.3-flash')) ||
      !captured.some(item => item.route.startsWith('/minimax/') && item.model === 'MiniMax-M3')) throw new Error('Provider/model isolation failed')
  console.log('Verified concurrent GLM/MiniMax routing, approvals, credential privacy, and restart/resume identity')
} finally {
  manager?.shutdown()
  db.close()
  server.stop(true)
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  fs.rmSync(dir, { recursive: true, force: true })
}

// §5.5 (codex-chat-sessions): a spawned Codex member through the real
// composition against the fake app-server — worktree staffing creates a
// member of a group whose profile is a Codex profile, its thread starts with
// the role and the security note in developerInstructions, and its first
// turn is the task mail: a `turn/start` carrying the envelope (the message
// id as clientUserMessageId) at the group's effort, shown as one peer turn.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { SessionRegistry } from '../SessionRegistry'
import { resolveTeam } from '../team/teamIdentity'
import { SECURITY_NOTE_BODY } from '../team/teamPrompt'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

const ENV_KEYS = ['CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'ANTHROPIC_API_KEY'] as const

function git(args: string[], cwd?: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

test('a spawned Codex member’s first turn is the task mail, at the group’s effort', async () => {
  const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-spawn-')))
  const repo = path.join(root, 'repo')
  const feature = path.join(root, 'feature')
  const codexHome = path.join(root, 'codex-home')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nprofile: codex\neffort: high\n---\nBuild features')
  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai/profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
  fs.mkdirSync(codexHome, { recursive: true })
  // A temp home's fake login — the real ~/.codex is never touched.
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  const script = new Script().boot('thread/start', 'gpt-test', path.join(codexHome, 'rollout.jsonl')).turn('ct-1')
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: 'on it', questions: null })
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'msg-1', text: 'on it' }])
  process.env.FAKE_TRANSCRIPT = script.write(root)
  process.env.FAKE_RUN = '1'
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  resetCodexExecutableCache()

  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const events = new Map<string, ChatEvent[]>()
  const wire: Array<{ dir: string; raw: string }> = []
  const wireLogs = { get: () => ({ record: (dir: string, raw: string) => wire.push({ dir, raw }) }), pruneOrphans: async () => {}, delete: async () => {} }
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), profileCatalogHome: root, availabilityProbe: async () => {},
    onEvent: (id, event) => events.set(id, [...(events.get(id) ?? []), event]),
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    wireLogs: wireLogs as unknown as ChatWireLogs,
  })
  const sent = (method: string) => wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw)).filter(message => message.method === method)
  try {
    await manager.whenRestored()
    const human = { kind: 'human' as const, team: await resolveTeam(repo) }
    const task = await manager.tasks.create(human, { title: 'Codex work', direction: 'Do it in the feature worktree', worktree: feature, requestKey: 'codex-task' })
    const dispatch = await manager.assignments.dispatch(human, {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Implement the feature', requestKey: 'codex-task',
    })
    const messageId = dispatch.message!.id

    await until(() => sent('turn/start').length === 1, 10_000)
    const member = db.getChatSessions().find(row => row.spawned)!
    expect(member).toMatchObject({ runtime: 'codex', claudeProfileId: 'codex', projectPath: feature, groupId: 'devs', taskId: task.id, codexHome })
    expect(manager.mailbox.store.get(messageId)?.claimedBy).toBe(member.sessionId)

    // The thread carries the role and the security note (D5).
    const [threadStart] = sent('thread/start')
    expect(threadStart.params.cwd).toBe(feature)
    expect(String(threadStart.params.developerInstructions)).toContain('Build features')
    expect(String(threadStart.params.developerInstructions)).toContain(SECURITY_NOTE_BODY)

    // The first and only turn is the task mail, at the group's effort.
    const [turnStart] = sent('turn/start')
    expect(turnStart.params).toMatchObject({ threadId: THREAD_ID, effort: 'high', clientUserMessageId: messageId })
    const input = JSON.stringify(turnStart.params.input)
    expect(input).toContain('Implement the feature')
    expect(input).toContain(messageId)
    await until(() => (events.get(member.sessionId) ?? []).some(event => event.type === 'turn_completed'), 10_000)
    const memberEvents = events.get(member.sessionId) ?? []
    expect(memberEvents.filter(event => event.type === 'user_message')).toEqual([])
    const peers = memberEvents.filter(event => event.type === 'peer_message')
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ messageId, senderKind: 'human', task: { id: task.id } })
  } finally {
    manager.shutdown()
    db.close()
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    resetCodexExecutableCache()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

// The manager's Audit wiring (execution-safety-recovery D7, D9, D10; task
// rev 2), over a scripted query: an observer's committed row notifies the
// team, reads pending while its spawn lives, and names its live session as a
// link; the backup footer reads the injected status; the owner's acknowledge
// notifies the team; a killed session reads `Name (gone)` and never links.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import type { OutboundAuditBackups } from '../outbound/service'
import type { TeamIdentity } from '../team/teamIdentity'

let tempDir: string
let db: SessionDatabase
const managers: ChatSessionManager[] = []
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-manager-audit-'))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
})
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** One query per spawn: pushed messages stream out; the options are kept. */
function scriptedQueries(spawns: Array<{ options: Options; push: (message: SDKMessage) => void }>): ChatQueryFactory {
  return ({ options }) => {
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    let ended = false
    const stream = async function* () {
      while (!ended) {
        if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
        while (queue.length > 0) yield queue.shift()!
      }
    }
    const end = () => { ended = true; wake?.() }
    spawns.push({ options, push: message => { queue.push(message); wake?.() } })
    return Object.assign(stream(), { interrupt: () => Promise.resolve(undefined), close: end }) as unknown as Query
  }
}

const settle = async () => { for (let i = 0; i < 6; i++) await Bun.sleep(1) }
const BACKUPS: OutboundAuditBackups = { dir: '/b', newest: [], failures: [] }

async function harness() {
  const spawns: Array<{ options: Options; push: (message: SDKMessage) => void }> = []
  const changes: string[] = []
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: () => {}, isDirectory: () => true,
    queryFactory: scriptedQueries(spawns),
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    onOutboundChange: teamId => changes.push(teamId),
    backupStatus: () => BACKUPS,
  })
  managers.push(manager)
  await manager.whenRestored()
  const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Auditor' })
  if (!created.ok) throw new Error(created.error)
  expect((await manager.send(created.session.id, 'go')).ok).toBe(true)
  spawns[0]!.push({ type: 'system', subtype: 'init', session_id: 'sdk-audit' } as unknown as SDKMessage)
  await settle()
  const pre = spawns[0]!.options.hooks?.PreToolUse?.[0]?.hooks[0]
  if (!pre) throw new Error('audit hooks not registered')
  await pre({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1',
    tool_input: { command: 'curl -d x https://example.internal/hook' },
  } as never, undefined, { signal: new AbortController().signal })
  await settle()
  return { manager, sessionId: created.session.id, changes }
}

test('a committed row notifies the team, reads pending while its spawn lives, and links its live session', async () => {
  const h = await harness()
  // /tmp/proj is no repository: its plain-directory team.
  expect(h.changes).toEqual(['/tmp/proj'])
  const page = h.manager.outboundAudit.page('/tmp/proj', {})
  expect(page.rows.map(row => ({ outcome: row.outcome, session: row.session }))).toEqual([
    { outcome: { state: 'pending' }, session: { id: h.sessionId, name: 'Auditor', clickable: true } },
  ])
  expect(page.backups).toEqual(BACKUPS)
})

test("the owner's acknowledge notifies the team", async () => {
  const h = await harness()
  const callId = h.manager.outboundAudit.page('/tmp/proj', {}).rows[0]!.id
  const outcome = h.manager.outboundAudit.acknowledge({ kind: 'human', team: { teamId: '/tmp/proj' } as TeamIdentity }, { callId, commandId: 'cmd-1' })
  expect(outcome).toEqual({ ok: true, replayed: false })
  expect(h.changes).toEqual(['/tmp/proj', '/tmp/proj'])
})

test('a killed session reads its recorded name, marked gone, and never links', async () => {
  const h = await harness()
  expect(h.manager.kill(h.sessionId)).toBe(true)
  await settle()
  const [row] = h.manager.outboundAudit.page('/tmp/proj', {}).rows
  expect(row!.session).toEqual({ id: h.sessionId, name: 'Auditor (gone)', clickable: false })
  expect(row!.outcome).toEqual({ state: 'outcome-unknown' })
})

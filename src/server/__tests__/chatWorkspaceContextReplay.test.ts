// I5 (plan-workspace §4.3): replay joins the stored context by the message
// uuid the CLI transcript carries — a restart keeps the attachment, legacy
// lines without a uuid read as absent, an orphan row renders nothing, and
// the stored snapshot never rewrites after a later plan rename or file
// change (LC-D1, CP1 B4).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import type { WorkspaceMessageContext } from '../../shared/planWorkspace'
import { createHarness, flush, initMessage, installManagerCleanup, writeTranscript, type ManagerHarness } from './helpers/chatSessionManagerHarness'
import { initDatabase, type SessionDatabase } from '../db'

installManagerCleanup()

const context: WorkspaceMessageContext = {
  teamId: '/repo/example/main',
  planId: 'plan-1',
  planTitle: 'Workspace roadmap',
  version: { kind: 'revision', revision: 2, contentHash: 'a'.repeat(64) },
  executionId: null,
  changeName: 'plan-workspace',
  documentRefId: null,
}

const userLine = (uuid: string | null, text: string) =>
  JSON.stringify({
    type: 'user',
    ...(uuid ? { uuid } : {}),
    timestamp: '2026-10-23T10:00:00.000Z',
    message: { role: 'user', content: text },
  })

describe('chatWorkspaceContextReplay', () => {
  let tempDir: string
  let db: SessionDatabase
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-pwd-replay-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** A session with one sent message, its sdk id persisted, ready to replay. */
  const started = async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    await harness.manager.send(created.session.id, 'hello')
    harness.handles[0]!.push(initMessage('sdk-1'))
    await flush()
    return { harness, id: created.session.id }
  }

  /** A second manager over the same database: the restart. */
  const restarted = async (first: ManagerHarness, id: string) => {
    const second = await createHarness(db)
    const snapshot = second.manager.getSnapshot(id)
    if (!snapshot) throw new Error('no snapshot after restart')
    return { second, events: snapshot.events }
  }

  const userEvents = (events: ChatEvent[]) => events.filter(e => e.type === 'user_message')
  const withContext = (events: ChatEvent[]) =>
    events.filter(e => 'workspaceContext' in e)

  test('I5 a restart keeps the attachment joined by the transcript uuid', async () => {
    const { harness, id } = await started()
    expect(harness.manager.planWorkspaceContext.record({
      sessionId: id, messageUuid: 'sent-uuid-1', turnId: null, context,
    }).ok).toBe(true)
    writeTranscript('sdk-1', [
      userLine('sent-uuid-1', 'hello'),
      JSON.stringify({
        type: 'assistant', uuid: 'a-1', timestamp: '2026-10-23T10:00:01.000Z',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    ].join('\n'))
    const { events } = await restarted(harness, id)
    const mine = userEvents(events).find(e => (e as { messageUuid?: string }).messageUuid === 'sent-uuid-1')
    expect(mine).toBeDefined()
    expect((mine as { workspaceContext?: WorkspaceMessageContext }).workspaceContext).toEqual(context)
  })

  test('I5 a legacy transcript line without a uuid reads as no context', async () => {
    const { harness, id } = await started()
    expect(harness.manager.planWorkspaceContext.record({
      sessionId: id, messageUuid: 'sent-uuid-1', turnId: null, context,
    }).ok).toBe(true)
    writeTranscript('sdk-1', userLine(null, 'hello'))
    const { events } = await restarted(harness, id)
    const rendered = userEvents(events)
    expect(rendered).toHaveLength(1)
    expect((rendered[0] as { text: string }).text).toBe('hello')
    expect('messageUuid' in rendered[0]!).toBe(false)
    expect(withContext(events)).toEqual([])
  })

  test('LC-D1 an orphan context row renders nothing and the replay stays intact', async () => {
    const { harness, id } = await started()
    // A row whose message never reached the transcript.
    expect(harness.manager.planWorkspaceContext.record({
      sessionId: id, messageUuid: 'orphan-uuid', turnId: null, context,
    }).ok).toBe(true)
    writeTranscript('sdk-1', [
      userLine('real-uuid', 'hello'),
      JSON.stringify({
        type: 'assistant', uuid: 'a-1', timestamp: '2026-10-23T10:00:01.000Z',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    ].join('\n'))
    const { events } = await restarted(harness, id)
    // Nothing renders the orphan, and the transcript itself is intact.
    expect(withContext(events)).toEqual([])
    expect(typesOf(events)).toEqual(['user_message', 'assistant_text'])
    expect((userEvents(events)[0] as { text: string }).text).toBe('hello')
  })

  test('I5 a later plan rename or file change never rewrites the stored snapshot', async () => {
    const { harness, id } = await started()
    const seeded: WorkspaceMessageContext = {
      ...context,
      planTitle: 'Workspace roadmap (renamed away)',
      documentRefId: 'ref-1',
    }
    expect(harness.manager.planWorkspaceContext.record({
      sessionId: id, messageUuid: 'sent-uuid-1', turnId: null, context: seeded,
    }).ok).toBe(true)
    writeTranscript('sdk-1', userLine('sent-uuid-1', 'hello'))
    const { second, events } = await restarted(harness, id)
    // No plan and no ref exists in the stores at all: the join renders the
    // stored snapshot whole, never a live re-resolution.
    expect(await second.manager.plans.list({ kind: 'human', team: { teamId: '/tmp/proj', groupsRoot: '/tmp/proj' } })).toEqual([])
    const mine = userEvents(events).find(e => (e as { messageUuid?: string }).messageUuid === 'sent-uuid-1')
    expect((mine as { workspaceContext?: WorkspaceMessageContext }).workspaceContext).toEqual(seeded)
  })

  test("I5 a command-output turn's attachment joins the user message, never the command output", async () => {
    const { harness, id } = await started()
    expect(harness.manager.planWorkspaceContext.record({
      sessionId: id, messageUuid: 'sent-uuid-2', turnId: null, context,
    }).ok).toBe(true)
    writeTranscript('sdk-1', [
      userLine('sent-uuid-2', '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>'),
      JSON.stringify({
        type: 'system', subtype: 'local_command', uuid: 'sys-1',
        timestamp: '2026-10-23T10:00:02.000Z',
        content: '<local-command-stdout>Total cost:            $0.0000</local-command-stdout>',
      }),
    ].join('\n'))
    const { events } = await restarted(harness, id)
    const attached = withContext(events)
    expect(attached).toHaveLength(1)
    expect(attached[0]!.type).toBe('user_message')
    const output = events.find(e => e.type === 'command_output')
    expect(output).toBeDefined()
    expect('workspaceContext' in output!).toBe(false)
  })
})

function typesOf(events: ChatEvent[]): string[] {
  return events.map(e => e.type)
}

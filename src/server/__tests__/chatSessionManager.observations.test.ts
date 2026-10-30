// compact-observation-detail T1 rows E3, E7 and E8 through the production
// composition (oracle hazard M1): SDK frames enter the fake query, the driver
// maps them to chat events, ChatSessionManager feeds the observation tracker,
// and the rows are read back from the database the server opened.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { closeDispatchers, createHarness, flush, initMessage, installManagerCleanup, resultWithWindow } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

const toolUse = (id: string, name: string): SDKMessage => ({
  type: 'assistant',
  message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }], role: 'assistant' },
  parent_tool_use_id: null,
  uuid: `uuid-${id}`,
  session_id: 'sdk-1',
}) as unknown as SDKMessage

const toolResult = (id: string): SDKMessage => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] },
  parent_tool_use_id: null,
  uuid: `uuid-result-${id}`,
  session_id: 'sdk-1',
}) as unknown as SDKMessage

describe('ChatSessionManager observation rows', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalHome = process.env.HOME
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatobs-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    for (const [name, value] of [['ANTHROPIC_API_KEY', originalApiKey], ['HOME', originalHome], ['CLAUDE_CONFIG_DIR', originalConfigDir]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // @covers: process-observations › Unmatched request resolutions are counted, not stored › Auto-approved tool
  // @covers: process-observations › Tool calls and requests are stored once, at completion › Call open at turn end
  test('an auto-approved call stores one tool row, a policy grant is only counted, and an open call closes partial', async () => {
    const h = await createHarness(db)
    const created = h.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect(h.manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    expect((await h.manager.send(id, 'run a command')).ok).toBe(true)
    const handle = h.handles[0]!
    handle.push(initMessage('sdk-obs'))
    handle.push(toolUse('toolu_1', 'Bash'))
    await flush()
    const grant = handle.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'sdk-req-1' })
    await expect(grant).resolves.toMatchObject({ behavior: 'allow' })
    handle.push(toolResult('toolu_1'))
    handle.push(resultWithWindow())
    await flush()
    // Second turn: a call still running when the turn ends.
    expect((await h.manager.send(id, 'start another')).ok).toBe(true)
    handle.push(toolUse('toolu_2', 'Read'))
    handle.push(resultWithWindow())
    await flush()

    const rows = (db.db.prepare("SELECT kind,tool_call_id,data FROM process_observations WHERE kind IN ('tool','request','turn_ended','activity') ORDER BY seq").all() as { kind: string; tool_call_id: string | null; data: string }[])
      .map(row => ({ kind: row.kind, toolCallId: row.tool_call_id, data: JSON.parse(row.data) as Record<string, unknown> }))
    // E3: one row for the completed call.
    expect(rows.filter(row => row.kind === 'tool' && row.toolCallId === 'toolu_1').map(row => row.data)).toEqual([
      expect.objectContaining({ category: 'shell', outcome: 'success', partial: false }),
    ])
    // E7: the policy grant had no approval request; nothing stored, one counted.
    expect(rows.filter(row => row.kind === 'request')).toEqual([])
    const ends = rows.filter(row => row.kind === 'turn_ended').map(row => row.data)
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ outcome: 'success', unmatchedResolutions: 1 })
    // E8: the open call closes as one partial row.
    expect(rows.filter(row => row.kind === 'tool' && row.toolCallId === 'toolu_2').map(row => row.data)).toEqual([
      expect.objectContaining({ outcome: 'unavailable', partial: true }),
    ])
    expect(ends[1]).toMatchObject({ unmatchedResolutions: 0, thinkingSeconds: expect.any(Number) })
    expect(rows.filter(row => row.kind === 'activity')).toEqual([])
    expect(db.db.prepare("SELECT count(*) AS n FROM process_observation_keys WHERE source_key LIKE 'chat:%'").get()).toEqual({ n: 0 })
    h.manager.shutdown()
  })
})

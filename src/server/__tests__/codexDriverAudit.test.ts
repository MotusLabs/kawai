// §5.5 and §5.7 (codex-chat-sessions D13): the Codex driver's launch inputs —
// developerInstructions from the prompt append, read at each spawn, and the
// effort sent as turn/start.effort — and its outbound-audit feed: commands as
// `Bash` and external MCP calls as `mcp__<server>__<tool>` through every
// lifecycle edge, never kawai-team calls or file changes, observation only.
import { afterEach, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import type { OutboundAuditSink } from '../outbound/observer'
import { SECURITY_NOTE_BODY } from '../team/teamPrompt'
import { Script, sentRequest, startHarness, THREAD_ID, until, type Harness } from './codexDriverHarness'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

type Call = { hook: string; use: Record<string, unknown> }
function recordingSink(calls: Call[], throwing = false): OutboundAuditSink {
  const hook = (name: string) => (use: unknown) => {
    calls.push({ hook: name, use: (typeof use === 'string' ? { spawnId: use } : use) as Record<string, unknown> })
    if (throwing) throw new Error('observer down')
  }
  return {
    onPreToolUse: hook('pre'),
    onPostToolUse: hook('post'),
    onPostToolUseFailure: hook('failure'),
    onPermissionDenied: hook('permission-denied'),
    onDeniedCard: hook('denied-card'),
    onSpawnEnd: hook('spawn-end'),
  }
}

const turnDone = (h: Harness) => h.events.some((event: ChatEvent) => event.type === 'turn_completed')
const command = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  type: 'commandExecution', id, command: 'curl https://example.internal/x', cwd: '/w/sub', status, aggregatedOutput: 'out', exitCode: status === 'completed' ? 0 : null, ...extra,
})
const mcp = (id: string, server: string, status: string) => ({ type: 'mcpToolCall', id, server, tool: 'search', status, arguments: { q: 'docs' }, result: null, error: null })

test('developerInstructions carries the prompt append, security note included, at start and at resume', async () => {
  for (const method of ['thread/start', 'thread/resume'] as const) {
    let reads = 0
    const append = `Role body\n\n## Outbound actions\n\n${SECURITY_NOTE_BODY}`
    harness = startHarness(new Script().boot(method), {
      getSystemPromptAppend: () => { reads += 1; return append },
      ...(method === 'thread/resume' ? { resumeThreadId: THREAD_ID } : {}),
    })
    harness.driver.start()
    await until(() => harness!.transcriptPaths.length === 1)
    expect(sentRequest(harness, method)!.developerInstructions).toBe(append)
    expect(reads).toBe(1)
    harness.cleanup()
    harness = null
  }
})

test('the group effort rides turn/start.effort, mapped to a Codex level', async () => {
  let effort: 'high' | 'max' = 'high'
  const script = new Script().boot().turn('ct-1').completed('ct-1').turn('ct-2').completed('ct-2')
  harness = startHarness(script, { getEffort: () => effort })
  harness.driver.send('one')
  await until(() => turnDone(harness!))
  effort = 'max'
  harness.driver.send('two')
  await until(() => harness!.events.filter(event => event.type === 'turn_completed').length === 2)
  expect(sentRequest(harness, 'turn/start', 0)!.effort).toBe('high')
  expect(sentRequest(harness, 'turn/start', 1)!.effort).toBe('xhigh')
})

test('no effort configured sends no effort field', async () => {
  harness = startHarness(new Script().boot().turn('ct-1').completed('ct-1'))
  harness.driver.send('one')
  await until(() => turnDone(harness!))
  expect('effort' in sentRequest(harness, 'turn/start')!).toBe(false)
})

test('commands and external MCP calls feed the observer on every edge; team calls and file changes never do', async () => {
  const change = { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '' }] }
  const team = { type: 'dynamicToolCall', id: 'dyn-1', namespace: 'kawai-team', tool: 'send_message', arguments: { to: 'lead' }, status: 'inProgress', contentItems: null, success: null }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', command('cmd-ok', 'inProgress')).item('completed', 'ct-1', command('cmd-ok', 'completed', { durationMs: 12 }))
    .item('started', 'ct-1', command('cmd-bad', 'inProgress')).item('completed', 'ct-1', command('cmd-bad', 'failed', { exitCode: 7 }))
    .item('started', 'ct-1', command('cmd-no', 'inProgress')).item('completed', 'ct-1', command('cmd-no', 'declined'))
    .item('started', 'ct-1', mcp('mcp-1', 'docs-search', 'inProgress')).item('completed', 'ct-1', mcp('mcp-1', 'docs-search', 'completed'))
    .item('started', 'ct-1', mcp('mcp-team', 'kawai-team', 'inProgress')).item('completed', 'ct-1', mcp('mcp-team', 'kawai-team', 'completed'))
    .item('started', 'ct-1', team).item('completed', 'ct-1', { ...team, status: 'completed', success: true, contentItems: [] })
    .item('started', 'ct-1', change).item('completed', 'ct-1', { ...change, status: 'completed' })
    .completed('ct-1')
  const calls: Call[] = []
  harness = startHarness(script, { outbound: recordingSink(calls) })
  harness.driver.send('go')
  await until(() => turnDone(harness!))
  const fed = calls.map(call => `${call.hook}:${String(call.use.toolName)}:${String(call.use.toolUseId)}`)
  expect(fed).toEqual([
    'pre:Bash:cmd-ok', 'post:Bash:cmd-ok',
    'pre:Bash:cmd-bad', 'failure:Bash:cmd-bad',
    'pre:Bash:cmd-no', 'permission-denied:Bash:cmd-no',
    'pre:mcp__docs-search__search:mcp-1', 'post:mcp__docs-search__search:mcp-1',
  ])
  const pre = calls[0]!.use
  expect(pre).toMatchObject({ toolInput: { command: 'curl https://example.internal/x' }, cwd: '/w/sub' })
  expect(String(pre.spawnId)).toStartWith('ob-s-')
  expect(calls[1]!.use).toMatchObject({ background: false, durationMs: 12 })
  expect(calls[3]!.use.error).toBe('exit code 7: out')
  expect(calls[7]!.use.toolInput).toEqual({ q: 'docs' })
  // Every call of one process shares its spawn id; the kill ends it.
  expect(new Set(calls.map(call => call.use.spawnId)).size).toBe(1)
  harness.driver.kill()
  expect(calls.at(-1)).toEqual({ hook: 'spawn-end', use: { spawnId: pre.spawnId } })
})

test('a denied command card reaches the observer as a denied card; a denied file change does not', async () => {
  const change = { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '' }] }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', command('cmd-1', 'inProgress'))
    .serverRequest(200, 'item/commandExecution/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'cmd-1', command: 'curl https://example.internal/x' })
    .item('started', 'ct-1', change)
    .serverRequest(201, 'item/fileChange/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'fc-1' })
    .completed('ct-1')
  const calls: Call[] = []
  harness = startHarness(script, { outbound: recordingSink(calls) })
  harness.driver.send('go')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  harness.driver.resolveApproval(harness.driver.getPendingRequests()[0]!.requestId, 'deny')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  harness.driver.resolveApproval(harness.driver.getPendingRequests()[0]!.requestId, 'deny')
  await until(() => turnDone(harness!))
  expect(calls.filter(call => call.hook === 'denied-card')).toEqual([
    { hook: 'denied-card', use: expect.objectContaining({ toolName: 'Bash', toolUseId: 'cmd-1', toolInput: expect.objectContaining({ command: 'curl https://example.internal/x' }) }) },
  ])
})

test('a throwing observer never fails the call or the turn', async () => {
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', command('cmd-1', 'inProgress')).item('completed', 'ct-1', command('cmd-1', 'completed'))
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'm', text: 'done' }])
  const calls: Call[] = []
  harness = startHarness(script, { outbound: recordingSink(calls, true) })
  harness.driver.send('go')
  await until(() => turnDone(harness!))
  expect(calls.map(call => call.hook)).toEqual(['pre', 'post'])
  expect(harness.events.map(event => event.type)).toEqual(['turn_started', 'user_message', 'tool_call', 'tool_result', 'turn_completed'])
  expect(harness.events.at(-1)).toMatchObject({ subtype: 'success', finalText: 'done' })
})

test('the process ending on its own settles its calls as outcome-unknown (spawn end)', async () => {
  const script = new Script().boot().turn('ct-1').item('started', 'ct-1', command('cmd-1', 'inProgress'))
  const calls: Call[] = []
  const serverEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_EXIT_AFTER_REPLAY: '1' }
  harness = startHarness(script, { outbound: recordingSink(calls), serverEnv })
  serverEnv.FAKE_TRANSCRIPT = harness.transcript
  harness.driver.send('go')
  await until(() => harness!.driver.isDead)
  expect(calls.map(call => call.hook)).toEqual(['pre', 'spawn-end'])
  expect(calls[1]!.use.spawnId).toBe(calls[0]!.use.spawnId)
  // The open turn ended as an error rather than wedging at working.
  expect(harness.events.find(event => event.type === 'turn_completed')).toMatchObject({ isError: true })
  expect(harness.statuses.at(-1)).toBe('waiting')
})

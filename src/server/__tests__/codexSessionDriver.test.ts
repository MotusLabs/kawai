// §5.2 (codex-chat-sessions): the Codex driver against the fake app-server —
// thread persistence (start, then resume of the stored thread), streaming and
// turn completion, activity, interrupt, a failed turn, and the process exit
// that marks the driver dead so the next send respawns and resumes.
import { afterEach, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { codexEffort } from '../chat/codex/CodexSessionDriver'
import { eventTypes, ROLLOUT, Script, sentRequest, startHarness, THREAD_ID, until, type Harness } from './codexDriverHarness'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

const completedOf = (events: ChatEvent[]) => events.filter((event): event is Extract<ChatEvent, { type: 'turn_completed' }> => event.type === 'turn_completed')

test('a fresh chat starts a persisted thread and reports its id and rollout path', async () => {
  harness = startHarness(new Script().boot())
  harness.driver.start()
  await until(() => harness!.sessionIds.length === 1)
  expect(harness.sessionIds).toEqual([THREAD_ID])
  expect(harness.transcriptPaths).toEqual([ROLLOUT])
  const params = sentRequest(harness, 'thread/start')!
  expect(params.ephemeral).toBe(false)
  expect(params.approvalPolicy).toBe('on-request')
  expect(params.approvalsReviewer).toBe('user')
  expect(params.sandbox).toBe('workspace-write')
  expect(params.dynamicTools).toBeUndefined()
  // Starting sends no prompt.
  expect(sentRequest(harness, 'turn/start')).toBeUndefined()
  expect(harness.events).toEqual([])
})

test('a stored thread is resumed, never restarted, and its id is not re-reported', async () => {
  harness = startHarness(new Script().boot('thread/resume'), { resumeThreadId: THREAD_ID })
  harness.driver.start()
  await until(() => harness!.transcriptPaths.length === 1)
  const params = sentRequest(harness, 'thread/resume')!
  expect(params.threadId).toBe(THREAD_ID)
  expect(params.approvalsReviewer).toBe('user')
  expect(params.ephemeral).toBeUndefined()
  expect(sentRequest(harness, 'thread/start')).toBeUndefined()
  expect(harness.sessionIds).toEqual([])
})

test('a turn streams text, completes with its final text and token usage, and statuses follow', async () => {
  const total1 = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: '', questions: null })
    .notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'msg-1', delta: 'hel' })
    .notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'msg-1', delta: 'lo' })
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: 'hello', questions: null })
    .notify('thread/tokenUsage/updated', { threadId: THREAD_ID, turnId: 'ct-1', tokenUsage: { total: total1, last: total1, modelContextWindow: 10_000 } })
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'msg-1', text: 'hello' }])
  const activities: Array<string | null> = []
  harness = startHarness(script, { onActivity: activity => activities.push(activity?.phase ?? null) })
  harness.driver.send('hi')
  await until(() => completedOf(harness!.events).length === 1)
  expect(eventTypes(harness.events)).toEqual(['turn_started', 'user_message', 'assistant_delta', 'assistant_delta', 'assistant_text', 'turn_completed'])
  const turnStart = sentRequest(harness, 'turn/start')!
  expect(turnStart.threadId).toBe(THREAD_ID)
  expect(turnStart.input).toEqual([{ type: 'text', text: 'hi', text_elements: [] }])
  const done = completedOf(harness.events)[0]!
  expect(done.subtype).toBe('success')
  expect(done.isError).toBeUndefined()
  expect(done.finalText).toBe('hello')
  expect(done.usage).toEqual({ inputTokens: 800, outputTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 0 })
  expect(harness.statuses).toEqual(['working', 'waiting'])
  expect(activities).toEqual(['requesting', 'responding', null])
  expect(harness.usage.at(-1)).toMatchObject({ usedTokens: 1000, thresholdTokens: 10_000, percentage: 10, thresholdApproximate: true })
})

test('a failed turn ends as an error with its reason named', async () => {
  const script = new Script().boot().turn('ct-1')
    .completed('ct-1', 'failed', [], { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' })
  harness = startHarness(script)
  harness.driver.send('hi')
  await until(() => completedOf(harness!.events).length === 1)
  const done = completedOf(harness.events)[0]!
  expect(done).toMatchObject({ subtype: 'error_during_execution', isError: true, terminalReason: 'usageLimitExceeded' })
  expect(harness.events.at(-1)).toMatchObject({ type: 'error', message: 'usage limit reached (usageLimitExceeded)' })
})

test('interrupt ends the turn at once, stops the Codex turn, and drops its late frames', async () => {
  const script = new Script().boot().turn('ct-1')
    .request('turn/interrupt', {})
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'late', text: 'too late', questions: null })
    .completed('ct-1', 'interrupted')
  harness = startHarness(script)
  harness.driver.send('long job')
  await until(() => harness!.wire.some(entry => entry.dir === 'in' && entry.raw.includes('turn/started')))
  await harness.driver.interrupt()
  expect(sentRequest(harness, 'turn/interrupt')).toEqual({ threadId: THREAD_ID, turnId: 'ct-1' })
  await until(() => harness!.wire.some(entry => entry.dir === 'in' && entry.raw.includes('"interrupted"')))
  await Bun.sleep(30)
  expect(eventTypes(harness.events)).toEqual(['turn_started', 'user_message', 'turn_interrupted'])
  expect(harness.statuses.at(-1)).toBe('waiting')
})

test('a process exit marks the driver dead; the next send respawns and resumes the thread', async () => {
  // Two runs (the fake splits at each initialize): the first exits once
  // replayed, the second is the respawn, which must resume, not restart.
  const script = new Script().boot().turn('ct-1').completed('ct-1')
  const second = new Script().boot('thread/resume').turn('ct-2').completed('ct-2')
  script.lines.push(...second.lines)
  const ends: number[] = []
  const serverEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_EXIT_AFTER_REPLAY: '1', FAKE_RUN: '1' }
  harness = startHarness(script, { onProcessEnd: () => ends.push(1), serverEnv })
  serverEnv.HOME = harness.dir
  serverEnv.FAKE_TRANSCRIPT = harness.transcript
  harness.driver.send('one')
  await until(() => harness!.driver.isDead)
  expect(completedOf(harness.events)).toHaveLength(1)
  expect(ends).toEqual([1])
  expect(harness.events.at(-1)).toMatchObject({ type: 'error', message: 'The Codex app-server exited with code 0' })
  expect(harness.statuses.at(-1)).toBe('waiting')

  serverEnv.FAKE_RUN = '2'
  harness.driver.send('two')
  expect(harness.driver.isDead).toBe(false)
  await until(() => completedOf(harness!.events).length === 2)
  expect(sentRequest(harness, 'thread/resume')).toMatchObject({ threadId: THREAD_ID })
  expect(harness.sessionIds).toEqual([THREAD_ID])
})

test('a compaction item reports onCompaction and the compacted notice; usage names its threshold source', async () => {
  const last = { totalTokens: 500, inputTokens: 450, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }
  const script = new Script().boot().turn('ct-1')
    .notify('thread/tokenUsage/updated', { threadId: THREAD_ID, turnId: 'ct-1', tokenUsage: { total: last, last, modelContextWindow: 2_000 } })
    .item('completed', 'ct-1', { type: 'contextCompaction', id: 'cc-1' })
    .completed('ct-1')
  const compactions: Array<{ data: Record<string, unknown>; sourceId?: string }> = []
  const sources: Array<string | undefined> = []
  harness = startHarness(script, {
    onCompaction: (data, sourceId) => compactions.push({ data, sourceId }),
    onContextUsage: (_usage, opts) => sources.push(opts?.thresholdSource),
  })
  harness.driver.send('go')
  await until(() => completedOf(harness!.events).length === 1)
  expect(compactions).toEqual([{ data: expect.objectContaining({ trigger: 'auto', outcome: 'completed' }), sourceId: 'boundary:cc-1' }])
  expect(harness.events.find(event => event.type === 'notice')).toMatchObject({ text: 'Context compacted', kind: 'compacted' })
  expect(sources).toEqual(['model-window-fallback'])
})

test('effort maps onto Codex levels: max becomes xhigh, numbers are dropped', () => {
  expect(codexEffort('low')).toBe('low')
  expect(codexEffort('xhigh')).toBe('xhigh')
  expect(codexEffort('max')).toBe('xhigh')
  expect(codexEffort(3)).toBeUndefined()
  expect(codexEffort(undefined)).toBeUndefined()
})

test('per-item state lives one turn: a long session keeps only the open turn’s tool calls', async () => {
  const command = (id: string) => ({ type: 'commandExecution', id, command: 'true', cwd: '', status: 'inProgress', aggregatedOutput: null, exitCode: null })
  const script = new Script().boot()
  for (const n of [1, 2, 3]) {
    script.turn(`ct-${n}`)
      .item('started', `ct-${n}`, command(`cmd-${n}`))
      .item('completed', `ct-${n}`, { ...command(`cmd-${n}`), status: 'completed', aggregatedOutput: '', exitCode: 0 })
      .completed(`ct-${n}`, 'completed', [])
  }
  harness = startHarness(script)
  for (const n of [1, 2, 3]) {
    harness.driver.send(`turn ${n}`)
    await until(() => completedOf(harness!.events).length === n)
    // The just-ended turn's call is still listed until the next turn begins …
    expect([...harness.driver.getSeenToolCallIds()]).toEqual([`cmd-${n}`])
    const held = harness.driver as unknown as { itemInputs: Map<string, unknown> }
    expect([...held.itemInputs.keys()]).toEqual([`cmd-${n}`])
  }
  // … so three turns never accumulate three calls.
  expect(harness.events.filter(event => event.type === 'tool_call')).toHaveLength(3)
})

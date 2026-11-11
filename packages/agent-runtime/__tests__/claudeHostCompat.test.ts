// @reads: packages/agent-runtime/__tests__/fixtures/**
// The Claude driver's optional host-compatibility observations (owner
// amendment R2 of task-7811b455; design §5) on the production ClaudeSession
// with a controlled query: the test plays the SDK, calling the hooks the
// session registered and writing the frames. Expected values are the
// inputs the test wrote, and the derivation table Kawai's ChatSessionDriver
// used before the extraction (applyContextStep), never the driver's output:
// - onSpawn: once per actual query construction, after it exists, with the
//   generation, the launch, the caller's inputs (null when omitted) and
//   whether it resumes; a query that could not be created reports none.
// - auditHooks.onHook: each PreToolUse, PostToolUse, PostToolUseFailure and
//   PermissionDenied input whole and JSON-safe; every hook answers {}.
// - onCwdChanged: the main session's CwdChanged; a subagent's is dropped.
// - onCompactionObservation: a `compacting` status starts one observation,
//   its boundary completes it with trigger, sizes and duration; the existing
//   onCompaction is unchanged.
// - onNotification: timeout_ms rides as the second argument, else none.
// - onContextUsage meta: a boundary or a threshold change persists, a
//   request reading does not, a reset clears with persist; the threshold
//   source follows the table.
import { describe, expect, test } from 'bun:test'
import type { HookCallbackMatcher, HookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentNotification } from '../src/activity.js'
import type { CompactionObservation, ContextUsageMeta, SpawnInfo } from '../src/options.js'
import { ContextTracker } from '../src/usage/context.js'
import type { ContextUsage } from '../src/usage/types.js'
import { driver, type DriverHooks } from './helpers/claudeDriverHarness.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function idle(hooks: DriverHooks = {}) {
  const f = driver(hooks)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

/** Run every hook the session registered for `event`, as the SDK does; returns their answers. */
async function fire(f: Awaited<ReturnType<typeof idle>>, event: string, input: Record<string, unknown>): Promise<unknown[]> {
  const matchers = ((f.q().options.hooks as Record<string, HookCallbackMatcher[]> | undefined)?.[event] ?? [])
  const answers: unknown[] = []
  for (const matcher of matchers) for (const hook of matcher.hooks) answers.push(await hook({ hook_event_name: event, session_id: 's', transcript_path: '', cwd: '/w', ...input } as unknown as HookInput, 't', { signal: new AbortController().signal }))
  return answers
}

const system = (body: Record<string, unknown>) => ({ type: 'system', session_id: 'sess-saved', ...body }) as unknown as SDKMessage

describe('Claude spawn provenance', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Process and compaction observations
  test('a construction reports its generation, launch, caller inputs and resume, after the query exists', async () => {
    const spawns: Array<SpawnInfo & { queries: number }> = []
    const holder: { f?: ReturnType<typeof driver> } = {}
    const f = await idle({
      env: { MARKER_ENV: 'marker-1' },
      session: { systemPromptAppend: 'HOST APPEND', model: 'model-x', effort: 'high' },
      observers: { onSpawn: (info) => spawns.push({ ...info, queries: holder.f?.queries.length ?? -1 }) },
    })
    holder.f = f
    expect(spawns).toHaveLength(1)
    const [info] = spawns
    expect([info!.generation, info!.resumed, info!.systemPromptAppend, info!.effort, info!.model]).toEqual([1, true, 'HOST APPEND', 'high', 'model-x'])
    expect(info!.childEnv.MARKER_ENV).toBe('marker-1')
    expect(info!.cwd).toBe(f.q().options.cwd!)
    expect(info!.childEnv).toEqual(expect.objectContaining({ MARKER_ENV: 'marker-1' }))
    await f.d.kill()
  })

  test('omitted inputs are null, a fresh launch is not resumed, and the report follows the query', async () => {
    const order: string[] = []
    const holder: { f?: ReturnType<typeof driver> } = {}
    const f = driver({ resume: null, observers: { onSpawn: (info) => order.push(`spawn ${info.generation} queries=${holder.f!.queries.length} ${info.systemPromptAppend}|${info.effort}|${info.model}|${info.resumed}`) } })
    holder.f = f
    const start = f.d.start()
    while (f.queries.length === 0) await tick()
    f.q().ready()
    await start
    expect(order).toEqual(['spawn 1 queries=1 |null|null|false'])
    await f.d.kill()
  })
})

describe('Claude detailed audit hooks and cwd', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Detailed Claude audit facts
  test('onHook receives each audited hook input whole and JSON-safe; every hook answers no decision', async () => {
    const seen: Array<{ kind: string; input: unknown }> = []
    const f = await idle({ session: { auditHooks: { onHook: (event) => seen.push(event) } } })
    const toolInput = { command: 'curl x', nested: { n: 1 }, drop: undefined }
    const answers = [
      ...(await fire(f, 'PreToolUse', { tool_name: 'Bash', tool_input: toolInput, tool_use_id: 'tu-1', agent_id: 'sub-1' })),
      ...(await fire(f, 'PostToolUse', { tool_name: 'Bash', tool_input: toolInput, tool_response: { stdout: 'ok' }, tool_use_id: 'tu-1', duration_ms: 12 })),
      ...(await fire(f, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: toolInput, tool_use_id: 'tu-2', error: 'exit 1', is_interrupt: false })),
      ...(await fire(f, 'PermissionDenied', { tool_name: 'Write', tool_input: { file_path: '/x' }, tool_use_id: 'tu-3', reason: 'denied by policy' })),
    ]
    expect(answers.every((answer) => JSON.stringify(answer) === '{}')).toBe(true)
    const base = { session_id: 's', transcript_path: '', cwd: '/w' }
    const jsonInput = { command: 'curl x', nested: { n: 1 } }
    expect(seen).toEqual([
      { kind: 'PreToolUse', input: { hook_event_name: 'PreToolUse', ...base, tool_name: 'Bash', tool_input: jsonInput, tool_use_id: 'tu-1', agent_id: 'sub-1' } },
      { kind: 'PostToolUse', input: { hook_event_name: 'PostToolUse', ...base, tool_name: 'Bash', tool_input: jsonInput, tool_response: { stdout: 'ok' }, tool_use_id: 'tu-1', duration_ms: 12 } },
      { kind: 'PostToolUseFailure', input: { hook_event_name: 'PostToolUseFailure', ...base, tool_name: 'Bash', tool_input: jsonInput, tool_use_id: 'tu-2', error: 'exit 1', is_interrupt: false } },
      { kind: 'PermissionDenied', input: { hook_event_name: 'PermissionDenied', ...base, tool_name: 'Write', tool_input: { file_path: '/x' }, tool_use_id: 'tu-3', reason: 'denied by policy' } },
    ])
    await f.d.kill()
  })

  test('without onHook no PermissionDenied hook is registered', async () => {
    const f = await idle({ session: { auditHooks: { preToolUse: () => {} } } })
    expect(await fire(f, 'PermissionDenied', { tool_name: 'Write', tool_input: {}, tool_use_id: 'tu', reason: 'r' })).toEqual([])
    await f.d.kill()
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Process and compaction observations
  test("onCwdChanged reports the main session's new cwd and drops a subagent's", async () => {
    const cwds: string[] = []
    const f = await idle({ observers: { onCwdChanged: (cwd) => cwds.push(cwd) } })
    await fire(f, 'CwdChanged', { old_cwd: '/w', new_cwd: '/w/sub' })
    await fire(f, 'CwdChanged', { old_cwd: '/w/sub', new_cwd: '/elsewhere', agent_id: 'sub-1' })
    await fire(f, 'CwdChanged', { old_cwd: '/w/sub', new_cwd: '/w/next' })
    expect(cwds).toEqual(['/w/sub', '/w/next'])
    await f.d.kill()
  })
})

describe('Claude compaction, notification and context observations', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Process and compaction observations
  test('a compacting status starts one observation and its boundary completes it on the turn; onCompaction is unchanged', async () => {
    const observations: CompactionObservation[] = []
    const compactions: string[] = []
    const f = await idle({ observers: { onCompactionObservation: (o) => observations.push(o), onCompaction: (c) => compactions.push(c.boundaryId) } })
    const handle = await f.d.send('go')
    f.q().push(
      system({ subtype: 'status', status: 'compacting', uuid: 'st-1' }),
      system({ subtype: 'status', status: 'compacting', uuid: 'st-2' }),
      system({ subtype: 'compact_boundary', uuid: 'b-1', compact_metadata: { trigger: 'manual', pre_tokens: 900, post_tokens: 300 } }),
      system({ subtype: 'compact_boundary', uuid: 'b-2', compact_metadata: { trigger: 'other', pre_tokens: 0 } }),
    )
    await f.q().drain()
    expect(compactions).toEqual(['b-1', 'b-2'])
    const [started, completed, bare] = observations
    expect(observations).toHaveLength(3)
    expect(started).toEqual({ trigger: 'unknown', startedAt: started!.startedAt, endedAt: null, preTokens: null, postTokens: null, durationSeconds: null, outcome: 'started', sourceId: 'start:st-1', turnId: handle.turnId })
    expect(typeof started!.startedAt).toBe('string')
    expect(completed).toEqual({ trigger: 'manual', startedAt: started!.startedAt, endedAt: completed!.endedAt, preTokens: 900, postTokens: 300, durationSeconds: completed!.durationSeconds, outcome: 'completed', sourceId: 'boundary:b-1', turnId: handle.turnId })
    expect(completed!.durationSeconds! >= 0 && Date.parse(completed!.endedAt!) >= Date.parse(started!.startedAt!)).toBe(true)
    // A boundary with no start before it: no start time or duration, unmeasured sizes null.
    expect([bare!.trigger, bare!.startedAt, bare!.durationSeconds, bare!.preTokens, bare!.postTokens, bare!.sourceId]).toEqual(['unknown', null, null, null, null, 'boundary:b-2'])
    await f.d.kill()
  })

  test('a notification passes timeout_ms as the second argument, and none without it', async () => {
    const calls: unknown[][] = []
    const f = await idle({ observers: { onNotification: (...args: [AgentNotification, number?]) => void calls.push(args) } })
    f.q().push(system({ subtype: 'notification', key: 'k1', text: 'with timeout', timeout_ms: 5000, uuid: 'n1' }), system({ subtype: 'notification', key: 'k2', text: 'plain', uuid: 'n2' }))
    await f.q().drain()
    expect(calls.map((args) => [(args[0] as AgentNotification).key, args.length, args[1]])).toEqual([['k1', 2, 5000], ['k2', 1, undefined]])
    await f.d.kill()
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Process and compaction observations
  test('context readings carry persist and the threshold source; a reset clears with persist', async () => {
    const contexts: Array<[number | null, ContextUsageMeta | undefined]> = []
    const f = await idle({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000' }, observers: { onContextUsage: (usage: ContextUsage | null, meta?: ContextUsageMeta) => void contexts.push([usage?.usedTokens ?? null, meta]) } })
    await f.d.send('go')
    f.q().push(
      system({ subtype: 'compact_boundary', uuid: 'b-1', compact_metadata: { trigger: 'auto', post_tokens: 300 } }),
      { type: 'stream_event', uuid: 'se-1', session_id: 'sess-saved', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm-1', usage: { input_tokens: 400, output_tokens: 1 } } } } as unknown as SDKMessage,
      { type: 'conversation_reset', uuid: 'cr-1', session_id: 'sess-saved' } as unknown as SDKMessage,
    )
    await f.q().drain()
    expect(contexts).toEqual([
      [300, { persist: true, thresholdSource: 'profile-window-fallback' }],
      [401, { persist: false, thresholdSource: 'profile-window-fallback' }],
      [null, { persist: true }],
    ])
    await f.d.kill()
  })
})

// Kawai's ChatSessionDriver.applyContextStep before the extraction: report
// threshold exact -> report-threshold; a report window -> report-window-fallback;
// a profile window with a report reserve -> profile-window-reserve, without ->
// profile-window-fallback; else model-window-fallback. A report or profile
// change persists; a request reading does not.
describe('context threshold source table', () => {
  type Step = (t: ContextTracker) => ReturnType<ContextTracker['readRequest']>
  const cases: Array<[string, Step[], string, boolean]> = [
    ['an exact report threshold', [(t) => t.readRequest(100, 'a'), (t) => t.applyReport({ autoCompactThreshold: 800 })], 'report-threshold', true],
    ['a report window with no reserve', [(t) => t.readRequest(100, 'a'), (t) => t.applyReport({ rawMaxTokens: 1000 })], 'report-window-fallback', true],
    ['a report window less its buffer reserve', [(t) => t.readRequest(100, 'a'), (t) => t.applyReport({ rawMaxTokens: 1000, categories: [{ kind: 'buffer', tokens: 200 }] })], 'report-threshold', true],
    ['a profile window alone', [(t) => t.readRequest(100, 'a'), (t) => t.setProfileWindow(1000)], 'profile-window-fallback', true],
    ['a profile window with a report reserve', [(t) => t.setProfileWindow(1000), (t) => t.readRequest(100, 'a'), (t) => t.applyReport({ categories: [{ kind: 'buffer', tokens: 200 }] })], 'profile-window-reserve', true],
    ['the model window', [(t) => t.noteModelWindow(2000), (t) => t.readRequest(100, 'a')], 'model-window-fallback', false],
    ['a request reading under a profile window', [(t) => t.setProfileWindow(1000), (t) => t.readRequest(100, 'a')], 'profile-window-fallback', false],
  ]
  test.each(cases)('%s', (_name, steps, label, persist) => {
    const tracker = new ContextTracker()
    let last: ReturnType<Step> = { kind: 'none' }
    for (const step of steps) last = step(tracker)
    if (last.kind !== 'reading') throw new Error(`expected a reading, got ${last.kind}`)
    const got: unknown[] = [tracker.thresholdLabel(last.usage), last.persist]
    expect(got).toEqual([label, persist])
  })
})

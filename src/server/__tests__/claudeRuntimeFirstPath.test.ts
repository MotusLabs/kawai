// First committed path of the Claude legacy-driver migration (task-602c71e9
// V2): original chatSessionDriver.test.ts cases run through Kawai's
// production composition (createChatDriver → claudeRuntime.ts → package
// core) over the fake query model, with the harness's joined cleanup, plus a
// raw callback failure reported once through that cleanup and the wiring
// witness that the query came from the package, not the in-tree class.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import { assistantText, flush, result } from './fixtures/chatDriverHarness'
import { cleanupHarnesses, createRuntimeHarness, type RuntimeHarness } from './fixtures/claudeRuntimeHarness'

let tempHome: string
const originalHome = process.env.HOME
beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatdriver-'))
  process.env.HOME = tempHome
})
afterEach(async () => {
  try {
    // The shared join: every harness since the last case, a failure no case
    // took through failure() reported once.
    await cleanupHarnesses()
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
const harness = (overrides?: Parameters<typeof createRuntimeHarness>[0]) => createRuntimeHarness(overrides)

test('error result leaves the session usable and reports the failure', async () => {
  const h = harness()
  h.driver.send('explode')
  const fake = await h.spawned()
  await h.admitted(1)
  fake.push(result('error_max_turns', { errors: ['Turn limit reached'], is_error: true }))
  await flush()

  const completed = h.events.find((e) => e.type === 'turn_completed')
  expect(completed).toMatchObject({ subtype: 'error_max_turns' })
  expect(completed && 'finalText' in completed).toBe(false)
  expect(h.events.find((e) => e.type === 'error')).toMatchObject({ message: 'Turn limit reached' })
  expect(h.statuses.at(-1)).toBe('waiting')
  expect(h.driver.isDead).toBe(false)

  // Still usable: a fresh turn runs on the same query.
  h.driver.send('again')
  expect(h.fakes).toHaveLength(1)
  expect(h.statuses.at(-1)).toBe('working')
})

test('two turns on one session: a result does not end the stream', async () => {
  const h = harness()
  h.driver.send('one')
  const fake = await h.spawned()
  await h.admitted(1)
  fake.push(assistantText('first answer', 'msg_1'))
  fake.push(result('success'))
  await flush()
  expect(h.fakes).toHaveLength(1)
  expect(h.driver.isDead).toBe(false)

  h.driver.send('two')
  await h.admitted(2)
  expect(h.fakes).toHaveLength(1) // same query reused
  fake.push(assistantText('second answer', 'msg_2'))
  fake.push(result('success'))
  await flush()

  const started = h.events.filter((e) => e.type === 'turn_started')
  const completed = h.events.filter((e) => e.type === 'turn_completed')
  expect(started).toHaveLength(2)
  expect(completed).toHaveLength(2)
  expect(completed[1]).toMatchObject({ finalText: 'all done' })
  expect(h.statuses).toEqual(['working', 'waiting', 'working', 'waiting'])
})

test('the query is the package composition: its policy hook, launch executable and prompt identity', async () => {
  const h = harness()
  h.driver.send('hello')
  const fake = await h.spawned()
  // The package's permission policy puts its deny hook first on PreToolUse;
  // the in-tree class registered only Kawai's audit hooks there.
  const pre = fake.options.hooks?.PreToolUse ?? []
  expect(pre.length).toBeGreaterThan(0)
  // The adapter's injected launch: the package passes its resolved executable.
  expect(fake.options.pathToClaudeCodeExecutable).toBe(process.execPath)
  // The prompt the package enqueued is the same text and UUID the transcript shows.
  const prompt = await fake.pullPrompt()
  expect(prompt?.message).toMatchObject({ role: 'user', content: 'hello' })
  const shown = h.events.find((e) => e.type === 'user_message') as { messageUuid?: string; turnId?: string } | undefined
  expect(typeof prompt?.uuid).toBe('string')
  expect(shown?.messageUuid).toBe(prompt!.uuid)
  const started = h.events.find((e) => e.type === 'turn_started') as { turnId?: string } | undefined
  expect(shown?.turnId).toBe(started!.turnId)
})

test('a rejected identity persistence reaches the joined cleanup raw, once', async () => {
  const boom = new Error('identity store down')
  // The identity callback's promise is the package's persistence barrier and owned (6.1 A5/A10).
  const h = createRuntimeHarness({ onSdkSessionId: (() => Promise.reject(boom)) as never })
  h.driver.send('hello')
  const fake = await h.spawned()
  await h.admitted(1)
  fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' } as unknown as SDKMessage)
  await flush()
  const first = h.cleanup()
  // Overlapping callers share the one cleanup.
  expect(h.cleanup()).toBe(first)
  const error = await first.then(() => null, (caught: unknown) => caught)
  const causes = error instanceof AgentRuntimeError ? error.causes : [error]
  expect(causes.filter((cause) => cause === boom)).toHaveLength(1)
  expect(fake.closed).toBe(true)
  // The same join answers later; nothing is reported twice.
  expect(await h.cleanup().then(() => null, (caught: unknown) => caught)).toBe(error)
  // Asserting that exact cause marks it reported, so the shared join does not report it again.
  await h.expectFailures(boom)
})

test('the legacy driver knobs the adapter never reads are refused, never dropped', () => {
  for (const knob of ['createTurnId', 'deterministicTurnIds'] as const) {
    expect(() => createRuntimeHarness({ [knob]: true } as never))
      .toThrow(`createRuntimeHarness: ${knob} is a legacy-driver knob the production adapter never reads`)
  }
})

test('cleanup reentered from the spawn-end audit the kill triggers shares the outside cleanup promise', async () => {
  // The adapter's stop reports the spawn's end to the outbound sink
  // synchronously inside kill(); a sink that reenters cleanup there must get
  // the promise the outside call already reserved, not a second body.
  const box: { h?: RuntimeHarness; reentered: Promise<void>[] } = { reentered: [] }
  const quiet = () => {}
  const h = createRuntimeHarness({
    outbound: {
      onPreToolUse: quiet, onPostToolUse: quiet, onPostToolUseFailure: quiet, onPermissionDenied: quiet, onDeniedCard: quiet,
      onSpawnEnd: () => void box.reentered.push(box.h!.cleanup()),
    },
  })
  box.h = h
  h.driver.send('hello')
  await h.spawned()
  await h.admitted(1)
  const first = h.cleanup()
  expect(box.reentered).toHaveLength(1)
  expect(box.reentered[0]).toBe(first)
  await first
  expect(h.fakes[0]!.closed).toBe(true)
})

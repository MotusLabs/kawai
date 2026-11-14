// The interrupt boundary's context re-read (task-602c71e9 R6, parent review
// findings-74686a77 F1; design §2): the retired driver re-resolved the
// context threshold when it interrupted an active turn, before any CLI
// result. Through Kawai's production composition (createChatDriver ->
// claudeRuntime.ts -> package core, over the fake query model), an
// interrupt that settles an active turn runs the existing context probe at
// once, with no result frame pushed. An interrupt with no active turn and a
// kill ask nothing; a rejecting probe reaches the joined cleanup raw, once.
// Each case is finite: one harness, a fixed number of frames.
import { afterEach, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { cleanupHarnesses, createHarness, flush, result } from './fixtures/chatDriverHarness'

afterEach(cleanupHarnesses)

const report = { categories: [], autoCompactThreshold: 167_000, totalTokens: 0, maxTokens: 200_000, rawMaxTokens: 200_000 }

/** A main-thread assistant frame whose request used 100000 input tokens. */
const usage = {
  type: 'assistant',
  uuid: 'usage-frame',
  session_id: 'sdk-1',
  parent_tool_use_id: null,
  message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
} as unknown as SDKMessage

// Reviewer reproduction /tmp/k602-review-interrupt-context.test.ts (SHA 4015df3f), committed.
// @covers: agent-runtime › Cooperative interrupt is distinct from forced stop › Claude interrupt re-reads the context report
test('the original interrupt boundary re-resolves context without a new CLI result stimulus', async () => {
  const h = createHarness({ contextImpl: async () => report })
  h.driver.send('hello')
  await h.admitted(1)
  const fake = h.fakes[0]!
  fake.push(usage)
  await flush()
  expect(fake.contextCalls).toHaveLength(1) // initialize only, mid-turn
  await h.driver.interrupt()
  await flush()
  // No result frame: exactly the original case's interrupt stimulus.
  expect(fake.contextCalls).toHaveLength(2)
  expect(fake.contextCalls.map((call) => call.detail)).toEqual(['summary', 'summary'])
})

test('an interrupt with no active turn asks for no context report', async () => {
  const h = createHarness({ contextImpl: async () => report })
  h.driver.send('hello')
  await h.admitted(1)
  const fake = h.fakes[0]!
  fake.push(usage)
  fake.push(result('success'))
  await flush()
  // initialize, then the turn's result: the turn is over.
  expect(fake.contextCalls).toHaveLength(2)
  await h.driver.interrupt()
  await flush()
  expect(fake.contextCalls).toHaveLength(2)
})

test('a kill during an active turn asks for no context report', async () => {
  const h = createHarness({ contextImpl: async () => report })
  h.driver.send('hello')
  await h.admitted(1)
  const fake = h.fakes[0]!
  fake.push(usage)
  await flush()
  expect(fake.contextCalls).toHaveLength(1)
  await h.cleanup()
  expect(fake.contextCalls).toHaveLength(1)
})

test('two interrupted turns each re-read the context report once', async () => {
  const h = createHarness({ contextImpl: async () => report })
  h.driver.send('first')
  await h.admitted(1)
  const fake = h.fakes[0]!
  fake.push(usage)
  await flush()
  await h.driver.interrupt()
  await flush()
  expect(fake.contextCalls).toHaveLength(2)
  h.driver.send('second')
  await h.admitted(2)
  await flush()
  // The second turn's prompt opens no probe of its own until it is interrupted.
  expect(fake.contextCalls).toHaveLength(2)
  await h.driver.interrupt()
  await flush()
  expect(fake.contextCalls).toHaveLength(3)
})

test('a rejecting interrupt-boundary probe reaches the joined cleanup raw, once', async () => {
  const boom = new Error('context probe failed at the interrupt')
  let calls = 0
  const h = createHarness({ contextImpl: async () => (++calls === 1 ? report : Promise.reject(boom)) })
  h.driver.send('hello')
  await h.admitted(1)
  const fake = h.fakes[0]!
  fake.push(usage)
  await flush()
  await h.driver.interrupt()
  await flush()
  expect(calls).toBe(2)
  await h.expectFailures(boom)
})

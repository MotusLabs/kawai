// Question auto-answer hold (openspec question-auto-answer, task 2.3):
// holdQuestion's refusals and effect on the driver, over the manual clock.
// The design's "Acceptance oracles" QA-* ids name the row each test pins.
import { expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatPendingRequest } from '../../shared/chat'
import {
  createHarness,
  flush,
} from './fixtures/chatDriverHarness'
import { ManualClock } from './fixtures/manualClock'

const WAIT_MS = 60_000

interface QuestionSpec {
  question: string
  multiSelect?: boolean
  options: string[]
}

function questionInput(specs: QuestionSpec[]): Record<string, unknown> {
  return {
    questions: specs.map((spec) => ({
      question: spec.question,
      header: spec.question,
      multiSelect: spec.multiSelect === true,
      options: spec.options.map((label) => ({ label })),
    })),
  }
}

/** One canUseTool question ask, with its bridge promise and abort handle. */
function askQuestionRaw(
  harness: ReturnType<typeof createHarness>,
  specs: QuestionSpec[],
  toolUseID = 'q1'
): { promise: Promise<PermissionResult | null>; abort: () => void } {
  const fake = harness.fakes[0]!
  const controller = new AbortController()
  const promise = fake.options.canUseTool!(
    'AskUserQuestion',
    questionInput(specs),
    { signal: controller.signal, toolUseID, requestId: 'r' }
  ) as Promise<PermissionResult | null>
  return { promise, abort: () => controller.abort() }
}

/** Ask one question through the fake query's canUseTool and settle plumbing. */
async function askQuestion(
  harness: ReturnType<typeof createHarness>,
  specs: QuestionSpec[],
  toolUseID = 'q1'
): Promise<void> {
  void askQuestionRaw(harness, specs, toolUseID).promise
  await flush()
}

function questionRequests(events: ChatEvent[]): Array<Extract<ChatEvent, { type: 'question_request' }>> {
  return events.filter((event): event is Extract<ChatEvent, { type: 'question_request' }> =>
    event.type === 'question_request')
}

function snapshotOf(harness: ReturnType<typeof createHarness>, requestId: string) {
  return harness.driver
    .getPendingRequests()
    .find((pending): pending is Extract<ChatPendingRequest, { kind: 'question' }> =>
      pending.kind === 'question' && pending.requestId === requestId)
}

/**
 * Await a settlement promise bounded by a real 100 ms timer, so a mutant
 * that never settles fails the assertion instead of hanging the run (bun's
 * test timeout does not interrupt `await expect(p).resolves`).
 */
async function bounded(promise: Promise<PermissionResult | null>): Promise<PermissionResult | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ])
}

test('holdQuestion refuses unknown, non-question, deadline-less, settled, and cancelled requests (QA-13, QA-16, QA-19, QA-U2)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')

  expect(harness.driver.holdQuestion('no-such-id')).toMatchObject({ ok: false })

  // Deadline-less: an unmarked question (and an approval) refuse a hold.
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes', 'No'] }], 'q-unmarked')
  const unmarked = questionRequests(harness.events).at(-1)!
  expect(harness.driver.holdQuestion(unmarked.requestId)).toMatchObject({
    ok: false,
    error: expect.stringContaining('no auto-answer deadline'),
  })
  expect(harness.events.filter((event) => event.type === 'question_auto_answer_held')).toHaveLength(0)

  // Settled by the timeout: refused like any late attempt (QA-13).
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }], 'q-timeout')
  try {
    await flush()
    const marked = questionRequests(harness.events).at(-1)!
    clock.advance(WAIT_MS)
    const settled = await bounded(ask.promise)
    expect(settled).toMatchObject({ behavior: 'allow' })
    expect(harness.driver.holdQuestion(marked.requestId)).toMatchObject({ ok: false })

    // Settled by the user: refused too (QA-16).
    const ask2 = askQuestionRaw(harness, [{ question: 'Merge?', options: ['Later (Recommended)', 'Now'] }], 'q-user')
    await flush()
    const userMarked = questionRequests(harness.events).at(-1)!
    expect(harness.driver.answerQuestion(userMarked.requestId, { 'Merge?': { options: ['Now'] } })).toEqual({ ok: true })
    await bounded(ask2.promise)
    expect(harness.driver.holdQuestion(userMarked.requestId)).toMatchObject({ ok: false })

    // Cancelled: the request is gone, so the refusal names it unknown (QA-19).
    const ask3 = askQuestionRaw(harness, [{ question: 'Ship?', options: ['Go (Recommended)', 'Hold'] }], 'q-cancel')
    await flush()
    const cancelled = questionRequests(harness.events).at(-1)!
    ask3.abort()
    await bounded(ask3.promise)
    expect(harness.driver.holdQuestion(cancelled.requestId)).toMatchObject({ ok: false })

    expect(harness.events.filter((event) => event.type === 'question_auto_answer_held')).toHaveLength(0)
  } finally {
    harness.driver.kill()
  }
})

test('a hold drops the deadline: held event, no autoAnswer in the snapshot, never auto-answers (QA-3, QA-21)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  const request = questionRequests(harness.events).at(-1)!
  expect(clock.pendingCount).toBe(1)

  expect(harness.driver.holdQuestion(request.requestId)).toEqual({ ok: true })
  expect(clock.pendingCount).toBe(0)
  expect(snapshotOf(harness, request.requestId)?.autoAnswer).toBeUndefined()
  const held = harness.events.find((event) => event.type === 'question_auto_answer_held') as
    | Extract<ChatEvent, { type: 'question_auto_answer_held' }>
  expect(held).toMatchObject({ type: 'question_auto_answer_held', requestId: request.requestId })
  // QA-3: still `permission`, waiting for the user.
  expect(harness.statuses.at(-1)).toBe('permission')

  clock.advance(WAIT_MS * 1000)
  await flush()
  expect(harness.events.filter((event) => event.type === 'request_resolved')).toHaveLength(0)
  expect(harness.driver.getPendingRequests()).toHaveLength(1)
})

test('after a hold the user answers ordinarily and a second hold is refused (QA-22, QA-23)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  try {
    await flush()
    const request = questionRequests(harness.events).at(-1)!
    expect(harness.driver.holdQuestion(request.requestId)).toEqual({ ok: true })

    // A second hold refuses: no deadline stands (QA-23, D4).
    expect(harness.driver.holdQuestion(request.requestId)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no auto-answer deadline'),
    })

    expect(harness.driver.answerQuestion(request.requestId, { 'Deploy?': { options: ['No'] } })).toEqual({ ok: true })
    const settled = await bounded(ask.promise)
    expect(settled).toMatchObject({ behavior: 'allow' })
    const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]).toMatchObject({ decidedBy: 'user' })
    expect(harness.events.some((event) =>
      event.type === 'request_resolved' &&
      (event as { decidedBy?: string }).decidedBy === 'timeout')).toBe(false)
  } finally {
    harness.driver.kill()
  }
})


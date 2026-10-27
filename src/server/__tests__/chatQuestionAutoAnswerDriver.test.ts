// Question auto-answer deadline (openspec question-auto-answer, tasks 2.1–2.3):
// creation (2.1), timer settlement and clearing (2.2), and hold (2.3) on the
// driver, over the manual clock (design's timerScheduler seam). The design's
// "Acceptance oracles" QA-* ids name the row each test pins.
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

test('a fully recommended question gets a deadline: event and snapshot carry autoAnswer at +wait (QA-1)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer).toBeDefined()
  expect(request.autoAnswer!.answers).toEqual({
    'Deploy?': { options: ['Yes (Recommended)'] },
  })

  const snapshot = snapshotOf(harness, request.requestId)
  expect(snapshot).toMatchObject({
    kind: 'question',
    autoAnswer: { at: request.autoAnswer!.at },
  })
  // The deadline is the request's creation instant plus the wait (the
  // snapshot's `at` is that instant; the event's is the later emit stamp).
  expect(Date.parse(request.autoAnswer!.at) - Date.parse(snapshot!.at)).toBe(WAIT_MS)
  expect(harness.statuses.at(-1)).toBe('permission')
  // One live timer stands behind the deadline.
  expect(clock.pendingCount).toBe(1)
  harness.driver.kill()
})

test('an unmarked question never gets a deadline (QA-8, QA-U1, QA-P3)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes', 'No'] }])

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer).toBeUndefined()
  expect(snapshotOf(harness, request.requestId)?.autoAnswer).toBeUndefined()
  expect(clock.pendingCount).toBe(0)
  harness.driver.kill()
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › Question without a recommendation keeps waiting
test('a partially recommended request never gets a deadline (spec: keeps waiting)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [
    { question: 'Deploy?', options: ['Yes (Recommended)', 'No'] },
    { question: 'Notify?', options: ['Slack', 'Email'] },
  ])

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer).toBeUndefined()
  expect(clock.pendingCount).toBe(0)
  harness.driver.kill()
})

test('a zero wait sets no deadline even for a full recommendation (QA-S2)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => 0,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer).toBeUndefined()
  expect(clock.pendingCount).toBe(0)
  harness.driver.kill()
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › A Codex chat question waits for the user
test('without the option the driver sets no deadline (QA-U4 driver half)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({ timerScheduler: clock })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer).toBeUndefined()
  expect(clock.pendingCount).toBe(0)
  harness.driver.kill()
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › Multi-select takes every recommendation
test('multi-select takes every recommended label into the deadline answers (spec: multi-select)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [
    { question: 'Modules?', multiSelect: true, options: ['A (Recommended)', 'B', 'C (Recommended)'] },
  ])

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer!.answers).toEqual({
    'Modules?': { options: ['A (Recommended)', 'C (Recommended)'] },
  })
  harness.driver.kill()
})

test('the wait is read per question: a later question uses the new value and the pending deadline stands (QA-P4)', async () => {
  const clock = new ManualClock()
  let minutes = 5
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => minutes * WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }], 'q1')
  const first = questionRequests(harness.events).at(-1)!
  const firstDeadline = first.autoAnswer!.at

  minutes = 10
  await askQuestion(harness, [{ question: 'Merge?', options: ['Later (Recommended)', 'Now'] }], 'q2')
  const second = questionRequests(harness.events).at(-1)!

  expect(Date.parse(second.autoAnswer!.at) - Date.parse(snapshotOf(harness, second.requestId)!.at)).toBe(10 * WAIT_MS)
  // The first request's deadline did not move.
  expect(snapshotOf(harness, first.requestId)?.autoAnswer?.at).toBe(firstDeadline)
  harness.driver.kill()
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › Unanswered question takes the recommendation
test('the deadline answers with the recommendation, the D3 note, and timeout decided-by (QA-1)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  try {
    await flush()

    clock.advance(WAIT_MS)
    const settled = await bounded(ask.promise)
    expect(settled).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { 'Deploy?': 'Yes (Recommended)' },
        response: 'No answer from the user within 1 minute; the recommended option was selected automatically.',
      },
    })
    const resolved = harness.events.find((event) => event.type === 'request_resolved') as
      | Extract<ChatEvent, { type: 'request_resolved' }>
    expect(resolved).toMatchObject({
      outcome: 'answered',
      decidedBy: 'timeout',
      answers: { 'Deploy?': 'Yes (Recommended)' },
    })
    // QA-1: the session leaves permission and the agent continues — the turn
    // is still in flight, so `working`, not `permission`.
    expect(harness.statuses.at(-1)).toBe('working')
    expect(harness.driver.getPendingRequests()).toHaveLength(0)
    expect(clock.pendingCount).toBe(0)
  } finally {
    // Drain the bridge promise even when an assertion above fails, so a
    // mutant run fails cleanly instead of wedging bun's exit.
    harness.driver.kill()
  }
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › Applies under either approval policy
test('a recommended question arms and settles under either approval policy (spec: approval policies)', async () => {
  for (const policy of ['manual', 'auto'] as const) {
    const clock = new ManualClock()
    const harness = createHarness({
      getApprovalPolicy: () => policy,
      getQuestionAutoAnswerMs: () => WAIT_MS,
      timerScheduler: clock,
    })
    harness.driver.send('ask')
    const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
    try {
      await flush()
      const request = questionRequests(harness.events).at(-1)!
      // Either policy arms the deadline, with the original labels in its answers.
      expect(request.autoAnswer).toBeDefined()
      expect(clock.pendingCount).toBe(1)
      expect(request.autoAnswer!.answers).toEqual({
        'Deploy?': { options: ['Yes (Recommended)'] },
      })
      // The timed settlement submits that exact original label, once.
      clock.advance(WAIT_MS)
      const settled = await bounded(ask.promise)
      expect(settled).toMatchObject({
        behavior: 'allow',
        updatedInput: { answers: { 'Deploy?': 'Yes (Recommended)' } },
      })
      const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
      expect(resolutions).toHaveLength(1)
      expect(resolutions[0]).toMatchObject({ outcome: 'answered', decidedBy: 'timeout' })
    } finally {
      harness.driver.kill()
      await bounded(ask.promise)
    }
  }
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › User answers before the deadline
test('a user answer before the deadline wins and no second settlement follows (QA-2, QA-15)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  await flush()
  const request = questionRequests(harness.events).at(-1)!

  expect(harness.driver.answerQuestion(request.requestId, { 'Deploy?': { options: ['No'] } })).toEqual({ ok: true })
  await expect(ask.promise).resolves.toMatchObject({ behavior: 'allow' })
  expect(clock.pendingCount).toBe(0)

  clock.advance(WAIT_MS * 10)
  await flush()
  const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
  expect(resolutions).toHaveLength(1)
  expect(resolutions[0]).toMatchObject({ decidedBy: 'user' })
})

test('a second user answer after the timeout is refused stale (QA-12)', async () => {
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

    clock.advance(WAIT_MS)
    const settled = await bounded(ask.promise)
    expect(settled).toMatchObject({ behavior: 'allow' })
    const late = harness.driver.answerQuestion(request.requestId, { 'Deploy?': { options: ['No'] } })
    expect(late).toMatchObject({ ok: false })
    expect(harness.events.filter((event) => event.type === 'request_resolved')).toHaveLength(1)
  } finally {
    harness.driver.kill()
  }
})

// @covers: chat-sessions › Recommended answers are taken after a configurable wait › Cancelled request is never auto-answered
test('an abort before the deadline cancels and never auto-answers (QA-5, QA-20)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  await flush()

  ask.abort()
  await expect(ask.promise).resolves.toMatchObject({ behavior: 'deny' })
  expect(clock.pendingCount).toBe(0)
  clock.advance(WAIT_MS * 10)
  await flush()
  const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
  expect(resolutions).toHaveLength(1)
  expect(resolutions[0]).toMatchObject({ outcome: 'cancelled' })
  expect(harness.events.some((event) =>
    event.type === 'request_resolved' &&
    (event as { decidedBy?: string }).decidedBy === 'timeout')).toBe(false)
})

test('a kill before the deadline cancels and never auto-answers (QA-6)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  await flush()

  harness.driver.kill()
  await expect(ask.promise).resolves.toMatchObject({ behavior: 'deny' })
  expect(clock.pendingCount).toBe(0)
  clock.advance(WAIT_MS * 10)
  await flush()
  const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
  expect(resolutions).toHaveLength(1)
  expect(resolutions[0]).toMatchObject({ outcome: 'cancelled' })
})

test('an orderly shutdown settles like a kill and never auto-answers (QA-7)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  await flush()

  harness.driver.shutdown()
  await expect(ask.promise).resolves.toMatchObject({ behavior: 'deny' })
  expect(clock.pendingCount).toBe(0)
  clock.advance(WAIT_MS * 10)
  await flush()
  expect(harness.events.filter((event) => event.type === 'request_resolved')).toHaveLength(1)
  expect(harness.events.some((event) =>
    event.type === 'request_resolved' &&
    (event as { decidedBy?: string }).decidedBy === 'timeout')).toBe(false)
})

test('a refused user answer consumes nothing: the deadline still settles first (advisor C1 #1)', async () => {
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

    // Both an option and own text is refused; the request stays pending.
    expect(harness.driver.answerQuestion(request.requestId, {
      'Deploy?': { options: ['No'], text: 'mine' },
    })).toMatchObject({ ok: false })
    expect(harness.driver.getPendingRequests()).toHaveLength(1)

    clock.advance(WAIT_MS)
    const settled = await bounded(ask.promise)
    expect(settled).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Deploy?': 'Yes (Recommended)' } },
    })
    expect(harness.events.filter((event) => event.type === 'request_resolved')).toHaveLength(1)
  } finally {
    harness.driver.kill()
  }
})

test('a process crash before the deadline cancels and never auto-answers (QA-6 crash leg)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  await flush()

  // The markDead funnel (runQueryLoop's exit path) must clear the timer like
  // kill and shutdown do — only kill() was driven before (C2 follow-up B).
  harness.fakes[0]!.exit()
  await flush()
  expect(harness.driver.isDead).toBe(true)
  await expect(ask.promise).resolves.toMatchObject({ behavior: 'deny' })
  expect(clock.pendingCount).toBe(0)
  clock.advance(WAIT_MS * 10)
  await flush()
  const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
  expect(resolutions).toHaveLength(1)
  expect(resolutions[0]).toMatchObject({ outcome: 'cancelled' })
  expect(harness.events.some((event) =>
    event.type === 'request_resolved' &&
    (event as { decidedBy?: string }).decidedBy === 'timeout')).toBe(false)
})

test('a callback arriving after a kill arms no deadline (advisor C1 #3)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await flush()
  harness.driver.kill()
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }], 'q-after-kill')

  const request = questionRequests(harness.events).at(-1)!
  expect(request.autoAnswer).toBeUndefined()
  expect(clock.pendingCount).toBe(0)
  clock.advance(WAIT_MS * 10)
  await flush()
  expect(harness.events.some((event) =>
    event.type === 'request_resolved' &&
    (event as { decidedBy?: string }).decidedBy === 'timeout')).toBe(false)
})

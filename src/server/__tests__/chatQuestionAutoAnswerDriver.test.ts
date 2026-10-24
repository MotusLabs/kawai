// Question auto-answer deadline (openspec question-auto-answer, tasks 2.1–2.3):
// creation (2.1), timer settlement and clearing (2.2), and hold (2.3) on the
// driver, over the manual clock (design's timerScheduler seam). The design's
// "Acceptance oracles" QA-* ids name the row each test pins.
import { expect, test } from 'bun:test'
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

/** Ask one question through the fake query's canUseTool and settle plumbing. */
async function askQuestion(
  harness: ReturnType<typeof createHarness>,
  specs: QuestionSpec[],
  toolUseID = 'q1'
): Promise<void> {
  const fake = harness.fakes[0]!
  void fake.options.canUseTool!(
    'AskUserQuestion',
    questionInput(specs),
    { signal: new AbortController().signal, toolUseID, requestId: 'r' }
  )
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

  expect(Date.parse(second.autoAnswer!.at) - Date.parse(second.at)).toBe(10 * WAIT_MS)
  // The first request's deadline did not move.
  expect(snapshotOf(harness, first.requestId)?.autoAnswer?.at).toBe(firstDeadline)
  harness.driver.kill()
})

test('a fired deadline settles nothing before settlement lands (2.1 interim)', async () => {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  await askQuestion(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])

  clock.advance(WAIT_MS)
  await flush()
  // Settlement is task 2.2: a fired deadline answers nothing yet, and the
  // question keeps waiting.
  expect(harness.events.some((event) => event.type === 'request_resolved')).toBe(false)
  expect(harness.driver.getPendingRequests()).toHaveLength(1)
  // Drain the pending question so its bridge promise resolves.
  harness.driver.kill()
})

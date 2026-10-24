// Stale deadline callbacks (question-auto-answer review F1, task revision 3):
// settleByAutoAnswer's guard must make a callback that fires after a hold or
// after a user answer inert. The manual clock cancels synchronously, so a
// KeepCancelledScheduler keeps every cancelled callback invocable and the
// test fires it by hand — the cleared-fields mutant dies in the hold run,
// the settled mutant in the user-answer run, each seen one at a time.
import { expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatPendingRequest } from '../../shared/chat'
import type { ChatTimerScheduler } from '../chat/timerScheduler'
import { createHarness, flush } from './fixtures/chatDriverHarness'

const WAIT_MS = 60_000

/**
 * Cancels drop the timer from the pending set but keep its closure: the
 * driver believes the deadline is gone while the test can still invoke the
 * stale callback exactly as a lost race would.
 */
class KeepCancelledScheduler implements ChatTimerScheduler {
  private nextId = 1
  private readonly scheduled = new Map<number, () => void>()
  private readonly cancelled: Array<() => void> = []

  schedule(_ms: number, fire: () => void): unknown {
    const id = this.nextId++
    this.scheduled.set(id, fire)
    return id
  }

  cancel(handle: unknown): void {
    const fire = this.scheduled.get(handle as number)
    if (fire === undefined) return
    this.scheduled.delete(handle as number)
    this.cancelled.push(fire)
  }

  /** Invoke every callback cancelled so far, in cancel order. */
  fireCancelled(): void {
    for (const fire of this.cancelled.splice(0)) fire()
  }

  get pendingCount(): number {
    return this.scheduled.size
  }
}

interface QuestionSpec {
  question: string
  options: string[]
}

function askQuestionRaw(
  harness: ReturnType<typeof createHarness>,
  specs: QuestionSpec[],
  toolUseID = 'q1'
): Promise<PermissionResult | null> {
  const fake = harness.fakes[0]!
  return fake.options.canUseTool!('AskUserQuestion', {
    questions: specs.map((spec) => ({
      question: spec.question,
      header: spec.question,
      multiSelect: false,
      options: spec.options.map((label) => ({ label })),
    })),
  }, { signal: new AbortController().signal, toolUseID, requestId: 'r' }) as Promise<PermissionResult | null>
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
 * that settles (or a regression that hangs) fails the assertion instead of
 * wedging the run.
 */
async function bounded(promise: Promise<PermissionResult | null>): Promise<PermissionResult | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ])
}

test('a deadline callback firing after a hold settles nothing (review F1)', async () => {
  const scheduler = new KeepCancelledScheduler()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: scheduler,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  try {
    await flush()
    const request = questionRequests(harness.events).at(-1)!
    expect(request.autoAnswer).toBeDefined()
    expect(scheduler.pendingCount).toBe(1)

    expect(harness.driver.holdQuestion(request.requestId)).toEqual({ ok: true })
    expect(scheduler.pendingCount).toBe(0)
    expect(snapshotOf(harness, request.requestId)?.autoAnswer).toBeUndefined()

    // The cancelled callback races anyway: the guard reads the cleared
    // deadline fields and returns before anything settles.
    scheduler.fireCancelled()
    await flush()
    expect(harness.driver.getPendingRequests()).toHaveLength(1)
    expect(harness.events.some((event) => event.type === 'request_resolved')).toBe(false)
    expect(await bounded(ask)).toBeNull()
  } finally {
    harness.driver.kill()
  }
})

test('a deadline callback firing after a user answer never settles twice (review F1)', async () => {
  const scheduler = new KeepCancelledScheduler()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: scheduler,
  })
  harness.driver.send('ask')
  const ask = askQuestionRaw(harness, [{ question: 'Deploy?', options: ['Yes (Recommended)', 'No'] }])
  try {
    await flush()
    const request = questionRequests(harness.events).at(-1)!
    expect(harness.driver.answerQuestion(request.requestId, { 'Deploy?': { options: ['No'] } })).toEqual({ ok: true })
    await expect(ask).resolves.toMatchObject({ behavior: 'allow' })
    expect(scheduler.pendingCount).toBe(0)

    scheduler.fireCancelled()
    await flush()
    const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]).toMatchObject({ decidedBy: 'user' })
    expect(harness.driver.getPendingRequests()).toHaveLength(0)
  } finally {
    harness.driver.kill()
  }
})

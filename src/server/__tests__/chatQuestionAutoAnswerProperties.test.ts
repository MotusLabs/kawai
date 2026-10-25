// Question auto-answer seeded properties (openspec question-auto-answer,
// design "Properties"): QA-P1..P4 over the driver's manual-clock seam and the
// public entry points, plain generators with no new dependency. Fixed seed
// 20261024 for every property; the design pins the case counts.
import { expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatPendingRequest, ChatQuestion } from '../../shared/chat'
import { recommendationCases } from './fixtures/recommendationCases'
import {
  createHarness,
  flush,
} from './fixtures/chatDriverHarness'
import { ManualClock } from './fixtures/manualClock'

const WAIT_MS = 60_000
const SEED = 20261024

/** mulberry32: a tiny seeded PRNG — the design forbids a new dependency. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

interface QuestionSpec {
  question: string
  multiSelect?: boolean
  options: Array<string | ChatQuestion['options'][number]>
}

function questionInput(specs: QuestionSpec[]): Record<string, unknown> {
  return {
    questions: specs.map((spec) => ({
      question: spec.question,
      header: spec.question,
      multiSelect: spec.multiSelect === true,
      options: spec.options.map((option) => typeof option === 'string' ? { label: option } : option),
    })),
  }
}

function askRaw(
  harness: ReturnType<typeof createHarness>,
  specs: QuestionSpec[],
  toolUseID: string
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

/** Await a settlement bounded by a real 100 ms timer so a defect fails fast. */
async function bounded(promise: Promise<PermissionResult | null>): Promise<PermissionResult | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ])
}

const MARKED: QuestionSpec[] = [
  { question: 'Deploy?', options: ['Yes (Recommended)', 'No'] },
]
const USER_ANSWERS = { 'Deploy?': { options: ['Yes (Recommended)'] } }

type Attempt = 'user-answer' | 'wait-for-me' | 'form-edit' | 'cancel' | 'timer'
const ATTEMPTS: Attempt[] = ['user-answer', 'wait-for-me', 'form-edit', 'cancel', 'timer']

/** The expected state after each attempt, to pin every attempt's outcome. */
interface Sim {
  resolutions: number
  decidedBy: 'user' | 'timeout' | undefined
  outcome: 'answered' | 'cancelled' | undefined
}

/**
 * One QA-P1 case: run a shuffled attempt sequence against a fresh driver.
 * Attempts are synchronous and never advance the clock — only the timer
 * attempt does — so every run's non-timer attempts arrive on the same fake
 * tick, and the second pass moves the fire after all of them (the design's
 * "same-tick arrivals").
 */
async function runP1Case(sequence: Attempt[], timerLast: boolean): Promise<void> {
  const clock = new ManualClock()
  const harness = createHarness({
    getQuestionAutoAnswerMs: () => WAIT_MS,
    timerScheduler: clock,
  })
  harness.driver.send('ask')
  const ask = askRaw(harness, MARKED, 'q-p1')
  try {
    await flush()
    const sim: Sim = { resolutions: 0, decidedBy: undefined, outcome: undefined }
    let held = false
    const ordered = timerLast
      ? [...sequence.filter((a) => a !== 'timer'), ...sequence.filter((a) => a === 'timer')]
      : sequence
    for (const attempt of ordered) {
      const pending = harness.driver.getPendingRequests().at(-1)
      const id = pending?.requestId ?? 'gone'
      switch (attempt) {
        case 'user-answer': {
          const result = harness.driver.answerQuestion(id, USER_ANSWERS)
          if (sim.resolutions === 0) {
            expect(result).toEqual({ ok: true })
            sim.resolutions = 1
            sim.decidedBy = 'user'
            sim.outcome = 'answered'
          } else {
            expect(result.ok).toBe(false)
          }
          break
        }
        case 'wait-for-me':
        case 'form-edit': {
          const result = harness.driver.holdQuestion(id)
          if (sim.resolutions === 0) {
            // Succeeds only while the deadline stands; a second hold refuses.
            expect(result.ok).toBe(!held)
            held = true
          } else {
            expect(result.ok).toBe(false)
          }
          break
        }
        case 'cancel': {
          if (sim.resolutions === 0) {
            ask.abort()
            sim.resolutions = 1
            sim.decidedBy = undefined
            sim.outcome = 'cancelled'
          }
          break
        }
        case 'timer': {
          // Read before the advance: a due timer settles synchronously and
          // empties the map, so the standing check must precede it.
          const deadlineStanding = harness.driver.getPendingRequests().some(
            (candidate) => candidate.kind === 'question' && candidate.autoAnswer !== undefined
          )
          clock.advance(WAIT_MS)
          if (sim.resolutions === 0 && deadlineStanding) {
            sim.resolutions = 1
            sim.decidedBy = 'timeout'
            sim.outcome = 'answered'
          }
          break
        }
      }
    }
    await flush()
    const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
    expect(resolutions).toHaveLength(sim.resolutions)
    if (sim.resolutions === 1) {
      expect(resolutions[0]).toMatchObject({
        outcome: sim.outcome,
        ...(sim.decidedBy !== undefined ? { decidedBy: sim.decidedBy } : {}),
      })
      await bounded(ask.promise)
    }
  } finally {
    harness.driver.kill()
    await bounded(ask.promise)
  }
}

test('QA-P1: a request settles exactly once under any interleaving (500 seeded sequences)', async () => {
  const random = rng(SEED)
  for (let i = 0; i < 500; i++) {
    const length = 1 + Math.floor(random() * 5)
    const sequence = shuffle(ATTEMPTS, random).slice(0, length)
    await runP1Case(sequence, false)
    // The same sequence with the fire on the same tick as every other
    // attempt (all attempts first, then the deadline).
    await runP1Case(sequence, true)
  }
}, 120_000)

test('QA-P2: a held question never auto-answers, at any hold instant (200 seeded cases)', async () => {
  const random = rng(SEED)
  for (let i = 0; i < 200; i++) {
    // Hold uniform over [0, wait); the advance is wait x k for k in {1,10,1000}.
    const holdAt = Math.floor(random() * WAIT_MS)
    const k = [1, 10, 1000][Math.floor(random() * 3)]!
    const clock = new ManualClock()
    const harness = createHarness({
      getQuestionAutoAnswerMs: () => WAIT_MS,
      timerScheduler: clock,
    })
    harness.driver.send('ask')
    const ask = askRaw(harness, MARKED, `q-p2-${i}`)
    try {
      await flush()
      const request = questionRequests(harness.events).at(-1)!
      clock.advance(holdAt)
      expect(harness.driver.holdQuestion(request.requestId)).toEqual({ ok: true })
      expect(snapshotOf(harness, request.requestId)?.autoAnswer).toBeUndefined()

      clock.advance(WAIT_MS * k)
      await flush()
      expect(harness.events.filter((event) => event.type === 'request_resolved')).toHaveLength(0)
      expect(harness.driver.getPendingRequests()).toHaveLength(1)

      expect(harness.driver.answerQuestion(request.requestId, {
        'Deploy?': { options: ['No'] },
      })).toEqual({ ok: true })
      const settled = await bounded(ask.promise)
      expect(settled).toMatchObject({ behavior: 'allow' })
      const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
      expect(resolutions).toHaveLength(1)
      expect(resolutions[0]).toMatchObject({ outcome: 'answered', decidedBy: 'user' })
    } finally {
      harness.driver.kill()
      await bounded(ask.promise)
    }
  }
}, 120_000)

test('QA-P3: a deadline exists iff a full recommendation and a positive wait (300 seeded cases)', async () => {
  const random = rng(SEED)
  for (let i = 0; i < 300; i++) {
    const count = 1 + Math.floor(random() * 3)
    const marked: boolean[] = []
    const specs: QuestionSpec[] = Array.from({ length: count }, (_, q) => {
      const optionCount = Math.floor(random() * 5)
      const fixtures = Array.from({ length: optionCount }, () =>
        recommendationCases[Math.floor(random() * recommendationCases.length)]!)
      // The oracle is independently classified fixture data, never the
      // detector under test or a regex that repeats its implementation.
      marked.push(fixtures.some((fixture) => fixture.matches))
      const options = fixtures.map((fixture) => fixture.option)
      return {
        question: `Q${q}?`,
        multiSelect: random() < 0.5,
        options,
      }
    })
    const waitPositive = random() < 0.5
    const expected = marked.every(Boolean) && waitPositive

    const clock = new ManualClock()
    const harness = createHarness({
      getQuestionAutoAnswerMs: () => (waitPositive ? WAIT_MS : 0),
      timerScheduler: clock,
    })
    harness.driver.send('ask')
    try {
      void askRaw(harness, specs, `q-p3-${i}`).promise
      await flush()
      const request = questionRequests(harness.events).at(-1)!
      expect(request !== undefined && request.autoAnswer !== undefined).toBe(expected)
      expect(snapshotOf(harness, request?.requestId ?? '')?.autoAnswer !== undefined).toBe(expected)
      expect(clock.pendingCount).toBe(expected ? 1 : 0)
    } finally {
      harness.driver.kill()
    }
  }
}, 120_000)

test('QA-P4: a setting change never moves a pending deadline (200 seeded triples)', async () => {
  const random = rng(SEED)
  const MINUTES = [0, 1, 5, 1440]
  for (let i = 0; i < 200; i++) {
    const initialMinutes = MINUTES[Math.floor(random() * MINUTES.length)]!
    const newMinutes = MINUTES[Math.floor(random() * MINUTES.length)]!
    const initialMs = initialMinutes * 60_000
    let minutes = initialMinutes
    const clock = new ManualClock()
    const harness = createHarness({
      getQuestionAutoAnswerMs: () => minutes * 60_000,
      timerScheduler: clock,
    })
    harness.driver.send('ask')
    const first = askRaw(harness, MARKED, `q-p4a-${i}`)
    let second: ReturnType<typeof askRaw> | null = null
    try {
      await flush()
      const firstRequest = questionRequests(harness.events).at(-1)!
      minutes = newMinutes

      if (initialMinutes === 0) {
        // No deadline stands; the change instant is degenerate.
        expect(firstRequest.autoAnswer).toBeUndefined()
      } else {
        const deadline = firstRequest.autoAnswer!.at
        const changeAt = Math.floor(random() * initialMs)
        clock.advance(changeAt)
        // The pending deadline is untouched and still fires at its original
        // instant, whatever the new value (even 0).
        expect(snapshotOf(harness, firstRequest.requestId)?.autoAnswer?.at).toBe(deadline)
        clock.advance(initialMs - changeAt)
        const settled = await bounded(first.promise)
        expect(settled).toMatchObject({ behavior: 'allow' })
        const resolutions = harness.events.filter((event) => event.type === 'request_resolved')
        expect(resolutions).toHaveLength(1)
        expect(resolutions[0]).toMatchObject({ outcome: 'answered', decidedBy: 'timeout' })
      }

      // Only a question created after the change reads the new value.
      second = askRaw(harness, MARKED, `q-p4b-${i}`)
      await flush()
      const secondRequest = questionRequests(harness.events).at(-1)!
      if (newMinutes === 0) {
        // No deadline; the question waits and the finally's kill settles it.
        expect(secondRequest.autoAnswer).toBeUndefined()
      } else {
        // The deadline derives from the request's creation instant (the
        // snapshot's `at`), not the later emit stamp on the event.
        const secondSnapshot = snapshotOf(harness, secondRequest.requestId)
        expect(
          Date.parse(secondRequest.autoAnswer!.at) - Date.parse(secondSnapshot!.at)
        ).toBe(newMinutes * 60_000)
        clock.advance(newMinutes * 60_000)
        const settledSecond = await bounded(second.promise)
        expect(settledSecond).toMatchObject({ behavior: 'allow' })
      }
      expect(harness.events.filter((event) => event.type === 'request_resolved')).toHaveLength(
        (initialMinutes === 0 ? 0 : 1) + (newMinutes === 0 ? 0 : 1)
      )
    } finally {
      harness.driver.kill()
      await bounded(first.promise)
      if (second) await bounded(second.promise)
    }
  }
}, 120_000)

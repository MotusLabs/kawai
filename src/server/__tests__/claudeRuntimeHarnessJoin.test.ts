// The Claude harness's suite-level join (fixtures/claudeRuntimeHarness.ts
// cleanupHarnesses; task-602c71e9 R6, parent review findings-74686a77 F2):
// one in-flight join, reserved before any harness cleanup runs or any entry
// is removed, so an overlapping call gets the same promise and never settles
// while a harness callback it owns is still held. A harness created during
// the join is joined by it; an unasserted raw failure reaches every caller as
// the same original object. Each case holds the actual adapter's returned
// turn_started callback promise and releases it in finally; nothing sleeps
// longer than 10 ms.
import { afterEach, expect, test } from 'bun:test'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatEvent } from '../../shared/chat'
import { cleanupHarnesses, createRuntimeHarness, type RuntimeHarness } from './fixtures/claudeRuntimeHarness'

afterEach(() => cleanupHarnesses())

const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A harness whose turn_started callback returns `held` until released. */
function heldHarness(held: Promise<void>): { h: RuntimeHarness; entered: () => boolean } {
  let entered = false
  const h = createRuntimeHarness({
    onEvent: (event: ChatEvent) => {
      if (event.type === 'turn_started') {
        entered = true
        return held
      }
    },
  })
  return { h, entered: () => entered }
}

function gate(): { held: Promise<void>; release(): void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

async function enter(h: RuntimeHarness, entered: () => boolean): Promise<void> {
  h.driver.send('hello')
  await h.admitted(1)
  for (let i = 0; i < 50 && !entered(); i++) await tick(1)
  expect(entered()).toBe(true)
}

const rawCauses = (error: unknown): unknown[] => (error instanceof AgentRuntimeError ? [...error.causes] : [error])

// Reviewer reproduction /tmp/k602-review-cleanup-overlap.test.ts (SHA 8779de0b), committed.
test('overlapping suite cleanup joins a harness whose stop still owns a held callback', async () => {
  const g = gate()
  const { h, entered } = heldHarness(g.held)
  let first: Promise<void> | undefined
  let second: Promise<void> | undefined
  try {
    await enter(h, entered)
    first = cleanupHarnesses()
    let firstJoined = false
    void first.then(() => { firstJoined = true })
    let joined = false
    second = cleanupHarnesses().then(() => { joined = true })
    await tick()
    expect(firstJoined).toBe(false)
    expect(joined).toBe(false)
  } finally {
    g.release()
    await Promise.allSettled([first, second, h.cleanup()])
    await cleanupHarnesses()
  }
})

test('overlapping callers share one join promise, which settles only after the held callback is released', async () => {
  const g = gate()
  const { h, entered } = heldHarness(g.held)
  let first: Promise<void> | undefined
  try {
    await enter(h, entered)
    first = cleanupHarnesses()
    const second = cleanupHarnesses()
    expect(second).toBe(first)
    let settled = false
    void first.then(() => void (settled = true), () => void (settled = true))
    await tick()
    expect(settled).toBe(false)
    g.release()
    await first
    expect(settled).toBe(true)
    // The join finished: the next call starts a new, empty one.
    const next = cleanupHarnesses()
    expect(next).not.toBe(first)
    await next
  } finally {
    g.release()
    await Promise.allSettled([first, h.cleanup()])
  }
})

test('a harness created while the join is held is joined by it before it settles', async () => {
  const g1 = gate()
  const g2 = gate()
  const a = heldHarness(g1.held)
  let first: Promise<void> | undefined
  let late: RuntimeHarness | undefined
  try {
    await enter(a.h, a.entered)
    first = cleanupHarnesses()
    let settled = false
    void first.then(() => void (settled = true), () => void (settled = true))
    const b = heldHarness(g2.held)
    late = b.h
    await enter(b.h, b.entered)
    g1.release()
    await tick()
    // The first harness is joined; the late one still holds its callback.
    expect(settled).toBe(false)
    g2.release()
    await first
    expect(settled).toBe(true)
  } finally {
    g1.release()
    g2.release()
    await Promise.allSettled([first, a.h.cleanup(), late?.cleanup()])
  }
})

test('an unasserted raw failure reaches both overlapping callers as the same original object, once', async () => {
  const boom = new Error('held turn_started callback rejected')
  const g = gate()
  const rejecting = g.held.then(() => {
    throw boom
  })
  void rejecting.catch(() => {})
  const { h, entered } = heldHarness(rejecting)
  let first: Promise<void> | undefined
  let second: Promise<void> | undefined
  try {
    await enter(h, entered)
    first = cleanupHarnesses()
    second = cleanupHarnesses()
    g.release()
    const [a, b] = await Promise.allSettled([first, second])
    expect([a.status, b.status]).toEqual(['rejected', 'rejected'])
    const left = (a as PromiseRejectedResult).reason
    const right = (b as PromiseRejectedResult).reason
    expect(left).toBe(right)
    expect(rawCauses(left).length).toBe(1)
    expect(rawCauses(left)[0]).toBe(boom)
    // Reported once: the entry left with the join, so the next one has nothing to report.
    await cleanupHarnesses()
  } finally {
    g.release()
    await Promise.allSettled([first, second, h.cleanup()])
  }
})

test('a failure asserted exactly before the suite join is not reported again by it', async () => {
  const boom = new Error('asserted held rejection')
  const g = gate()
  const rejecting = g.held.then(() => {
    throw boom
  })
  void rejecting.catch(() => {})
  const { h, entered } = heldHarness(rejecting)
  try {
    await enter(h, entered)
    const asserted = h.expectFailures(boom)
    g.release()
    await asserted
    await cleanupHarnesses()
  } finally {
    g.release()
    await h.cleanup().catch(() => {})
  }
})

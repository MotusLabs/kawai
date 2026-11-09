// Shared steps for the Claude checkpoint and interrupt-waiter tests (task 4.4,
// Claude unit): onCheckpoint as a test-held promise, an idle or starting
// driver, a settled-or-pending probe, and readers of what reached the CLI.
import { expect } from 'bun:test'
import type { InterruptReceipt, ResumeCheckpoint } from '../../src/contract.js'
import { AgentRuntimeError, type AgentErrorCategory } from '../../src/errors.js'
import type { AgentEvent } from '../../src/events.js'
import { driver, type Driver, type DriverHooks } from './claudeDriverHarness.js'
import { frames } from './controlledQuery.js'

export const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const REQUESTED: InterruptReceipt = { outcome: 'requested', processExit: false }
export const NO_ACTIVE_TURN: InterruptReceipt = { outcome: 'no-active-turn', processExit: false }

/** onCheckpoint as a test-held promise per call. */
export function persistence() {
  const calls: { checkpoint: ResumeCheckpoint; resolve(): void; reject(error: unknown): void }[] = []
  const onCheckpoint = (checkpoint: ResumeCheckpoint) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ checkpoint, resolve, reject })
    })
  return { calls, onCheckpoint }
}

/** A driver whose start is in progress: its query exists and has not answered initialize. */
export async function starting(hooks: DriverHooks): Promise<Driver & { start: Promise<void> }> {
  const f = driver(hooks)
  const start = f.d.start()
  start.catch(() => {})
  while (f.queries.length === 0) await tick()
  return { ...f, start }
}

export async function idle(hooks: DriverHooks): Promise<Driver> {
  const f = await starting(hooks)
  f.q().ready()
  await f.start
  return f
}

/** A promise a callback assigned (TypeScript narrows a closure-assigned `let` to its initial null). */
export function assigned<T>(promise: Promise<T> | null): Promise<T> {
  if (promise === null) throw new Error('the callback never ran')
  return promise
}

/** Settles to the value, the rejection, or 'pending' after the event loop drains. */
export async function outcome<T>(promise: Promise<T>): Promise<T | AgentRuntimeError | 'pending'> {
  let state: T | AgentRuntimeError | 'pending' = 'pending'
  promise.then(
    (value) => (state = value),
    (error: AgentRuntimeError) => (state = error),
  )
  await tick()
  await tick()
  return state
}

/** The rejection of `promise`, or a failure naming its value. */
export async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    const value = await promise
    throw new Error(`expected a rejection, got ${JSON.stringify(value)}`)
  } catch (error) {
    return error as AgentRuntimeError
  }
}

export function expectRefused(value: unknown, category: AgentErrorCategory, code?: string): void {
  expect(value).toBeInstanceOf(AgentRuntimeError)
  expect((value as AgentRuntimeError).category).toBe(category)
  if (code !== undefined) expect((value as AgentRuntimeError).code).toBe(code)
}

/** C: refused not-ready/interrupted. */
export function expectInterrupted(value: unknown): void {
  expectRefused(value, 'not-ready', 'interrupted')
}

export const prompts = (f: Driver) => f.q().prompts.map((p): string | undefined => p.uuid)
export const allPrompts = (f: Driver) => f.queries.flatMap((q) => q.prompts.map((p): string | undefined => p.uuid))
export const userMessages = (f: Driver) => f.events.filter((e) => e.type === 'user_message').map((e) => (e as Extract<AgentEvent, { type: 'user_message' }>).messageUuid)
export const startedTurns = (f: Driver) => f.events.filter((e) => e.type === 'turn_started').map((e) => (e as Extract<AgentEvent, { type: 'turn_started' }>).turnId)
export const interruptedTurns = (f: Driver) => f.events.filter((e) => e.type === 'turn_interrupted').map((e) => (e as Extract<AgentEvent, { type: 'turn_interrupted' }>).turnId)
export const errorCategories = (f: Driver) => f.events.filter((e) => e.type === 'error').map((e) => (e as Extract<AgentEvent, { type: 'error' }>).error.category)

/**
 * A fresh driver (no resume target) whose first turn T0 revealed `sessionId`;
 * that persistence is held and T0 is still active.
 */
export async function persisting(sessionId = 'sess-new', hooks: DriverHooks = {}) {
  const p = persistence()
  const f = await idle({ resume: null, ...hooks, onCheckpoint: p.onCheckpoint })
  const t0 = await f.d.send('first')
  f.q().push(frames.init(sessionId))
  await f.q().drain()
  return { f, p, t0 }
}

/** As persisting(), with T0 finished: the driver is idle and the persistence is still held. */
export async function idleWhilePersisting(sessionId = 'sess-new', hooks: DriverHooks = {}) {
  const held = await persisting(sessionId, hooks)
  held.f.q().push(frames.result([held.t0.messageUuid], 'zero'))
  await held.t0.result
  expect(held.f.d.state).toBe('idle')
  return held
}

/** The current process exits unexpectedly; resolves once the driver is exited. */
export async function exitProcess(f: Driver): Promise<void> {
  f.q().exit()
  while (f.d.state !== 'exited') await tick()
}

/** The stop's own error, or null when it succeeded. */
export async function stopError(stop: Promise<unknown>): Promise<AgentRuntimeError | null> {
  try {
    await stop
    return null
  } catch (error) {
    return error as AgentRuntimeError
  }
}

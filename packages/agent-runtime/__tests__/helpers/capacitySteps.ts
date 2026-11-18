// Shared steps of the codex-capacity-retry session tests over scriptedCodex.ts:
// open a turn on attempt `a1`, push a quota snapshot, fail or complete an
// attempt, let a retry fire and answer its continuation, and read the
// observable recovery state.
import type { TurnHandle } from '../../src/contract.js'
import { CODEX_CAPACITY_CONTINUATION } from '../../src/codex/continuation.js'
import { frames, scriptedCodex, type Scripted } from './scriptedCodex.js'

export const EXHAUSTED_SNAPSHOT = {
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_795_100_000 },
  secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_795_600_000 },
}
export const OPEN_SNAPSHOT = {
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_795_100_000 },
  secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_795_600_000 },
}
export const LIVE: Scripted[] = []

export async function stopScripted(): Promise<void> {
  await Promise.allSettled(LIVE.splice(0).map((s) => s.driver.kill()))
}

export function scripted(capacityRecovery?: unknown): Scripted {
  const s = scriptedCodex(capacityRecovery === undefined ? {} : { capacityRecovery })
  LIVE.push(s)
  return s
}

/** Start the driver and open one turn whose first attempt is bound to `attempt`. */
export async function opened(s: Scripted, text = 'hello', attempt = 'a1'): Promise<TurnHandle> {
  await s.driver.start()
  const handle = await s.driver.send(text)
  await s.flush()
  const start = s.turnStarts().at(-1)!
  s.reply(start.id, { turn: { id: attempt } })
  s.notify(...frames.started(attempt))
  await s.flush()
  return handle
}

export async function snapshot(s: Scripted, rateLimits: unknown): Promise<void> {
  s.notify('account/rateLimits/updated', { rateLimits })
  await s.flush()
}

export async function failAttempt(s: Scripted, attempt: string, info: unknown = 'serverOverloaded'): Promise<void> {
  s.notify(...frames.failed(attempt, info))
  await s.flush()
}

/** Advance to the armed wakeup and flush; returns the continuation turn/start if one was sent. */
export async function wake(s: Scripted, ms?: number) {
  const before = s.turnStarts().length
  const next = Math.min(...[...s.clock.timers.values()].map((t) => t.at))
  s.clock.advance(ms ?? (Number.isFinite(next) ? next - s.clock.now : 0))
  await s.flush()
  return s.turnStarts().length > before ? s.turnStarts().at(-1)! : null
}

/** Answer a continuation with its attempt id and turn/started. */
export async function bindAttempt(s: Scripted, request: { id: number }, attempt: string): Promise<void> {
  s.reply(request.id, { turn: { id: attempt } })
  s.notify(...frames.started(attempt))
  await s.flush()
}

export async function completeAttempt(s: Scripted, attempt: string, text = 'done'): Promise<void> {
  s.notify(...frames.completed(attempt, [{ type: 'agentMessage', id: `m-${attempt}`, text }]))
  await s.flush()
}

/** The observable recovery state: timers armed, capacity_retry events, continuation requests, terminal events. */
export function recovery(s: Scripted) {
  const continuations = s.turnStarts().filter((r) => r.params.input?.[0]?.text === CODEX_CAPACITY_CONTINUATION)
  return {
    timers: s.clock.pending,
    retries: s.events.filter((e) => e.type === 'capacity_retry').length,
    continuations: continuations.length,
    terminals: s.events.filter((e) => e.type === 'turn_completed' || e.type === 'turn_interrupted').length,
    state: s.driver.state,
  }
}

export const limitFailures = (s: Scripted) => s.limits.filter((e) => e.type === 'failure')

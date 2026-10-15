// Human plan commands and their replay rule (durable-plans design D7).
// Every command — approve, withdraw, close, reopen — carries a command id
// unique within its plan and a compared payload: the command name plus that
// command's own fields. The recorded event is looked up first, inside the
// command's transaction: the same payload returns the prior outcome without
// writing, a different one is refused naming the first differing field. The
// `UNIQUE(plan_id, command_id)` constraint is the arbiter, so a same-id
// command that commits first rolls this one back and it resolves the same
// way. A refusal thrown from a command body rolls back everything it wrote.
import type { PlanEvent, PlanSummary } from '../../shared/plans'
import type { PreconditionFailure } from './planPreconditions'
import { PlanCommandRaceError, type PlanStore } from './planStore'

export type PlanRefusalReason = 'forbidden' | 'not-found' | 'invalid' | 'payload' | 'precondition' | 'state'

export type PlanCommandOutcome =
  | { ok: true; replayed: boolean; plan: PlanSummary; event: PlanEvent }
  | { ok: false; reason: PlanRefusalReason; message: string; failures?: PreconditionFailure[] }

/** Thrown inside a command transaction to refuse it and roll back. */
export class PlanRefusal extends Error {
  constructor(readonly reason: PlanRefusalReason, message: string, readonly failures?: PreconditionFailure[]) {
    super(message)
  }

  outcome(): PlanCommandOutcome {
    return { ok: false, reason: this.reason, message: this.message, ...(this.failures ? { failures: this.failures } : {}) }
  }
}

/** The compared payload: the command name first, then its own fields (D7). */
export type CommandPayload = { command: 'approve' | 'withdraw' | 'close' | 'reopen' } & Record<string, unknown>

/** The first field whose value differs between a recorded payload and a resend; null when they match. */
export function payloadDifference(recorded: Record<string, unknown>, payload: CommandPayload): string | null {
  const keys = [...new Set([...Object.keys(payload), ...Object.keys(recorded)])]
  for (const key of keys) {
    if (JSON.stringify(recorded[key] ?? null) !== JSON.stringify(payload[key] ?? null)) return key
  }
  return null
}

function replayOrRefuse(store: PlanStore, planId: string, commandId: string, payload: CommandPayload): PlanCommandOutcome | null {
  const recorded = store.eventByCommand(planId, commandId)
  if (!recorded) return null
  const field = payloadDifference(recorded.payload, payload)
  if (field) {
    return {
      ok: false, reason: 'payload',
      message: `command_id ${commandId} was already used with a different ${field}; the recorded ${recorded.event.kind} event stands and nothing was written.`,
    }
  }
  return { ok: true, replayed: true, plan: store.summary(store.get(planId)!), event: recorded.event }
}

/**
 * Run a human command: replay first, else the body in one transaction. The
 * body returns the event it recorded, or throws a PlanRefusal. Subscribers
 * hear about the commit once, after it; never about a replay or refusal.
 */
export function runPlanCommand(store: PlanStore, planId: string, commandId: string, payload: CommandPayload, body: () => PlanEvent): PlanCommandOutcome {
  let outcome: PlanCommandOutcome
  try {
    outcome = store.atomically((): PlanCommandOutcome => {
      const prior = replayOrRefuse(store, planId, commandId, payload)
      if (prior) return prior
      const event = body()
      return { ok: true, replayed: false, plan: store.summary(store.get(planId)!), event }
    })
  } catch (error) {
    if (error instanceof PlanRefusal) return error.outcome()
    if (error instanceof PlanCommandRaceError) {
      const resolved = replayOrRefuse(store, planId, commandId, payload)
      if (resolved) return resolved
    }
    throw error
  }
  if (outcome.ok && !outcome.replayed) store.announce(planId)
  return outcome
}

/** A trimmed non-empty command id, or a refusal. */
export function requireCommandId(commandId: unknown): string | PlanCommandOutcome {
  const id = typeof commandId === 'string' ? commandId.trim() : ''
  return id || { ok: false, reason: 'invalid', message: 'This action needs a stable command id so a resend replays instead of repeating.' }
}

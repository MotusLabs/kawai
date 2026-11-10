// The Claude driver's open turns (tasks 4.1, 4.4): the accepted turns in FIFO
// order (L21), the active turn first, then queued ones that have not opened.
// Settling a turn is idempotent: its handle resolves once, an opened turn
// emits turn_completed or turn_interrupted once, a turn that never opened
// emits no turn event (L10/L11), and onTurnResult runs once through the
// driver's guarded notify. turn_completed carries the same facts as the
// result. After each handle resolves, `settled` lets the session end the
// turn's limit wait.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TurnOutcome, TurnResult } from '../contract.js'
import type { AgentErrorInfo } from '../errors.js'
import type { EventBody } from '../eventStream.js'
import type { LimitWaitEnd } from '../usage/types.js'
import { claudeResultUsage } from '../usage/tokens.js'
import { turnResult, type Turn } from './turns.js'

type WaitEndCause = LimitWaitEnd['cause']

export interface OpenTurnsHost {
  emit(body: EventBody): void
  notify(name: string, callback: () => void): void
  onTurnResult: ((result: TurnResult) => void) | undefined
  /** A turn's result was published (its wait ends with this cause). */
  settled(turn: Turn, cause: WaitEndCause): void
}

export class OpenTurns {
  private turns: Turn[] = []

  constructor(private readonly host: OpenTurnsHost) {}

  /** The opened turn content binds to, if any. */
  active(): Turn | null {
    const first = this.turns[0]
    return first?.opened ? first : null
  }

  next(): Turn | null {
    return this.turns[0] ?? null
  }

  push(turn: Turn): void {
    this.turns.push(turn)
  }

  /** Queued turns, not yet opened, whose prompt is one of `uuids`. */
  queuedWith(uuids: readonly string[], except: Turn): Turn[] {
    return this.turns.filter((t) => t !== except && !t.opened && t.messageUuid !== null && uuids.includes(t.messageUuid))
  }

  remove(gone: readonly Turn[]): void {
    this.turns = this.turns.filter((t) => !gone.includes(t))
  }

  take(): Turn[] {
    const turns = this.turns
    this.turns = []
    return turns
  }

  settle(turn: Turn, outcome: TurnOutcome, error: AgentErrorInfo | null, subtype: string, message?: SDKResultMessage): TurnResult {
    // The bound result's own tokens (none for an interrupt): never another turn's.
    if (message && !turn.settled) turn.usage = claudeResultUsage(message.usage)
    const result = turnResult(turn, outcome, error)
    if (turn.settled) return result
    turn.settled = true
    if (outcome === 'interrupted') this.host.emit({ type: 'turn_interrupted', turnId: turn.turnId })
    else {
      this.host.emit({
        type: 'turn_completed', turnId: turn.turnId, subtype, isError: outcome !== 'success', usage: result.usage,
        finalText: result.finalText, totalCostUsd: message?.total_cost_usd ?? null, providerCostUsd: turn.providerCost,
        numTurns: message?.num_turns ?? null, terminalReason: message?.terminal_reason ?? null,
      })
    }
    // A successful result is observed progress after any retry; any other end is not.
    this.resolve(turn, result, outcome === 'success' ? 'resumed' : 'cancelled')
    return result
  }

  /** Settle a turn that never opened: its handle resolves, no turn event (L10/L11). */
  settleQueued(turn: Turn, error: AgentErrorInfo): void {
    if (turn.settled) return
    turn.settled = true
    this.resolve(turn, turnResult(turn, 'interrupted', error))
  }

  /**
   * Decide every taken turn's terminal result now, with no callback, and
   * return the step that publishes them. Each turn is marked settled before
   * anything is published, so a stop or interrupt reentered from a later
   * callback cannot settle it again. Publishing emits turn_completed only
   * for turns that opened, then resolves every handle once.
   */
  decide(turns: readonly Turn[], outcome: Exclude<TurnOutcome, 'success' | 'interrupted'>, error: AgentErrorInfo, subtype: string): () => void {
    const decided = turns.filter((turn) => !turn.settled).map((turn) => {
      turn.settled = true
      return { turn, result: turnResult(turn, outcome, error) }
    })
    return () => {
      for (const { turn, result } of decided) {
        if (turn.opened) {
          this.host.emit({
            type: 'turn_completed', turnId: turn.turnId, subtype, isError: true, usage: result.usage, finalText: result.finalText,
            totalCostUsd: null, providerCostUsd: turn.providerCost, numTurns: null, terminalReason: null,
          })
        }
        this.resolve(turn, result, outcome === 'process-ended' ? 'process-ended' : 'cancelled')
      }
    }
  }

  /** Settle every taken turn as interrupted: opened ones with an event, queued ones without. */
  settleAll(turns: readonly Turn[], error: AgentErrorInfo): void {
    for (const turn of turns) {
      if (turn.opened) this.settle(turn, 'interrupted', error, 'interrupted')
      else this.settleQueued(turn, error)
    }
  }

  private resolve(turn: Turn, result: TurnResult, cause: WaitEndCause = 'cancelled'): void {
    turn.resolve(result)
    const onTurnResult = this.host.onTurnResult
    if (onTurnResult) this.host.notify('onTurnResult', () => onTurnResult(result))
    this.host.settled(turn, cause)
  }
}

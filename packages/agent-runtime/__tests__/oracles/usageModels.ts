// Reference models for I7 (task 5.2/5.3): what each turn's result, the
// limit/wait signals and the quota reports must be, stated from the input
// records a seeded stream generates, never from the driver's output. Each
// model is told what the generator sent (the true requests, the tool and
// boundary ids, the retries, the pushes) and keeps the facts the design
// assigns to their own turn:
// - Usage: Claude, the turn's result usage or null; Codex, the sum of the
//   requests the turn actually made (a repeated or foreign update adds
//   nothing), null when the turn reported none.
// - Counts: distinct tool-call ids and distinct boundary ids of the turn
//   (main thread only for Claude tools); an id reused by another turn counts
//   again there. Claude cost: the sum of the turn's message_delta costs,
//   subagents' included, or null. Claude model: the turn's last main
//   assistant model, or null.
// - Waits: the first limit retry of a turn opens its wait; it ends resumed
//   at that turn's next progress (or its success), cancelled when the turn
//   ends otherwise. A quota push, a reset in the past or a non-limit retry
//   never ends or opens one.
// - Limits carry the latest announced reset (Claude: a rejected
//   rate_limit_event still ahead; Codex: the latest exhausted window of the
//   latest snapshot).
import type { TokenUsage } from '../../src/usage/types.js'

export interface ExpectedTurn {
  key: string
  outcome: 'success' | 'failed'
  usage: TokenUsage | null
  toolCallCount: number
  compactionCount: number
  model?: string | null
  providerCostUsd?: number | null
}

interface OpenTurn {
  key: string
  tools: Set<string>
  boundaries: Set<string>
  cost: number | null
  model: string | null
  waiting: boolean
  /** A quota push arrived while the wait was open (a reset-time resumption would end it there). */
  pushedInWait: boolean
  requests: TokenUsage[]
}

const fresh = (key: string): OpenTurn => ({ key, tools: new Set(), boundaries: new Set(), cost: null, model: null, waiting: false, pushedInWait: false, requests: [] })

/** The limit/wait signal sequence as compact strings: failure:<final>:<reset>:<window>, start:<turn>:<reset>:<window>, end:<cause>. */
abstract class LimitModel {
  readonly limits: string[] = []
  readonly quotas: string[] = []
  readonly results: ExpectedTurn[] = []
  /** Situations the stream reached that only a correct wait model passes (for the coverage check). */
  readonly marks = new Set<string>()
  protected turn: OpenTurn | null = null
  protected abstract reset(): string | null
  protected abstract windowName(): string | null

  open(key: string): void {
    this.turn = fresh(key)
  }

  protected retried(final = false): void {
    const reset = this.reset()
    const window = this.windowName()
    this.limits.push(`failure:${final}:${reset}:${window}`)
    if (this.turn?.waiting && this.turn.pushedInWait) this.marks.add('push-in-wait-unresumed')
    if (final || !this.turn || this.turn.waiting) return
    this.turn.waiting = true
    this.limits.push(`start:${this.turn.key}:${reset}:${window}`)
  }

  /** A quota push: never progress. */
  protected pushed(): void {
    if (this.turn?.waiting) this.turn.pushedInWait = true
  }

  protected progressed(): void {
    if (!this.turn?.waiting) return
    this.turn.waiting = false
    this.turn.pushedInWait = false
    this.limits.push('end:resumed')
  }

  protected settle(outcome: 'success' | 'failed', usage: TokenUsage | null, extra: Partial<ExpectedTurn> = {}): void {
    const turn = this.turn!
    this.results.push({ key: turn.key, outcome, usage, toolCallCount: turn.tools.size, compactionCount: turn.boundaries.size, ...extra })
    if (turn.waiting && turn.pushedInWait && outcome !== 'success') this.marks.add('push-in-wait-unresumed')
    if (turn.waiting) this.limits.push(outcome === 'success' ? 'end:resumed' : 'end:cancelled')
    this.turn = null
  }
}

export class ClaudeUsageModel extends LimitModel {
  private rejected: { resetsAt: string; window: string } | null = null

  protected reset(): string | null {
    return this.rejected?.resetsAt ?? null
  }

  protected windowName(): string | null {
    return this.rejected?.window ?? null
  }

  push(status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt: string, window: string): void {
    if (status === 'rejected') this.rejected = { resetsAt, window }
    this.pushed()
    this.quotas.push(`push:session:${status === 'rejected' ? 'limited' : status === 'allowed_warning' ? 'warning' : 'allowed'}`)
  }

  messageStart(subagent: boolean): void {
    if (!subagent) this.progressed()
  }

  delta(cost: number | null): void {
    if (this.turn && cost !== null) this.turn.cost = (this.turn.cost ?? 0) + cost
  }

  assistant(subagent: boolean, model: string, tools: string[]): void {
    if (!this.turn || subagent) return
    for (const id of tools) this.turn.tools.add(id)
    this.turn.model = model
    this.progressed()
  }

  boundary(id: string): void {
    this.turn?.boundaries.add(id)
  }

  retry(limit: boolean): void {
    if (limit) this.retried()
  }

  result(failed: boolean, usage: TokenUsage | null): void {
    const turn = this.turn!
    this.settle(failed ? 'failed' : 'success', usage, { model: turn.model, providerCostUsd: turn.cost })
  }
}

export interface CodexSnapshot {
  primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null
  secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null
  rateLimitReachedType: string | null
}

const LOGIN_LIMITS = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'serverOverloaded', 'sessionBudgetExceeded'])

export class CodexUsageModel extends LimitModel {
  private snapshot: CodexSnapshot | null = null

  protected reset(): string | null {
    let latest: number | null = null
    for (const window of [this.snapshot?.primary, this.snapshot?.secondary]) {
      if (window && window.usedPercent === 100 && (latest === null || window.resetsAt > latest)) latest = window.resetsAt
    }
    return latest === null ? null : new Date(latest * 1000).toISOString()
  }

  protected windowName(): string | null {
    return null
  }

  private status(snapshot: CodexSnapshot): string {
    return snapshot.rateLimitReachedType !== null ? 'limited' : 'allowed'
  }

  /** The one read's reply (before any push). Windows: those with a percent in 0..100. */
  read(snapshot: CodexSnapshot): void {
    if (!snapshot.primary && !snapshot.secondary) return
    this.snapshot ??= snapshot
    this.quotas.push(`report:session:${this.status(snapshot)}`)
  }

  push(snapshot: CodexSnapshot): void {
    this.snapshot = snapshot
    this.pushed()
    this.quotas.push(`push:session:${this.status(snapshot)}`)
  }

  /** A request the turn made (its own token update): counted, and progress. */
  request(usage: TokenUsage): void {
    this.turn?.requests.push(usage)
    this.progressed()
  }

  /** A repeated token update of the turn: progress, no tokens. */
  repeated(): void {
    this.progressed()
  }

  tool(id: string): void {
    this.turn?.tools.add(id)
    this.progressed()
  }

  delta(): void {
    this.progressed()
  }

  /** A compaction item of the turn (item/completed: progress too). */
  boundary(id: string): void {
    this.turn?.boundaries.add(id)
    this.progressed()
  }

  retry(info: string): void {
    if (LOGIN_LIMITS.has(info)) this.retried()
  }

  completed(): void {
    // The completion's agent message items come first: progress.
    this.progressed()
    this.settle('success', this.usage())
  }

  failed(info: string): void {
    const usage = this.usage()
    const waiting = this.turn!.waiting
    if (waiting && this.turn!.pushedInWait) this.marks.add('push-in-wait-unresumed')
    // The outcome is decided before the final limit; the wait ends after the result is published.
    this.turn!.waiting = false
    this.results.push({ key: this.turn!.key, outcome: 'failed', usage, toolCallCount: this.turn!.tools.size, compactionCount: this.turn!.boundaries.size })
    if (LOGIN_LIMITS.has(info)) this.limits.push(`failure:true:${this.reset()}:null`)
    if (waiting) this.limits.push('end:cancelled')
    this.turn = null
  }

  private usage(): TokenUsage | null {
    const requests = this.turn!.requests
    if (requests.length === 0) return null
    const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens') => requests.reduce((total, r) => total + (r[key] ?? 0), 0)
    return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheCreationTokens: null }
  }
}

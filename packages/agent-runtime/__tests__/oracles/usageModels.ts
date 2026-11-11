// Reference models for I7 (task 5.2/5.3): what each turn's result, the
// limit/wait signals and the quota reports must be, stated from the input
// records a seeded stream generates, never from the driver's output. Each
// model is told what the generator sent (the true requests, the tool and
// boundary ids, the retries, the pushes) and keeps the facts the design
// assigns to their own turn:
// - Usage: Claude, the turn's result usage; when the result carries none,
//   the field-wise sum of the turn's own main-thread requests (each
//   message_start's input, its later main message_deltas' cumulative
//   output), never a subagent's or an earlier turn's; null when neither is
//   known (F3). A Claude request is named by its native message id: the
//   turn open at its first sighting owns it, counters or not, and every
//   later sighting (a replayed message_start or assistant snapshot, a delta
//   after it) belongs to that owner only, never to the turn open when it is
//   replayed. A field no frame of the request reported stays null. Codex, the sum of the
//   requests the turn actually made (a repeated or foreign update adds
//   nothing), null when the turn reported none.
// - Counts: distinct tool-call ids and distinct boundary ids of the turn
//   (main thread only for Claude tools); an id reused by another turn counts
//   again there. Claude cost: the sum of the turn's message_delta costs,
//   subagents' included, or null. Claude model: the turn's last main
//   assistant model, or null.
// - Waits: the first limit retry of a turn opens its wait; it ends resumed
//   at that turn's next progress (or its success), cancelled when the turn
//   ends otherwise. Claude progress is a new phase of a request the turn
//   owns: its first message_start or snapshot, or a snapshot with content
//   the request's earlier ones lacked; a repeated frame, another turn's
//   request or a delta is none (F5). A quota push, a reset in the past, a non-limit retry or a
//   repeated token total never ends or opens one; Codex progress is a new
//   item phase of the turn, a delta or a token update that grew a counter. A
//   replayed item (an id the turn already completed, at either phase) is no
//   progress and no count (F2).
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

/** Field-wise sums of requests; a field no request reported is null (none at all: null). */
function summed(requests: TokenUsage[]): TokenUsage | null {
  if (requests.length === 0) return null
  const field = (key: keyof TokenUsage) => requests.reduce<number | null>((total, r) => (r[key] === null ? total : (total ?? 0) + r[key]!), null)
  return { inputTokens: field('inputTokens'), outputTokens: field('outputTokens'), cacheReadTokens: field('cacheReadTokens'), cacheCreationTokens: field('cacheCreationTokens') }
}

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

  /**
   * Every main-thread request by its native id: the turn open at its first
   * sighting (whatever counters that frame carried), its measured tokens
   * (null until a frame reports a counter) and the content of its snapshots.
   */
  private readonly requests = new Map<string, { turn: OpenTurn | null; usage: TokenUsage | null; contents: Set<string> }>()
  /** The latest main-thread request's id, counters or not (a later message_delta continues it). */
  private latest: string | null = null
  /** Turns that made a request of their own, and those that then saw an earlier turn's request again. */
  private readonly ownRequest = new Set<OpenTurn>()
  private readonly replayedAfterOwn = new Set<OpenTurn>()

  /** A main message_start of request `id`: only its first sighting is a new phase (progress). */
  messageStart(subagent: boolean, id: string, inputTokens: number | null): void {
    if (subagent) return
    if (this.sighting(id, inputTokens === null ? {} : { inputTokens })) this.progressed()
    else if (this.turn?.waiting) this.marks.add('replay-in-wait-unresumed')
  }

  /**
   * A main assistant snapshot of request `id` with `content` (what the frame
   * carried): tools and model are the turn's; it is progress when it is the
   * request's first sighting or carries content its earlier snapshots did not,
   * and the request is the open turn's own.
   */
  snapshot(id: string, inputTokens: number | null, model: string, tools: string[], content: string): void {
    const first = this.sighting(id, inputTokens === null ? {} : { inputTokens })
    const request = this.requests.get(id)!
    const novel = first || !request.contents.has(content)
    // Content that differs from an earlier snapshot of the request only in its thinking strings.
    const withoutThinking = (text: string) => JSON.stringify((JSON.parse(text) as Array<Record<string, unknown>>).map((block) => (block.type === 'thinking' ? { ...block, thinking: '' } : block)))
    const thinkingOnly = novel && !first && content.includes('"type":"thinking"') && [...request.contents].some((earlier) => withoutThinking(earlier) === withoutThinking(content))
    request.contents.add(content)
    if (!this.turn) return
    for (const tool of tools) this.turn.tools.add(tool)
    this.turn.model = model
    if (novel && request.turn === this.turn) {
      // New thinking alone is progress too (review F5, findings-14bde0ed).
      if (this.turn.waiting && thinkingOnly) this.marks.add('thinking-only-content-resumes-wait')
      this.progressed()
    } else if (this.turn.waiting) this.marks.add('replay-in-wait-unresumed')
  }

  /** A subagent's assistant frame: none of the turn's facts and no progress. */
  subagentSnapshot(): void {}

  /** One sighting of request `id`: true for the first, which makes the open turn its owner; reported counters add to that owner only while it is open. */
  private sighting(id: string, counters: Partial<TokenUsage>): boolean {
    let request = this.requests.get(id)
    const first = !request
    if (!request) {
      request = { turn: this.turn, usage: null, contents: new Set() }
      this.requests.set(id, request)
      if (Object.keys(counters).length === 0) this.marks.add('request-without-counters')
      if (this.turn) this.ownRequest.add(this.turn)
    } else if (this.turn && request.turn !== this.turn) {
      this.marks.add('replay-of-earlier-turn-request')
      if (this.ownRequest.has(this.turn)) this.replayedAfterOwn.add(this.turn)
    }
    this.latest = id
    if (this.turn && request.turn === this.turn) this.measure(request, counters)
    return first
  }

  /** Field-wise cumulative maxima of what the request's frames reported; a field never reported stays null. */
  private measure(request: { turn: OpenTurn | null; usage: TokenUsage | null }, counters: Partial<TokenUsage>): void {
    const keys = Object.keys(counters) as Array<keyof TokenUsage>
    if (keys.length === 0) return
    if (!request.usage) {
      request.usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null }
      request.turn!.requests.push(request.usage)
    }
    for (const key of keys) request.usage[key] = Math.max(request.usage[key] ?? 0, counters[key]!)
  }

  /** A message_delta: its cost counts for the turn (subagents' too); a main one's output tokens continue the latest request, cumulatively, on its owner only; never progress. */
  delta(cost: number | null, subagent = true, outputTokens = 0): void {
    if (this.turn && cost !== null) this.turn.cost = (this.turn.cost ?? 0) + cost
    const request = this.latest === null ? undefined : this.requests.get(this.latest)
    if (!subagent && request && this.turn && request.turn !== this.turn) this.marks.add('delta-of-earlier-turn-request')
    if (subagent || !request || !this.turn || request.turn !== this.turn) return
    this.measure(request, { outputTokens })
  }

  boundary(id: string): void {
    this.turn?.boundaries.add(id)
  }

  retry(limit: boolean): void {
    if (limit) this.retried()
  }

  /** The bound result: its usage when it carries one, else the turn's own requests' observed tokens (F3). */
  result(failed: boolean, usage: TokenUsage | null): void {
    const turn = this.turn!
    if (usage === null && turn.requests.length > 0) this.marks.add('usage:partial')
    if (usage === null && this.replayedAfterOwn.has(turn)) this.marks.add('usage:partial-after-earlier-turn-replay')
    this.settle(failed ? 'failed' : 'success', usage ?? summed(turn.requests), { model: turn.model, providerCostUsd: turn.cost })
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

  /** A repeated (equal or stale lower) token update of the turn: no tokens, and not progress (FRESH-B). */
  repeated(): void {}

  /** A tool item of the turn (item/started then item/completed): counted and progress unless the id was already seen. */
  tool(id: string): void {
    if (this.replay(id)) return
    this.turn?.tools.add(id)
    this.progressed()
  }

  delta(): void {
    this.progressed()
  }

  /** A compaction item of the turn (item/completed: progress too), unless the id was already seen. */
  boundary(id: string): void {
    if (this.replay(id)) return
    this.turn?.boundaries.add(id)
    this.progressed()
  }

  /** An item/completed replaying an item the turn already completed: no count and no progress (F2). */
  replayed(id: string): void {
    this.replay(id)
  }

  /** The turn's own completed item ids, in order (the generator replays one). */
  completedItems(): string[] {
    return [...(this.turn?.tools ?? []), ...(this.turn?.boundaries ?? [])]
  }

  /** Whether `id` is an item the turn already completed; a replay inside an open wait leaves it open. */
  private replay(id: string): boolean {
    if (!this.turn || !(this.turn.tools.has(id) || this.turn.boundaries.has(id))) return false
    if (this.turn.waiting) this.marks.add('replay-in-wait-unresumed')
    return true
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

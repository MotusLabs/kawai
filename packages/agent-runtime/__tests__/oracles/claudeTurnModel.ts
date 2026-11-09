// An independent reference for Claude turn ownership (task 4.1, correction A1).
// It is written from the CLI contract (docs/claude-cli-contract.md) and the
// driver's admission rules, never from the driver's output. The I6 streams
// use it twice: it chooses which uuids a result names, and it states exactly
// which turn each input must complete, interrupt or end.
//
// - Ownership. Each prompt uuid is owned by the turn it was sent for. A
//   result completes the active turn only when it names one of that turn's
//   uuids, or when it names none and a turn is active (an agent-started
//   turn, or the out-of-contract prompted-result-without-uuid).
// - Repeats. A result frame binds once per session. A repeat of the same
//   frame (same frame uuid) changes nothing, even on a later generation.
// - Merges. A queued prompt named by the result that completes the active
//   turn is merged into it: its handle resolves with that same result.
// - Carry. A prompt no result named stays unread by the CLI. When its turn
//   ends, the next turn to open takes it over. A fresh queued prompt is
//   never carried: it stays its own turn's.
// - Interrupts. An interrupted turn that ran (its init came) or still holds
//   an unread prompt owes one result; the next result or init settles it
//   in order. A restart forgets everything the dead process held.
export type Outcome = 'success' | 'failed' | 'interrupted' | 'process-ended'

interface ModelTurn {
  key: string
  prompt: string | null
  opened: boolean
  agent: boolean
  initSeen: boolean
}

export class ClaudeTurnModel {
  /** Unsettled turns in order; the first, once opened, is the active turn. */
  private open: ModelTurn[] = []
  private readonly owner = new Map<string, string>()
  /** Sent uuids no result has named, in send order. */
  private outstanding: string[] = []
  private carried = new Set<string>()
  private owed: { key: string; initSeen: boolean }[] = []
  private readonly frames = new Set<string>()
  private natives = 0
  private readonly settled = new Set<string>()
  /** Every settlement reported through onTurnResult, in order. */
  readonly completions: [string, Outcome][] = []
  /** Turn keys in the order they opened (turn_started). */
  readonly opened: string[] = []
  /** Per prompted turn: the turn whose result its handle resolves with, and the outcome. */
  readonly handles = new Map<string, [string, Outcome]>()

  private stopped = false

  get state(): 'idle' | 'active' | 'stopped' {
    if (this.stopped) return 'stopped'
    return this.open.length > 0 ? 'active' : 'idle'
  }

  /** Uuids a CLI result could name now, in send order. */
  unread(): string[] {
    return [...this.outstanding]
  }

  /** Prompts of turns that already settled. */
  finished(): string[] {
    return [...this.owner].filter(([, key]) => this.settled.has(key)).map(([uuid]) => uuid)
  }

  /** The newest queued turn's prompt that has not opened, if any. */
  queuedPrompt(): string | null {
    return this.open.filter((t) => !t.opened).at(-1)?.prompt ?? null
  }

  send(key: string, uuid: string, queue: boolean): 'busy' | 'sent' {
    if (this.state === 'active' && !queue) return 'busy'
    const turn: ModelTurn = { key, prompt: uuid, opened: false, agent: false, initSeen: false }
    this.open.push(turn)
    if (this.open.length === 1) this.openTurn(turn)
    this.owner.set(uuid, key)
    this.outstanding.push(uuid)
    return 'sent'
  }

  result(frameUuid: string, uuids: readonly string[], failed: boolean): void {
    if (this.frames.has(frameUuid)) return
    this.frames.add(frameUuid)
    const known = uuids.filter((uuid) => this.owner.has(uuid))
    if (uuids.length > 0 && known.length === 0) return
    this.outstanding = this.outstanding.filter((uuid) => !known.includes(uuid))
    for (const uuid of known) this.carried.delete(uuid)
    const active = this.active()
    if (known.length > 0) {
      const owners = new Set(known.map((uuid) => this.owner.get(uuid)!))
      const owedAt = this.owed.findIndex((owed) => owners.has(owed.key))
      if (owedAt >= 0) return this.settleOwed(owedAt + 1)
      if (active && owners.has(active.key)) this.complete(active, uuids, failed)
      return
    }
    if (this.owed.length > 0) return this.settleOwed(1)
    if (active) this.complete(active, uuids, failed)
  }

  init(): void {
    const front = this.owed[0]
    if (front && !front.initSeen) {
      front.initSeen = true
      return
    }
    if (front) this.abandonOwed()
    const active = this.active()
    if (active) {
      active.initSeen = true
      return
    }
    const turn: ModelTurn = { key: `native#${++this.natives}`, prompt: null, opened: false, agent: true, initSeen: true }
    this.open.push(turn)
    this.openTurn(turn)
  }

  interrupt(): 'requested' | 'no-active-turn' {
    // Every interrupt withdraws what never ran: an owed turn with no init and no unread prompt owes nothing.
    this.owed = this.owed.filter((owed) => owed.initSeen || this.holds(owed.key))
    const active = this.active()
    if (!active) return 'no-active-turn'
    if (active.agent || active.initSeen || this.holds(active.key)) this.owed.push({ key: active.key, initSeen: active.initSeen })
    this.settleAll('interrupted')
    return 'requested'
  }

  /** The process ended unexpectedly and a new one started. */
  restart(): void {
    this.settleAll('process-ended')
    this.outstanding = []
    this.carried.clear()
    this.owed = []
  }

  stop(): void {
    this.settleAll('interrupted')
    this.stopped = true
  }

  private active(): ModelTurn | null {
    const first = this.open[0]
    return first?.opened ? first : null
  }

  private openTurn(turn: ModelTurn): void {
    turn.opened = true
    this.opened.push(turn.key)
    for (const uuid of this.carried) this.owner.set(uuid, turn.key)
    this.carried.clear()
  }

  private complete(active: ModelTurn, uuids: readonly string[], failed: boolean): void {
    if (this.owed.length > 0) this.abandonOwed()
    for (const uuid of this.outstanding) if (this.owner.get(uuid) === active.key) this.carried.add(uuid)
    const outcome: Outcome = failed ? 'failed' : 'success'
    const merged = this.open.filter((t) => t !== active && !t.opened && t.prompt !== null && uuids.includes(t.prompt))
    this.open = this.open.filter((t) => t !== active && !merged.includes(t))
    this.record(active, active.key, outcome, true)
    for (const turn of merged) this.record(turn, active.key, outcome, false)
    const next = this.open[0]
    if (next) this.openTurn(next)
  }

  private settleAll(outcome: Outcome): void {
    for (const turn of this.open) this.record(turn, turn.key, outcome, true)
    this.open = []
  }

  private record(turn: ModelTurn, resultOf: string, outcome: Outcome, reported: boolean): void {
    this.settled.add(turn.key)
    if (reported) this.completions.push([turn.key, outcome])
    if (!turn.agent) this.handles.set(turn.key, [resultOf, outcome])
  }

  private settleOwed(count: number): void {
    for (const owed of this.owed.splice(0, count)) {
      for (const uuid of this.outstanding) if (this.owner.get(uuid) === owed.key) this.carried.add(uuid)
    }
  }

  private abandonOwed(): void {
    const keys = new Set(this.owed.map((owed) => owed.key))
    this.owed = []
    this.outstanding = this.outstanding.filter((uuid) => !keys.has(this.owner.get(uuid)!))
  }

  private holds(key: string): boolean {
    return this.outstanding.some((uuid) => this.owner.get(uuid) === key)
  }
}

// Binds the chat driver's turns to the Claude Code CLI's turns by the client
// uuid each prompt carries (contract and floor: docs/claude-cli-contract.md).
// Pure and SDK-free: the driver reports what it sent, opened, interrupted,
// and received; the binder answers whether a result ends the active turn and
// whether content frames belong to it.
//
// Contract relied on: the CLI writes exactly one result per CLI turn before
// the next turn's init; every prompted result echoes the uuids it consumed
// (`user_message_uuids`, else `user_message_uuid`); agent-started turns'
// results carry none. command_lifecycle frames are never read.

/** A deviation from the pinned contract, logged as `chat_cli_contract_violation`. */
export type CliContractViolation =
  /** An init arrived while an interrupted turn's result was still owed. */
  | 'init-before-owed-result'
  /** A later turn's result arrived while an interrupted turn's was still owed. */
  | 'result-before-owed-result'
  /** A result without a uuid closed a turn the driver opened with a prompt. */
  | 'prompted-result-without-uuid'
  /** The CLI does not advertise interrupt_cancel_queued_v1. */
  | 'interrupt-cancel-queued-unsupported'

export interface CliTurnBinderLog {
  violation(reason: CliContractViolation): void
  /** A result named a uuid this driver never sent; it is ignored. */
  unknownUuid(uuid: string): void
}

/** Uuids remembered for late or duplicate results; outstanding ones are never evicted. */
const REMEMBERED_UUIDS = 512

interface ActiveTurn {
  turnId: string
  /** Opened by an init (the agent started it, or it runs a carried prompt). */
  agentOpened: boolean
  /** The CLI's init for this turn arrived. */
  initSeen: boolean
}

/** An interrupted turn whose one result the CLI still owes. */
interface OwedResult {
  turnId: string
  initSeen: boolean
}

export class CliTurnBinder {
  /** uuid → the driver turn that answers it. */
  private readonly owner = new Map<string, string>()
  /** Uuids the CLI holds that no result has named yet. */
  private readonly outstanding = new Set<string>()
  /**
   * Outstanding uuids whose turn already ended: the CLI runs them as a later
   * turn, so the next driver turn to open takes them over.
   */
  private readonly carried = new Set<string>()
  private active: ActiveTurn | null = null
  private owed: OwedResult[] = []

  constructor(private readonly log: CliTurnBinderLog) {}

  /** A driver turn opened; carried prompts become its own. */
  turnOpened(turnId: string, agentOpened: boolean): void {
    this.active = { turnId, agentOpened, initSeen: agentOpened }
    for (const uuid of this.carried) this.owner.set(uuid, turnId)
    this.carried.clear()
  }

  /** A prompt with this uuid was handed to the CLI for `turnId`. */
  promptSent(uuid: string, turnId: string): void {
    this.owner.delete(uuid)
    this.owner.set(uuid, turnId)
    this.outstanding.add(uuid)
    this.evict()
  }

  /** Prompts that will never run: dropped before the CLI read them, or cancelled. */
  promptsWithdrawn(uuids: Iterable<string>): void {
    for (const uuid of uuids) {
      this.outstanding.delete(uuid)
      this.carried.delete(uuid)
    }
    // An interrupted turn whose init never came and whose prompts were all
    // withdrawn never ran: it owes nothing.
    this.owed = this.owed.filter(owed => owed.initSeen || this.holds(owed.turnId))
  }

  /** The active turn was interrupted; it owes a result if the CLI has it. */
  turnInterrupted(turnId: string): void {
    const active = this.active
    if (!active || active.turnId !== turnId) return
    this.active = null
    if (active.agentOpened || active.initSeen || this.holds(turnId)) {
      this.owed.push({ turnId, initSeen: active.initSeen })
    }
  }

  /** Content frames belong to the active turn only while no result is owed. */
  framesBelongToActive(): boolean {
    return this.owed.length === 0
  }

  /**
   * An init arrived. `absorbed`: it opens the owed interrupted turn, which
   * the driver already ended. `open`: an agent-started turn begins.
   * `continue`: the active turn's own init.
   */
  init(): 'absorbed' | 'open' | 'continue' {
    const front = this.owed[0]
    if (front) {
      if (!front.initSeen) {
        front.initSeen = true
        return 'absorbed'
      }
      this.log.violation('init-before-owed-result')
      this.abandonOwed()
    }
    if (!this.active) return 'open'
    this.active.initSeen = true
    return 'continue'
  }

  /**
   * A result arrived naming `uuids` (empty for agent-started turns).
   * `complete`: it ends the active turn; `drop`: it belongs to no live turn.
   * `queuedTurnCount === 0` says the CLI holds nothing else, so carried
   * prompts no result named are forgotten.
   */
  result(uuids: readonly string[], queuedTurnCount?: number): 'complete' | 'drop' {
    const verdict = this.bind(uuids)
    if (queuedTurnCount === 0) this.promptsWithdrawn(Array.from(this.carried))
    return verdict
  }

  /** The process ended (kill, death): nothing it held will answer. */
  reset(): void {
    this.outstanding.clear()
    this.carried.clear()
    this.active = null
    this.owed = []
  }

  private bind(uuids: readonly string[]): 'complete' | 'drop' {
    const known = uuids.filter(uuid => {
      if (this.owner.has(uuid)) return true
      this.log.unknownUuid(uuid)
      return false
    })
    // Only never-sent uuids: not ours, whatever turn is active.
    if (uuids.length > 0 && known.length === 0) return 'drop'
    for (const uuid of known) {
      this.outstanding.delete(uuid)
      this.carried.delete(uuid)
    }
    if (known.length > 0) {
      const turns = new Set(known.map(uuid => this.owner.get(uuid)))
      const owedIndex = this.owed.findIndex(owed => turns.has(owed.turnId))
      if (owedIndex >= 0) {
        // In order, every earlier owed result came or never will.
        this.settleOwed(owedIndex + 1)
        return 'drop'
      }
      if (this.active && turns.has(this.active.turnId)) return this.completeActive()
      // A late or duplicate result for a turn already ended.
      return 'drop'
    }
    if (this.owed.length > 0) {
      this.settleOwed(1)
      return 'drop'
    }
    if (!this.active) return 'drop'
    if (!this.active.agentOpened) this.log.violation('prompted-result-without-uuid')
    return this.completeActive()
  }

  private completeActive(): 'complete' {
    if (this.owed.length > 0) {
      this.log.violation('result-before-owed-result')
      this.abandonOwed()
    }
    this.carry(this.active!.turnId)
    this.active = null
    return 'complete'
  }

  private settleOwed(count: number): void {
    for (const owed of this.owed.splice(0, count)) this.carry(owed.turnId)
  }

  /**
   * Out of contract, the owed results will come late if at all: their
   * prompts are forgotten as outstanding (a late tail naming them is dropped
   * as a finished turn's), never carried to the turn opened since.
   */
  private abandonOwed(): void {
    const turns = new Set(this.owed.map(owed => owed.turnId))
    this.owed = []
    for (const uuid of this.outstanding) {
      if (turns.has(this.owner.get(uuid)!)) this.outstanding.delete(uuid)
    }
  }

  /** A turn ended: prompts of it no result named run as a later CLI turn. */
  private carry(turnId: string): void {
    for (const uuid of this.outstanding) {
      if (this.owner.get(uuid) === turnId) this.carried.add(uuid)
    }
  }

  private holds(turnId: string): boolean {
    for (const uuid of this.outstanding) if (this.owner.get(uuid) === turnId) return true
    return false
  }

  private evict(): void {
    for (const uuid of this.owner.keys()) {
      if (this.owner.size <= REMEMBERED_UUIDS) return
      if (!this.outstanding.has(uuid)) this.owner.delete(uuid)
    }
  }
}

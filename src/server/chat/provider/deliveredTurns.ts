// The turn a mail delivery opens (ChatAgentDriver.deliver, task 6.1). Kawai's
// mailbox records the delivered work right after deliver() returns, and a
// turn start clears a session's delivered work (limitOutcomes.turnStarted),
// so a delivery opens its turn synchronously, as both pre-package drivers
// did: its start and peer message are shown under an adapter id at once.
// The package opens a turn only after its admission yield; the adapter binds
// the package's next turn without a trigger to the opened one (a delivery
// needs an idle driver, and sends commit in call order, so that turn is the
// delivery's) and shows the package's id as the opened one until that turn
// ends. A delivery whose send never opened a turn is abandoned once
// (refused, failed, or interrupted first; an interrupt shows its close). An
// alias lives until its package turn ends, even past a process exit, so a
// late end still shows under the opened id.
import type { ChatPeerMessage } from '../../../shared/chat'
import type { ChatEventDraft } from './runtimeEvents'

export class DeliveredTurns {
  private opening: string | null = null
  private readonly aliases = new Map<string, string>()

  constructor(private readonly emit: (draft: ChatEventDraft) => void) {}

  /** Open a delivery's turn now: its start and peer message, under a new id. */
  open(envelope: ChatPeerMessage): string {
    const turnId = crypto.randomUUID()
    this.opening = turnId
    this.emit({ type: 'turn_started', turnId })
    this.emit({ type: 'peer_message', turnId, ...envelope })
    return turnId
  }

  /** The package opened a turn: true when it is the pending delivery's, whose start was already shown. */
  started(turnId: string, agentStarted: boolean): boolean {
    if (agentStarted || !this.opening) return false
    this.aliases.set(turnId, this.opening)
    this.opening = null
    return true
  }

  /** A draft with a package turn id shown as the opened one. */
  shown(draft: ChatEventDraft): ChatEventDraft {
    const turnId = 'turnId' in draft && typeof draft.turnId === 'string' ? this.aliases.get(draft.turnId) : undefined
    return turnId ? ({ ...draft, turnId } as ChatEventDraft) : draft
  }

  /** The id shown for a package turn id. */
  shownId(turnId: string): string {
    return this.aliases.get(turnId) ?? turnId
  }

  /** A package turn ended: its alias is no longer needed after this event. */
  ended(turnId: string): void {
    this.aliases.delete(turnId)
  }

  /** The pending delivery never reached a turn: its opened id, once (an interrupt shows its close). */
  abandon(interrupted = false): string | null {
    const opened = this.opening
    this.opening = null
    if (opened && interrupted) this.emit({ type: 'turn_interrupted', turnId: opened })
    return opened
  }
}

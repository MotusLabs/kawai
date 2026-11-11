// Queued sends shown at admission (task 6.1 R10, the old driver's A4
// display). The old ChatSessionDriver showed a send made during an active
// turn at once, under that turn (ChatSessionDriver submit), then enqueued it.
// When the CLI ran it as a later turn (the binder's carried prompt), the next
// init opened a new Kawai turn as a resumed one, and the echo was not shown
// again. The package queues the same send as its own turn and shows its
// message only when that turn opens. This module keeps the display binding
// only. The package's handles, results, usage and terminal events pass
// through untouched.
// - begin: a queued send is in flight, to be shown under the turn displayed
//   when it was submitted.
// - shown: the package showed it itself (it opened as a new turn).
// - admitted: the send committed. If not shown yet, its row is drafted now
//   and its package turn id is bound.
// - started: that package turn opens as a resumed Kawai turn. Its message
//   is suppressed once.
// - forget: the handle settled (absorbed, completed, interrupted, stopped).
import type { WorkspaceMessageContext } from '../../../shared/planWorkspace'
import type { ChatEventDraft } from './runtimeEvents'

interface InFlight {
  display: string | null
  shown: boolean
}

export class QueuedEchoes {
  private readonly inFlight = new Map<string, InFlight>()
  /** Package turn id -> the uuid shown ahead of it. */
  private readonly echoed = new Map<string, string>()
  private readonly suppressed = new Set<string>()

  begin(messageUuid: string, display: string | null): void {
    this.inFlight.set(messageUuid, { display, shown: false })
  }

  /** The package's user_message: false when it was already shown at admission. */
  shown(messageUuid: string): boolean {
    const pending = this.inFlight.get(messageUuid)
    if (pending) pending.shown = true
    return !this.suppressed.delete(messageUuid)
  }

  /** The committed send: its row now, unless the package already showed it. */
  admitted(messageUuid: string, turnId: string, text: string, context?: WorkspaceMessageContext): ChatEventDraft | null {
    const pending = this.inFlight.get(messageUuid)
    this.inFlight.delete(messageUuid)
    if (!pending || pending.shown) return null
    this.echoed.set(turnId, messageUuid)
    this.suppressed.add(messageUuid)
    return { type: 'user_message', turnId: pending.display ?? turnId, text, messageUuid, ...(context ? { workspaceContext: context } : {}) }
  }

  /** A package turn opened: true when it runs a message shown at admission. */
  started(turnId: string): boolean {
    return this.echoed.delete(turnId)
  }

  /** A send that never committed, or a handle that settled. */
  forget(messageUuid: string, turnId?: string): void {
    this.inFlight.delete(messageUuid)
    this.suppressed.delete(messageUuid)
    if (turnId !== undefined) this.echoed.delete(turnId)
  }
}

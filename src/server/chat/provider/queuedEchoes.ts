// Sends queued behind the active turn, shown where the old driver showed them
// (task 6.1 R10, A4). The old ChatSessionDriver recorded a send made during
// an active turn under that turn, showed it there at once, then enqueued it.
// When the CLI ran it as a later turn (the binder's carried prompt), the next
// init opened a new Kawai turn as a resumed one, and the echo was not shown
// again. The package queues the same send as its own turn. It shows the send
// only when that turn opens, and returns the handle a few microtasks after
// the commit. This module orders Kawai's view only. The package's processing,
// handles, results, usage and terminal events are untouched.
// - submitted: a send is about to go to the package.
// - hold: the host's pre-submit check accepted it while a turn is active, so
//   the package commits it as queued in the same synchronous step. Kawai's
//   view is held from here, with a slot for its row.
// - settled: the send's admission is known. Admitted: the slot gets the row
//   under the turn displayed at the check. Refused: the slot stays empty.
//   With no hold left, the held view is published in order.
// - The package's own message for a held send is suppressed, and the package
//   turn running it opens as resumed (published with the trigger).
// - forget: the handle settled (absorbed into the active result, completed,
//   interrupted, stopped). Bindings are dropped after anything still held.
// A host consumer's throw is returned to the caller's owner, not raised.
import type { WorkspaceMessageContext } from '../../../shared/planWorkspace'
import type { ChatEventDraft } from './runtimeEvents'

interface Slot {
  display: string
  draft: ChatEventDraft | null
}
type Entry = { kind: 'event'; draft: ChatEventDraft; at?: string | null } | { kind: 'slot'; slot: Slot } | { kind: 'forget'; run: () => void }

export class QueuedEchoes {
  private readonly inFlight = new Map<string, Slot | null>()
  private readonly held: Entry[] = []
  private holds = 0
  private flushing = false
  /** Package turn ids that run a send shown at its admission. */
  private readonly resumed = new Set<string>()
  /** Held sends whose package message must not show again. */
  private readonly suppressed = new Set<string>()

  constructor(private readonly publish: (draft: ChatEventDraft, at?: string | null) => void, private readonly failed: (error: unknown) => void) {}

  get holding(): boolean {
    return this.holds > 0 || this.flushing
  }

  submitted(messageUuid: string): void {
    this.inFlight.set(messageUuid, null)
  }

  /** The pre-submit check accepted an in-flight send while `display` is the active turn. */
  hold(messageUuid: string, display: string): boolean {
    if (!this.inFlight.has(messageUuid) || this.inFlight.get(messageUuid)) return false
    const slot: Slot = { display, draft: null }
    this.inFlight.set(messageUuid, slot)
    this.held.push({ kind: 'slot', slot })
    this.suppressed.add(messageUuid)
    this.holds += 1
    return true
  }

  /** The package's user_message: false when the send's row is the held one. */
  shown(messageUuid: string): boolean {
    return !this.suppressed.has(messageUuid)
  }

  /** The send's admission is known: its package turn and text when committed, else null. */
  settled(messageUuid: string, admitted: { turnId: string; text: string; context?: WorkspaceMessageContext } | null): void {
    const slot = this.inFlight.get(messageUuid)
    this.inFlight.delete(messageUuid)
    if (!slot) return
    if (admitted) {
      const { turnId, text, context } = admitted
      slot.draft = { type: 'user_message', turnId: slot.display, text, messageUuid, ...(context ? { workspaceContext: context } : {}) }
      this.resumed.add(turnId)
    } else this.suppressed.delete(messageUuid)
    this.holds -= 1
    if (this.holds === 0) this.flush()
  }

  emit(draft: ChatEventDraft, at?: string | null): void {
    if (this.holding) this.held.push({ kind: 'event', draft, at })
    else this.out(draft, at)
  }

  /** The handle settled: its bindings go, after anything still held. */
  forget(messageUuid: string, turnId: string): void {
    const run = () => {
      this.suppressed.delete(messageUuid)
      this.resumed.delete(turnId)
    }
    if (this.holding) this.held.push({ kind: 'forget', run })
    else run()
  }

  private flush(): void {
    // Anything a consumer emits while this runs queues behind the held view.
    this.flushing = true
    try {
      for (let entry = this.held.shift(); entry; entry = this.held.shift()) {
        if (this.holds > 0) {
          this.held.unshift(entry)
          return
        }
        if (entry.kind === 'forget') entry.run()
        else if (entry.kind === 'slot') entry.slot.draft && this.out(entry.slot.draft)
        else this.out(entry.draft, entry.at)
      }
    } finally {
      this.flushing = false
    }
  }

  private out(draft: ChatEventDraft, at?: string | null): void {
    const shown = draft.type === 'turn_started' && this.resumed.delete(draft.turnId) ? { ...draft, trigger: { kind: 'resumed' as const } } : draft
    try {
      this.publish(shown, at)
    } catch (error) {
      if (!this.holding && !this.flushing) throw error
      this.failed(error)
    }
  }
}

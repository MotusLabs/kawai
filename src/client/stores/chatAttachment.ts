// Refcounted chat attachment ownership per host and connection
// (plan-workspace §6.1, design D7). One chat session holds exactly one wire
// `chat-attach` per connection no matter how many surfaces render it; a
// same-commit host transfer (full-screen unmount + embedded mount in one
// React commit) sends no wire traffic; and a reconnect of a still-held
// subscription re-attaches once, resuming the held history window
// (chat-history-window D3), while a true close/reopen never resumes.
//
// One registry instance exists per connection object — the host-supplied
// stable `sendMessage` reference. App's single useWebSocket() mints one for
// the page's lifetime, so every surface of the page shares one registry by
// passing that same reference. Hosts must pass the connection's original
// sendMessage, never a per-render wrapper: the reference IS the registry
// key, and a fresh wrapper would fork the state. A discarded connection's
// registry is garbage-collected with its state (WeakMap); two independent
// connections are independent registries, so a hold on one never suppresses
// the plain attach the other needs.
//
// Wiring contract (MiMo ca90ce4e, binding for §6.1): holds follow the mount
// and session lifetime of a surface — acquire on mount, release on unmount
// or session switch — and never the `connected` flag; a socket drop keeps
// the hold and the attached wire state. The surface's connection sync (run
// when its connected/connectionEpoch inputs change) performs the deferred
// initial attach or the one held-session reconnect attach, computing
// historyFrom at the wire attach from the transcript inputs the surface
// passes: the user's expanded history always resumes; a reconnect of a
// still-attached subscription resumes; a fresh attach after a real detach
// never does. The last release detaches one microtask later, which is what
// lets a transfer cancel it.
//
// Reveal designation is module-global (chatStore.pendingReveal is a
// client-global slot): the latest claimant per session is the one surface
// that consumes the reveal; when it unmounts, the previous still-mounted
// claimant takes over for subsequently set reveals. Draft text is not
// managed here: chatStore drafts stay per session, and two hosts editing
// one session share that draft last-write-wins.
import type { SendClientMessage } from '@shared/types'

/** The transcript facts a wire attach reads its history window from. */
export interface ChatResumeInputs {
  /** The user expanded history in this page load (chat-history-window D3). */
  historyExpanded?: boolean
  /** First event id of the held window; the resume point. */
  historyStartId?: string | null
}

export interface ChatAttachmentRegistry {
  /**
   * Connection sync: sends the one wire attach this (connection, session)
   * needs at `epoch` — the initial attach (deferred while offline), or the
   * held-subscription reconnect with historyFrom. No-op when no host holds
   * the session or the connection is already attached at this epoch.
   */
  sync(sessionId: string, epoch: number, resume: ChatResumeInputs): void
  /** Adds a host's hold (idempotent) and cancels a pending microtask detach. */
  acquire(sessionId: string, token: number): void
  /**
   * Removes a host's hold (idempotent); the last one schedules the wire
   * `chat-detach` a microtask ahead, so a same-commit re-acquire cancels it.
   */
  release(sessionId: string, token: number): void
}

/** Wire and hold state of one session on one connection. */
interface SessionAttachment {
  holds: Set<number>
  /** 'attached' exactly from this registry's wire chat-attach to its wire chat-detach. */
  wire: 'idle' | 'attached'
  /** The epoch the wire attach was sent at (reconnect detection). */
  attachedEpoch: number | null
  /** A microtask detach is scheduled and not yet fired or cancelled. */
  pendingDetach: boolean
}

const registries = new WeakMap<SendClientMessage, ChatAttachmentRegistry>()

/**
 * The attachment registry of one connection, keyed by the connection's
 * stable sendMessage identity: two calls with the same reference return the
 * same registry, and the module holds no other global attachment state.
 */
export function registryFor(connection: SendClientMessage): ChatAttachmentRegistry {
  const existing = registries.get(connection)
  if (existing) return existing
  const sessions = new Map<string, SessionAttachment>()
  const entryFor = (sessionId: string): SessionAttachment => {
    let entry = sessions.get(sessionId)
    if (!entry) {
      entry = { holds: new Set(), wire: 'idle', attachedEpoch: null, pendingDetach: false }
      sessions.set(sessionId, entry)
    }
    return entry
  }
  const registry: ChatAttachmentRegistry = {
    sync(sessionId, epoch, resume) {
      const entry = sessions.get(sessionId)
      if (!entry || entry.holds.size === 0) return // no host holds the session
      let historyFrom: string | undefined
      if (entry.wire === 'attached') {
        if (entry.attachedEpoch === epoch) return // already attached at this epoch
        // Reconnect of the still-held subscription: resume the held window.
        historyFrom = resume.historyStartId ?? undefined
      } else {
        // First attach on this connection (a fresh open, or a reopen after
        // a real detach): only the user's expanded history widens it.
        historyFrom = resume.historyExpanded === true ? resume.historyStartId ?? undefined : undefined
      }
      connection({ type: 'chat-attach', sessionId, ...(historyFrom !== undefined ? { historyFrom } : {}) })
      entry.wire = 'attached'
      entry.attachedEpoch = epoch
    },
    acquire(sessionId, token) {
      const entry = entryFor(sessionId)
      if (entry.holds.has(token)) return // idempotent: a re-run adds no second hold
      entry.holds.add(token)
      // A same-commit transfer lands before the microtask: keep the wire.
      entry.pendingDetach = false
    },
    release(sessionId, token) {
      const entry = sessions.get(sessionId)
      if (!entry || !entry.holds.delete(token)) return // idempotent no-op
      if (entry.holds.size > 0) return // another host still holds the session
      if (entry.wire !== 'attached' || entry.pendingDetach) return // nothing attached
      entry.pendingDetach = true
      queueMicrotask(() => {
        // A fired microtask always clears its flag: whether it detached or a
        // re-acquire in the same commit kept the subscription, the next last
        // release must be able to schedule its own detach afresh.
        const scheduled = entry.pendingDetach
        entry.pendingDetach = false
        if (!scheduled || entry.holds.size > 0) return // re-acquired in the same commit
        if (entry.wire !== 'attached') return
        connection({ type: 'chat-detach', sessionId })
        entry.wire = 'idle'
        entry.attachedEpoch = null
      })
    },
  }
  registries.set(connection, registry)
  return registry
}

let nextHostToken = 1
/** A host's stable identity for its holds and reveal claims (one per surface). */
export const createHostToken = (): number => nextHostToken++

// Reveal designation (design addendum 3): the single `pendingReveal` slot
// is client-global, so its consumer is too. Claimants are ordered per
// session; the last one is the designated consumer.
const revealClaimants = new Map<string, number[]>()

/** Makes `token` the designated reveal consumer of `sessionId`. */
export function claimReveal(sessionId: string, token: number): void {
  const claimants = (revealClaimants.get(sessionId) ?? []).filter(claimed => claimed !== token)
  claimants.push(token)
  revealClaimants.set(sessionId, claimants)
}

/** Drops a claim (idempotent); the previous claimant becomes designated. */
export function releaseReveal(sessionId: string, token: number): void {
  const claimants = revealClaimants.get(sessionId)
  if (!claimants) return
  const remaining = claimants.filter(claimed => claimed !== token)
  if (remaining.length === 0) revealClaimants.delete(sessionId)
  else revealClaimants.set(sessionId, remaining)
}

/** True when `token` is the session's designated reveal consumer. */
export function isRevealDesignated(sessionId: string, token: number): boolean {
  const claimants = revealClaimants.get(sessionId)
  return claimants !== undefined && claimants[claimants.length - 1] === token
}

// The Claude adapter's retained context reading across process respawns
// (task-98101592 A2, GAP8). Kawai boots a fresh package driver for each
// process (runtimeBoot.ts), and that driver's own context tracker starts
// empty, so its spawn-time profile re-anchor has nothing to re-scale. The
// source driver kept one tracker for the session: a respawn re-anchored the
// last reading on the new process's profile window, flagged as a
// correction, before any frame of the new process.
//
// This mirror keeps what the adapter forwarded: the last reading's used
// tokens and measurement time (a null reading clears them), and the model
// window when a reading was derived from it — the only window a forwarded
// reading proves. A report threshold, a profile window and a reserve are
// process facts and are never kept. At the first spawn of a later package
// driver it rebuilds the reading in a fresh public ContextTracker (the
// package's own, from @motuslabs/agent-runtime/usage): the new profile window,
// else the kept model window, then the kept used tokens. That one reading is
// the correction (persist true), labelled with the tracker's own threshold
// derivation. Nothing is published when nothing was retained, when no
// denominator is known (the disclosed limit), or when it equals the last
// forwarded reading. A respawn inside one package driver is the package's
// own re-anchor, so only generation 1 of a later driver is corrected here.
//
// Ownership: the mirror never keeps an object a host callback receives. It
// copies each observed reading, keeps its own copy of a correction and hands
// out another, so a host mutating a delivered view or correction cannot change
// the measured tokens, time or window a later respawn re-anchors.
import type { ChatContextUsage } from '../../../shared/chat'
import { ContextTracker, parsePositiveTokens } from '@motuslabs/agent-runtime/usage'

export interface ContextCorrection {
  usage: ChatContextUsage
  meta: { persist: true; thresholdSource: string }
}

export class ClaudeContextMirror {
  private last: ChatContextUsage | null = null
  private modelWindow: number | null = null
  /** A package driver has spawned before: the next driver's first spawn is a respawn. */
  private spawnedBefore = false

  /** A reading the adapter is about to forward (before the host callback runs). */
  observe(usage: ChatContextUsage | null, meta?: { thresholdSource?: string }): void {
    this.last = usage === null ? null : snapshot(usage)
    if (usage && meta?.thresholdSource === 'model-window-fallback') this.modelWindow = Math.max(this.modelWindow ?? 0, usage.thresholdTokens)
  }

  /** A package spawn; the correction to publish first, if any (already mirrored). */
  spawned(generation: number, childEnv: Readonly<Record<string, string>>): ContextCorrection | null {
    const respawn = this.spawnedBefore && generation === 1
    this.spawnedBefore = true
    const last = this.last
    if (!respawn || !last) return null
    const tracker = new ContextTracker()
    if (this.modelWindow !== null) tracker.noteModelWindow(this.modelWindow)
    tracker.setProfileWindow(parsePositiveTokens(childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW))
    const step = tracker.readRequest(last.usedTokens, last.at)
    if (step.kind !== 'reading') return null
    const usage = step.usage
    if (usage.thresholdTokens === last.thresholdTokens && Boolean(usage.thresholdApproximate) === Boolean(last.thresholdApproximate)) return null
    // A fresh tracker holds no report threshold or reserve: a profile window is a stand-in, else the model window is.
    const thresholdSource = tracker.thresholdLabel(usage)
    this.last = snapshot(usage)
    return { usage: snapshot(usage), meta: { persist: true, thresholdSource } }
  }
}

/** A detached copy of one reading (ChatContextUsage holds only scalars). */
const snapshot = (usage: ChatContextUsage): ChatContextUsage => ({ ...usage })

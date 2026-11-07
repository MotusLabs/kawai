// The stop's verdict on one owned process generation (task 4.1, A3), read
// only from the evidence its owner froze when the leader ended. A provider's
// error class is never consulted here: an SDK AbortError is a projection of
// the process's end, not proof of what ended it.
//
// - clean: the leader exited with code 0.
// - owned: termination was marked before the exit, and the leader died of a
//   signal this owner successfully sent after the mark. This is qualified
//   evidence for the exclusive-owner path, not proof against a competing
//   sender of the same signal.
// - failed: everything else. That covers an exit observed before the mark
//   (whatever the SDK later reports), a nonzero or trapped exit (143
//   included), a signal this owner never sent, and missing evidence.
//
// A failed generation becomes one NativeExitFailure. It nests only the stop
// token projections actually stored for that generation. It is a private
// typed error with safe facts, beside, never instead of, the generation's
// other causes.
import { AgentRuntimeError } from '../errors.js'
import type { NativeEvidence, OwnedProcess } from './ownedProcess.js'

export type NativeVerdict = 'clean' | 'owned' | 'failed'

export function nativeVerdict(evidence: NativeEvidence | null): NativeVerdict {
  if (!evidence || evidence.exit.kind !== 'exited') return 'failed'
  const { code, signal } = evidence.exit
  if (code === 0 && signal === null) return 'clean'
  if (signal !== null && evidence.marked && evidence.sentAfterMark.includes(signal)) return 'owned'
  return 'failed'
}

/** The safe facts of a failed native generation. */
export interface NativeExitFacts {
  generation: number
  pid: number | null
  code: number | null
  signal: NodeJS.Signals | null
  /** False when termination had already been marked when the exit was observed. */
  observedBeforeStop: boolean | null
}

export class NativeExitFailure extends AgentRuntimeError {
  readonly facts: NativeExitFacts

  constructor(facts: NativeExitFacts, projections: readonly unknown[]) {
    super({ category: 'transport', message: describe(facts) }, projections)
    this.facts = facts
  }
}

function describe(facts: NativeExitFacts): string {
  const end = facts.observedBeforeStop === null ? 'left no exit evidence' : facts.signal ? `ended by ${facts.signal}` : `exited with code ${facts.code}`
  const when = facts.observedBeforeStop === null ? '' : facts.observedBeforeStop ? ' before the stop' : ' after the stop began'
  return `agent process generation ${facts.generation} ${end}${when}`
}

/**
 * Every cause one owned generation contributes after the joins. The child
 * errors and recorder failures always count, and so does a spawn failure's
 * original error. A NativeExitFailure, nesting
 * `projections`, counts only when the verdict is failed.
 */
export function nativeCauses(generation: number, owned: OwnedProcess, projections: readonly unknown[]): unknown[] {
  const evidence = owned.evidence
  const causes: unknown[] = [...(evidence?.errors ?? []), ...owned.observerFailures]
  if (nativeVerdict(evidence) !== 'failed') return causes
  const exit = evidence?.exit
  const exited = exit?.kind === 'exited' ? exit : null
  const facts: NativeExitFacts = {
    generation,
    pid: owned.pid,
    code: exited?.code ?? null,
    signal: exited?.signal ?? null,
    observedBeforeStop: evidence && exited ? !evidence.marked : null,
  }
  // A spawn failure created no process, so no NativeExitFailure. Its original
  // error is kept by identity: the SDK reports only a replacement of it.
  if (exit?.kind === 'spawn-failed') return [exit.error, ...causes, ...projections]
  return [new NativeExitFailure(facts, projections), ...causes]
}

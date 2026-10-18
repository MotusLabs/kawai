// The landing-mechanism registry (plan-execution D13, X6; integration-
// candidates D1). A mechanism is the per-mode half of landing: Start's
// probe, the commit a change's worktree starts from (read at provision
// time), the landing stage of a passed change, the follow-on of a settled
// landing effect, and the effect adapters of the kinds it owns. The
// executor resolves the mechanism by `execution.landingMode`; Start's
// `landing-mode-supported` consults the modes the composition registers, so
// an unregistered mode never starts. The composition builds the map once
// and passes it to the Start service, the executor, and the provision
// adapter (I1).
import type { PlanLanding } from '../../../shared/plans'
import type { EffectAdapter } from '../execution/effects'
import type { LandingAdapters, LandingDeps } from '../execution/executionLanding'
import type { EffectKind } from '../../../shared/planExecution'
import type { ChangeRow, EffectRow, ExecutionRow, RoundRow } from '../execution/executionRows'
import type { GhCommandOptions } from './ghCommand'
import type { GitRemoteError, lsRemoteHead } from './gitRemote'
import type { ProbeInput, ProbeResult } from './landingProbe'

export type LandingMode = 'direct' | 'integration-branch'

export const REGISTERED_LANDING_MODES: readonly LandingMode[] = ['direct']

/** Start's probe input: direct's, plus the plan and its landing content. */
export interface MechanismProbeInput extends ProbeInput {
  teamId: string
  planId: string
  landing: PlanLanding
}

/** What a provision reads to resolve its start commit. */
export interface StartBaseInput {
  execution: ExecutionRow
  /** The base the provision command recorded: the execution's Start-time base commit. */
  recorded: string
  /** The main checkout. */
  repo: string
  lsRemoteHead: typeof lsRemoteHead
}

export type StartBaseResult = { ok: true; sha: string } | { ok: false; error: GitRemoteError }

export interface LandingMechanism {
  readonly mode: LandingMode
  probe(input: MechanismProbeInput, options?: GhCommandOptions): Promise<ProbeResult>
  /** The commit a change's worktree starts from, resolved when the provision runs. */
  startBase(input: StartBaseInput): Promise<StartBaseResult>
  /** One landing tick for a passed change. */
  land(deps: LandingDeps, adapters: LandingAdapters, row: ChangeRow, round: RoundRow): Promise<void>
  /** The follow-on of a done landing effect. */
  landOutcome(deps: LandingDeps, effect: EffectRow, adapters: LandingAdapters): Promise<void>
  /** The adapter for an effect kind the mechanism owns; undefined for the rest. */
  effectAdapter(kind: EffectKind, adapters: LandingAdapters, ghOptions?: GhCommandOptions): EffectAdapter | undefined
  /** Execution-level effects (X3) Start inserts in its transaction: integration's create-integration (D4). */
  startEffects?(input: { execution: ExecutionRow; probe: ProbeResult; main: string }): Array<{ kind: EffectKind; effectKey: string; command: Record<string, unknown> }>
  /** A done execution-level effect's record (integration's branch creation). */
  effectDone?(effect: EffectRow): void
  /** A failed round's fix step begins (D7: integration fails the round's candidate). */
  roundFailed?(round: RoundRow): void
}

export type LandingMechanisms = ReadonlyMap<string, LandingMechanism>

/** The mechanism of a mode; a mode Start would have refused is a programming error. */
export function mechanismFor(mechanisms: LandingMechanisms, mode: string): LandingMechanism {
  const mechanism = mechanisms.get(mode)
  if (mechanism === undefined) throw new Error(`No landing mechanism is registered for mode ${mode}.`)
  return mechanism
}

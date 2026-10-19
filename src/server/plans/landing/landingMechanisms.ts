// The landing-mechanism registry (plan-execution D13, X6): the modes this
// build ships. `direct` is registered here; `integration-branch` arrives
// with the integration-candidates change, which registers its mechanism —
// until then Start's `landing-mode-supported` refuses it (the precondition
// consults the mode list the composition builds from this registry).
export type LandingMode = 'direct' | 'integration-branch'

export const REGISTERED_LANDING_MODES: readonly LandingMode[] = ['direct']

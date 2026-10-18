// The executor's required seams with neutral test values (plan-execution
// I1): every member ready and released, no acceptance conditions, every
// group scoped. A test overriding one passes its own after the spread.
import type { ExecutorDeps } from '../plans/execution/executor'

export const neutralExecutorSeams: Pick<ExecutorDeps, 'releases' | 'conditionsOf' | 'groupScoped'> = {
  releases: { readiness: () => ({ ready: true, reason: null }), release: () => ({ ok: true }) },
  conditionsOf: () => [],
  groupScoped: () => true,
}

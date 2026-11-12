// propertyCases.ts - The executed case count of a seeded property, matrix,
// or model test (check-time-optimization D4). A test keeps its declared
// count for its title (`const CASES = 300`, so coverage citations stay
// valid) and loops to `propertyCases(CASES)`. Local and hook runs execute
// the first quarter, rounded up, of a declared count of 50 or more; CI
// (`CI=true`) and `bun run check --full-properties`
// (`KAWAI_FULL_PROPERTIES=1`) execute the declared count. Cases are seeded
// by index or drawn in order from one seeded stream, so a reduced run
// executes exactly the first cases of the full run, with the same seeds, and
// a local failure reproduces in CI and the reverse.

/** Declared counts below this always run in full. */
export const REDUCTION_THRESHOLD = 50
/** A reduced run executes ceil(declared / REDUCTION_FACTOR) cases. */
export const REDUCTION_FACTOR = 4

export function propertyCases(declared: number, env: NodeJS.ProcessEnv = process.env): number {
  if (declared < REDUCTION_THRESHOLD) return declared
  if (env.CI === 'true' || env.KAWAI_FULL_PROPERTIES === '1') return declared
  return Math.ceil(declared / REDUCTION_FACTOR)
}

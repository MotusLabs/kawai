// propertyCases.ts - the package's copy of the root runner's executed case
// count rule (src/server/__tests__/helpers/propertyCases.ts, check-time-
// optimization D4): the package project compiles alone, so it cannot import
// the root helper. A declared count of 50 or more runs its first quarter,
// rounded up, in local and hook runs, and in full under CI (`CI=true`) and
// `bun run check --full-properties` (`KAWAI_FULL_PROPERTIES=1`).
// src/server/__tests__/codexCapacityPropertyCases.test.ts keeps both equal.

export function propertyCases(declared: number, env: NodeJS.ProcessEnv = process.env): number {
  if (declared < 50) return declared
  if (env.CI === 'true' || env.KAWAI_FULL_PROPERTIES === '1') return declared
  return Math.ceil(declared / 4)
}

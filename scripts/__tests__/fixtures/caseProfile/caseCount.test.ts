// caseCount.test.ts - caseProfileProbe's probe (check-time-optimization
// D4, task 4.3). It is copied into a temporary repository as
// src/server/__tests__/caseCount.test.ts beside a copy of
// helpers/propertyCases.ts, where its import resolves, and run there by the
// real unit runner under the real check pipeline. It writes the seeds it
// executed to KAWAI_PROBE_OUT, so the probe sees the count and the prefix.
import { test } from 'bun:test'
import fs from 'node:fs'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0x7e57
const CASES = 300

test(`records its executed seeds (seed 0x7e57, ${CASES} cases)`, () => {
  const seeds: number[] = []
  for (let index = 0; index < propertyCases(CASES); index++) seeds.push(SEED + index)
  fs.writeFileSync(process.env.KAWAI_PROBE_OUT!, JSON.stringify(seeds))
})

// propertyCases.test.ts - PC1 of check-time-optimization design.md (D4,
// task 4.1), exhaustive: for every declared n from 1 to 2,000 and every
// environment of {unset, CI=true, KAWAI_FULL_PROPERTIES=1, both},
// propertyCases(n) is n when n < 50 or CI or the full flag is set, and
// ceil(n/4) otherwise. 8,000 cases; no seed is needed.
import { expect, test } from 'bun:test'
import { propertyCases } from './helpers/propertyCases'

const ENVIRONMENTS: Array<{ name: string; env: NodeJS.ProcessEnv; full: boolean }> = [
  { name: 'unset', env: {}, full: false },
  { name: 'CI=true', env: { CI: 'true' }, full: true },
  { name: 'KAWAI_FULL_PROPERTIES=1', env: { KAWAI_FULL_PROPERTIES: '1' }, full: true },
  { name: 'both', env: { CI: 'true', KAWAI_FULL_PROPERTIES: '1' }, full: true },
]

// @covers: dev-checks › Local runs execute a reduced case profile › A small declared count
test('PC1: propertyCases(n) is n below 50 or under CI or the full flag, else ceil(n/4), for n 1–2,000 in 4 environments', () => {
  const mismatches: string[] = []
  let checked = 0
  for (const { name, env, full } of ENVIRONMENTS) {
    for (let n = 1; n <= 2_000; n++) {
      // The oracle, written out case by case rather than by formula reuse.
      let expected: number
      if (n < 50 || full) expected = n
      else {
        expected = Math.trunc(n / 4)
        if (expected * 4 < n) expected += 1
      }
      checked += 1
      const actual = propertyCases(n, env)
      if (actual !== expected) mismatches.push(`${name}, n=${n}: ${actual} != ${expected}`)
    }
  }
  expect(checked).toBe(8_000)
  expect(mismatches.slice(0, 10)).toEqual([])
})

test('other values of CI or the flag do not lift the reduction', () => {
  expect(propertyCases(300, { CI: '1' })).toBe(75)
  expect(propertyCases(300, { CI: 'false', KAWAI_FULL_PROPERTIES: 'true' })).toBe(75)
})

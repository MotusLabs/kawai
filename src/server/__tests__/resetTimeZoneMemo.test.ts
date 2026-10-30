// Property P2 of catalog-resolution-cache: the memoized `isResetTimeZone`
// equals the unmemoized check for every supported IANA zone plus seeded
// malformed strings, on the first and on repeated calls (design D3).
import { expect, test } from 'bun:test'
import { checkResetTimeZone, isResetTimeZone } from '../chat/limitSignals'

const SEED = 0x7e2a
const MALFORMED = 50

/** LCG drawing from the high bits: the low bits cycle too briefly. */
function rng(seed: number): (n: number) => number {
  let state = seed >>> 0
  return n => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 16) % n
  }
}

function malformed(rand: (n: number) => number): string[] {
  const shapes = [
    () => `${'+-'[rand(2)]}${String(24 + rand(76)).padStart(2, '0')}:00`,
    () => `+${String(rand(24)).padStart(2, '0')}:${60 + rand(40)}`,
    () => `UTC${'+-'[rand(2)]}${rand(14)}`,
    () => `Mars/Zone${rand(1000)}`,
    () => `${'+-'[rand(2)]}${rand(10)}:${rand(10)}`,
    () => ' '.repeat(rand(3)),
    () => `Asia/Shanghai${'x '[rand(2)]}`,
  ]
  return Array.from({ length: MALFORMED }, () => shapes[rand(shapes.length)]())
}

test('P2: memoized zone validity equals the unmemoized check, first and repeated', () => {
  const rand = rng(SEED)
  const zones = [...Intl.supportedValuesOf('timeZone'), '+08:00', '-05:30', '+00:00', ...malformed(rand)]
  const bad = malformed(rand)
  expect(bad.some(zone => !checkResetTimeZone(zone))).toBe(true)
  for (const round of ['first', 'repeat', 'again']) {
    for (const zone of zones) {
      expect({ round, zone, valid: isResetTimeZone(zone) }).toEqual({ round, zone, valid: checkResetTimeZone(zone) })
    }
  }
})

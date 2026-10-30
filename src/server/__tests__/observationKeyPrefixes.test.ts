// @reads: src/server/metrics/observations/*.ts
// compact-observation-detail D4: every source-key template the observation
// writers use is classified on purpose. A durable source treated as ephemeral
// would be re-recorded after pruning and double-count lifetime totals; a new
// prefix (tool-call-metrics' planned `tool_streak` key) must be added here.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDurableObservationKey } from '../../shared/processObservations'

const DIR = join(import.meta.dir, '..', 'metrics', 'observations')

/** Prefix → [durable, reason]. */
const CLASSIFIED: Record<string, [boolean, string]> = {
  'usage:': [true, 'chat_turn_usage rows are rescanned by the reconciler'],
  'source:': [true, 'durable source rows are rescanned by the reconciler'],
  'acceptance:': [true, 'accepted results are rescanned by the reconciler'],
  'first-acceptance:': [true, 'marks the first acceptance of a task for its lifetime'],
  'chat:': [false, 'one live chat event; never replayed once its turn ends'],
  'segment:': [false, 'one partial row per call or request open at turn close'],
  'turn-end:': [false, 'one synthesized turn end per live turn'],
  'restart-gap:': [false, 'one restart closure per live turn'],
  'compaction:': [false, 'one compaction boundary; replays arrive within the session'],
  'settings:': [false, 'random id per reading'],
  'context:': [false, 'random id per sample'],
  'gap:': [false, 'random id per recorder outage'],
}
/** Templates in these files that are not observation source keys. */
const NOT_KEYS = new Set(['cursor:'])

function templatePrefixes(): Set<string> {
  const prefixes = new Set<string>()
  for (const file of readdirSync(DIR).filter(name => name.endsWith('.ts'))) {
    for (const match of readFileSync(join(DIR, file), 'utf8').matchAll(/`([a-z_-]+:)\$\{/g)) {
      if (!NOT_KEYS.has(match[1])) prefixes.add(match[1])
    }
  }
  return prefixes
}

test('every observation source-key template is classified durable or ephemeral', () => {
  const found = templatePrefixes()
  expect(found.size).toBeGreaterThan(5)
  for (const prefix of found) expect([prefix, CLASSIFIED[prefix]?.[1]]).toEqual([prefix, expect.any(String)])
})

test('the shared durable-key predicate agrees with the classification', () => {
  for (const [prefix, [durable]] of Object.entries(CLASSIFIED)) {
    expect([prefix, isDurableObservationKey(`${prefix}x`)]).toEqual([prefix, durable])
  }
  expect(isDurableObservationKey('xusage:a')).toBe(false)
})

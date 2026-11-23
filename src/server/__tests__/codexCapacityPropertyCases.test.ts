// The agent-runtime package's propertyCases copy (its project compiles alone)
// executes exactly the root runner's case counts in every profile, so the
// codex-capacity-retry properties P1-P3 honour --full-properties.
import { expect, test } from 'bun:test'
import { propertyCases as root } from './helpers/propertyCases.js'
import { propertyCases as pkg } from '../../../packages/agent-runtime/__tests__/helpers/propertyCases.js'

test('the package propertyCases copy matches the root rule for every count and profile', () => {
  const profiles: NodeJS.ProcessEnv[] = [{}, { CI: 'true' }, { KAWAI_FULL_PROPERTIES: '1' }, { CI: '1' }, { KAWAI_FULL_PROPERTIES: 'true' }]
  for (const env of profiles) for (let declared = 0; declared <= 2_000; declared++) {
    if (pkg(declared, env) !== root(declared, env)) throw new Error(`declared ${declared} env ${JSON.stringify(env)}: ${pkg(declared, env)} != ${root(declared, env)}`)
  }
  expect(pkg(1000, {})).toBe(250)
  expect(pkg(1000, { CI: 'true' })).toBe(1000)
})

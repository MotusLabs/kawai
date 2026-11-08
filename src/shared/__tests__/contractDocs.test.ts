// @reads: docs/agent-collaboration.md, openspec/config.yaml
// The contract guidance (implementation-contract D8, task 7.1): the
// example contract in "Write the implementation contract" parses as written,
// and the design rule in openspec/config.yaml requires the section and points
// at that guidance.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { parseContract } from '../implementationContract'

const ROOT = path.resolve(import.meta.dir, '../../..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

test('the collaboration doc\'s example contract parses, with every part and both globs', () => {
  const doc = read('docs/agent-collaboration.md')
  const section = doc.slice(doc.indexOf('## Write the implementation contract'))
  expect(section.length).toBeLessThan(doc.length)
  const example = /```markdown\n([\s\S]*?)```/.exec(section)?.[1]
  expect(example).toBeDefined()
  const parsed = parseContract(example!)
  expect(parsed.problems).toEqual([])
  expect(parsed.contract!.scope).toEqual(['src/server/export/**', 'src/shared/exportRows.ts'])
  expect([parsed.contract!.acceptance, parsed.contract!.invariants, parsed.contract!.verification, parsed.contract!.excluded]
    .map(part => part.map(clause => clause.id))).toEqual([['A1'], ['I1'], ['V1'], ['X1']])
})

test('the design rule requires the Implementation contract section and points at the guidance', () => {
  const config = Bun.YAML.parse(read('openspec/config.yaml')) as { rules: { design: string[] } }
  const rule = config.rules.design.find(entry => entry.includes('Implementation contract'))
  expect(rule).toBeDefined()
  expect(rule).toContain('docs/agent-collaboration.md')
  for (const heading of ['Acceptance', 'Invariants', 'Scope', 'Verification', 'Excluded']) expect(rule).toContain(heading)
})

// @reads: docs/agent-collaboration.md, docs/oracle-hazards.md, docs/architecture/tasks.md
// The review protocol in the docs (review-findings-ledger D11, task 7.1): the
// collaboration doc defines the protocol once, and the hazard catalog and
// architecture point at it. The convergence playbook (review-convergence
// decision 11, task 10.1) lives once, in the protocol section. The role
// files that apply the protocol are user-level configuration
// (`~/.kawai/groups/`), outside this repository, so no test reads them.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../../..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

test('the collaboration doc defines the protocol once; the hazard catalog and the architecture point at it', () => {
  const doc = read('docs/agent-collaboration.md')
  expect(doc.match(/^## Review protocol$/gm)).toHaveLength(1)
  const section = doc.slice(doc.indexOf('## Review protocol'), doc.indexOf('## Write acceptance as oracles'))
  for (const phrase of ['P0', 'P1', 'P2 never blocks', 'task_dispute_findings', 'task_decide_dispute', 'review-p0']) expect(section).toContain(phrase)
  expect(read('docs/oracle-hazards.md')).toContain('"Review protocol"')
  expect(read('docs/architecture/tasks.md')).toMatch(/^- Review findings ledger \(review-findings-ledger; protocol in `docs\/agent-collaboration.md`, "Review protocol"\)/m)
})

// The playbook's own lines: a copy elsewhere in the doc is a second definition.
const PLAYBOOK = ['S4, stagnation: the open P0/P1 count does not fall over three reviews', '**Amend the contract**: the contract asks for the wrong thing']

test('the convergence playbook appears once, in the protocol section', () => {
  const doc = read('docs/agent-collaboration.md')
  const section = doc.slice(doc.indexOf('## Review protocol'), doc.indexOf('## Write acceptance as oracles'))
  for (const line of PLAYBOOK) {
    expect(section).toContain(line)
    expect(doc.split(line).length - 1).toBe(1)
  }
})

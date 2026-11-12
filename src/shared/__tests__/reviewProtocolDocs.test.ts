// @reads: .kawai/groups, .kawai/groups/**, docs/agent-collaboration.md, docs/oracle-hazards.md, docs/architecture/tasks.md
// The review protocol in the prompts and docs (review-findings-ledger D11,
// task 7.1): no role file asks for a free-text verdict; reviewers get the
// levels, the clause and evidence rules, and dispositions; developers fix only
// the listed ids and dispute with evidence; the Lead and Change Leads know
// dispute cards and `review-p0`; the collaboration doc defines the protocol
// once, and the hazard catalog and architecture point at it. The
// convergence playbook (review-convergence decision 11, task 10.1) replaces
// the two-correction-rounds rule: it lives once, in the protocol section, and
// the Lead and Change Lead prompts point at it.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../../..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const GROUPS = '.kawai/groups'
const roleFiles = () => fs.readdirSync(path.join(ROOT, GROUPS)).filter(name => name.endsWith('.md')).map(name => `${GROUPS}/${name}`)

test('no role file asks for a free-text verdict', () => {
  const files = roleFiles()
  expect(files).toContain(`${GROUPS}/reviewers.md`)
  for (const file of files) {
    const text = read(file).replace(/\s+/g, ' ')
    expect({ file, hits: text.match(/verdict `?pass`? or `?fail`?|verdict \(approve|findings ranked by severity/gi) ?? [] }).toEqual({ file, hits: [] })
  }
})

test('the reviewer prompt carries the levels, the clause and evidence rules, and dispositions', () => {
  const text = read(`${GROUPS}/reviewers.md`).replace(/\s+/g, ' ')
  for (const phrase of ['P2 never blocks', 'cites the clause it violates', 'needs evidence', '`resolved`, `still-open`, or `regressed`', 'structured `items`', 'Review protocol']) {
    expect(text).toContain(phrase)
  }
})

test('every developer prompt fixes only the listed ids and disputes with evidence', () => {
  for (const name of ['junior-devs', 'middle-devs', 'senior-devs']) {
    const text = read(`${GROUPS}/${name}.md`).replace(/\s+/g, ' ')
    expect(text).toContain('Fix only the finding ids the fix instruction lists as blocking, minimally')
    expect(text).toContain('`task_dispute_findings`')
  }
})

test('the Lead and Change Lead prompts cover dispute cards and review-p0', () => {
  const lead = read(`${GROUPS}/lead.md`).replace(/\s+/g, ' ')
  for (const phrase of ['`decision_record` Uphold or Reject', '`task_decide_dispute`', '`review-p0`']) expect(lead).toContain(phrase)
  const changeLeads = read(`${GROUPS}/change-leads.md`).replace(/\s+/g, ' ')
  for (const phrase of ['`review-p0`', '`task_decide_dispute`']) expect(changeLeads).toContain(phrase)
})

test('the collaboration doc defines the protocol once; the hazard catalog and the architecture point at it', () => {
  const doc = read('docs/agent-collaboration.md')
  expect(doc.match(/^## Review protocol$/gm)).toHaveLength(1)
  const section = doc.slice(doc.indexOf('## Review protocol'), doc.indexOf('## Write acceptance as oracles'))
  for (const phrase of ['P0', 'P1', 'P2 never blocks', 'task_dispute_findings', 'task_decide_dispute', 'review-p0']) expect(section).toContain(phrase)
  expect(read('docs/oracle-hazards.md')).toContain('"Review protocol"')
  expect(read('docs/architecture/tasks.md')).toMatch(/^- Review findings ledger \(review-findings-ledger; protocol in `docs\/agent-collaboration.md`, "Review protocol"\)/m)
})

// The playbook's own lines: a copy anywhere else is a second definition.
const PLAYBOOK = ['S4, stagnation: the open P0/P1 count does not fall over three reviews', '**Amend the contract**: the contract asks for the wrong thing']

test('no role file keeps the two-correction-rounds rule', () => {
  for (const file of roleFiles()) {
    const text = read(file).replace(/\s+/g, ' ')
    expect({ file, hits: text.match(/two unsuccessful correction rounds|two correction rounds|two-unsuccessful-correction-round/gi) ?? [] }).toEqual({ file, hits: [] })
  }
})

test('the convergence playbook appears once, in the protocol section', () => {
  const doc = read('docs/agent-collaboration.md')
  const section = doc.slice(doc.indexOf('## Review protocol'), doc.indexOf('## Write acceptance as oracles'))
  for (const line of PLAYBOOK) {
    expect(section).toContain(line)
    const copies = [...roleFiles(), 'docs/agent-collaboration.md'].map(file => ({ file, count: read(file).split(line).length - 1 })).filter(entry => entry.count > 0)
    expect(copies).toEqual([{ file: 'docs/agent-collaboration.md', count: 1 }])
  }
})

test('the Lead and Change Lead prompts point at the playbook with Amend the contract and the signals', () => {
  for (const name of ['lead', 'change-leads']) {
    const text = read(`${GROUPS}/${name}.md`).replace(/\s+/g, ' ')
    for (const phrase of ['`Amend the contract`', 'S1–S5', '"Convergence"', 'Review protocol']) expect({ name, phrase, found: text.includes(phrase) }).toEqual({ name, phrase, found: true })
  }
})

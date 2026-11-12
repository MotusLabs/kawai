// Property P4 — revision isolation (implementation-contract design,
// "Properties"; invariant I2): over seeded sequences of agent amendments
// (omitted, blank, valid, or malformed contract) and human publications
// (including clears) through TaskService over a real SQLite store, every
// stored revision's contract_hash equals the hash of its stored contract,
// earlier revisions never change, and a refusal writes no revision row.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { contractHash } from '../team/contractHash'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { renderContract, type ImplementationContract } from '../../shared/implementationContract'
import { CASES, generate, mulberry32, SEED } from '../../shared/__tests__/contractFixtures'
import { propertyCases } from './helpers/propertyCases'

let root: string
let team: TeamIdentity
const records = new Map<string, ChatSessionRecord>()

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-contract-p4-')))
  const repo = path.join(root, 'repo')
  for (const args of [['init', '-q', repo], ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    const result = spawnSync('git', args, { encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  records.set('lead', { sessionId: 'lead', groupId: 'leads', projectPath: repo, name: 'lead', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

type Step =
  | { by: 'agent'; contract: 'omitted' | 'blank' | 'valid' | 'malformed' }
  | { by: 'human'; contract: 'omitted' | 'valid' | 'malformed' | 'clear' }
const STEPS: Step[] = [
  { by: 'agent', contract: 'omitted' }, { by: 'agent', contract: 'blank' }, { by: 'agent', contract: 'valid' }, { by: 'agent', contract: 'malformed' },
  { by: 'human', contract: 'omitted' }, { by: 'human', contract: 'valid' }, { by: 'human', contract: 'malformed' }, { by: 'human', contract: 'clear' },
]

/** An absolute glob under Scope is a problem, whatever else the contract holds. */
const malformed = (contract: ImplementationContract) => renderContract(contract).replace('### Scope\n', '### Scope\n- /absolute/**\n')

/** The oracle: the next revision's hash, or a refusal (C1–C7, written independently of the store's rule). */
function expected(previous: string | null, step: Step, valid: ImplementationContract): string | null | 'refused' {
  switch (step.contract) {
    case 'omitted': case 'blank': return previous
    case 'valid': return contractHash(valid)
    case 'malformed': return 'refused'
    case 'clear': return previous === null ? null : 'refused'
  }
}

test('P4: stored hashes match their contracts, earlier revisions never change, refusals write nothing (seed 0x1C0A7AC7, 500 cases)', async () => {
  const db = schemaCopy()
  const store = new TaskStore(db, new MailboxStore(db))
  const service = new TaskService(store, { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
  const lead = taskHandlers(service, 'lead')
  const rows = (taskId: string) => db.prepare('SELECT revision, contract, contract_hash FROM team_task_revisions WHERE task_id = ? ORDER BY revision')
    .all(taskId) as Array<{ revision: number; contract: string | null; contract_hash: string | null }>
  const rand = mulberry32(SEED + 4)
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!
  let refusals = 0
  let clearsRefused = 0
  for (let index = 0; index < propertyCases(CASES); index++) {
    const initial = rand() < 0.5 ? generate(rand) : null
    const task = await lead.task_create({ title: `P4 ${index}`, direction: 'v1', ...(initial ? { contract: renderContract(initial) } : {}) }) as { id: string }
    let snapshot = rows(task.id)
    const length = 1 + Math.floor(rand() * 5)
    for (let n = 0; n < length; n++) {
      const step = pick(STEPS)
      const valid = generate(rand)
      const label = `case ${index} step ${n}: ${step.by} ${step.contract}`
      const text = step.contract === 'valid' ? renderContract(valid) : step.contract === 'malformed' ? malformed(valid)
        : step.contract === 'blank' || step.contract === 'clear' ? '' : undefined
      const want = expected(snapshot.at(-1)!.contract_hash, step, valid)
      const contract = text === undefined ? {} : { contract: text }
      const run = step.by === 'agent'
        ? lead.task_amend({ task_id: task.id, direction: `v${n + 2}`, ...contract })
        : service.publish({ kind: 'human', team }, task.id, { direction: `v${n + 2}`, rationale: 'r', baseRevision: snapshot.at(-1)!.revision, requestKey: `p4-${index}-${n}`, ...contract })
      const outcome = await run.then(() => 'published' as const, (error: Error) => error)
      const after = rows(task.id)
      if (want === 'refused') {
        expect(outcome, label).toBeInstanceOf(Error)
        expect(after, label).toEqual(snapshot)
        refusals++
        if (step.contract === 'clear') clearsRefused++
      } else {
        expect(outcome, label).toBe('published')
        expect(after.slice(0, -1), label).toEqual(snapshot)
        expect(after.at(-1)!.contract_hash, label).toBe(want)
      }
      for (const row of after) {
        expect(row.contract_hash, label).toBe(row.contract === null ? null : contractHash(JSON.parse(row.contract) as ImplementationContract))
      }
      snapshot = after
    }
  }
  // The generator reaches both refusal kinds, so the property is not vacuous.
  expect(refusals).toBeGreaterThan(50)
  expect(clearsRefused).toBeGreaterThan(5)
  db.close()
}, 120_000)

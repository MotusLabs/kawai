// The contract in reads (implementation-contract design D7, task 2.4): the
// delivered task header shows the current revision's identity and its
// clauses and globs, or says the task has no contract; a context recorded
// before contracts formats as it did; the task detail's revisions carry
// each revision's contract and identity.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { buildTaskContext, formatTaskHeader } from '../team/taskContext'
import { contractHash, textHash } from '../team/contractHash'
import type { TeamIdentity } from '../team/teamIdentity'
import { parseContract } from '../../shared/implementationContract'

const team = { teamId: '/repo/.git', groupsRoot: '/repo' } as unknown as TeamIdentity
const human = { kind: 'human' as const, team }
const contractText = (invariant: string) => ['## Implementation contract', '### Acceptance', '- A1: Lists tasks', '### Invariants',
  `- I1: ${invariant}`, '### Scope', '- `src/server/team/**`', '- `docs/**`', '### Verification', '- V1: check passes', '### Excluded', '- X1: The client'].join('\n')

let db: Database
let store: TaskStore
let service: TaskService
beforeEach(() => {
  db = schemaCopy()
  store = new TaskStore(db, new MailboxStore(db))
  service = new TaskService(store, { getSession: () => undefined })
})
afterEach(() => db.close())

const publish = (taskId: string, revision: number, extra: Record<string, unknown> = {}) =>
  service.publish(human, taskId, { direction: `v${revision + 1}`, rationale: 'r', baseRevision: revision, requestKey: `k${revision}`, ...extra })

// @covers: team-tasks › Delivered task messages carry the task context › Contract in the header
test('the header of a task whose revision 3 carries a contract shows r3#<hash>, each clause with its id, and the globs', async () => {
  const task = await service.create(human, { title: 'Export', direction: 'v1', contract: contractText('Never twice') })
  await publish(task.id, 1)
  await publish(task.id, 2, { contract: contractText('Never thrice') })
  const hash = contractHash(parseContract(contractText('Never thrice')).contract!)
  const header = formatTaskHeader(buildTaskContext(store, task.id)!)
  const identity = `r3#${hash.slice(0, 12)}`
  expect(header).toContain(`Implementation contract ${identity} (cite clauses as ${identity} › <id>):`)
  for (const line of ['### Acceptance', '- A1: Lists tasks', '- I1: Never thrice', '- `src/server/team/**`', '- `docs/**`', '- V1: check passes', '- X1: The client']) {
    expect(header.split('\n')).toContain(line)
  }
  expect(header).not.toContain('Never twice')
  expect(header).not.toContain('## Implementation contract')
})

// @covers: team-tasks › Delivered task messages carry the task context › No contract in the header
test('the header of a task without a contract shows its text identity and says it has no contract', async () => {
  const task = await service.create(human, { title: 'Export', direction: 'v1', acceptance: 'Downloads' })
  const header = formatTaskHeader(buildTaskContext(store, task.id)!)
  expect(header).toContain(`Contract: none — revision identity r1#${textHash('v1', 'Downloads').slice(0, 12)}; this task has no implementation contract.`)
  expect(header).not.toContain('### Acceptance')
})

test('a context recorded before contracts formats exactly as before', async () => {
  const task = await service.create(human, { title: 'Export', direction: 'v1', contract: contractText('Never twice') })
  const { contract: _contract, ...recorded } = buildTaskContext(store, task.id)!
  expect(formatTaskHeader(recorded, 2)).toBe([`[Task ${task.id}: Export] status open, revision 1`, 'Direction:', 'v1', '[Message]'].join('\n'))
})

// @covers: team-tasks › Task reads show each revision's contract › Revision history shows contracts
test('task_get lists each revision with its contract and identity, labeling one without a contract', async () => {
  const task = await service.create(human, { title: 'Export', direction: 'v1' })
  await publish(task.id, 1, { contract: contractText('Never twice') })
  const detail = await service.get(human, task.id)
  const hash = contractHash(parseContract(contractText('Never twice')).contract!)
  expect(detail.revisions.map(revision => [revision.revision, revision.contractHash, revision.identity])).toEqual([
    [1, null, `r1#${textHash('v1', null).slice(0, 12)}`],
    [2, hash, `r2#${hash.slice(0, 12)}`],
  ])
  expect(detail.revisions[1]!.contract).toEqual(parseContract(contractText('Never twice')).contract!)
  expect(detail.task).toMatchObject({ contractHash: hash, identity: `r2#${hash.slice(0, 12)}` })
})

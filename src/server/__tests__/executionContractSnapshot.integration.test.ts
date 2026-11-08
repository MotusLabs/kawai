// The execution's contract snapshot (implementation-contract D4, table
// E1–E5) through the matrix bench's real executor and dispatch (hazard M1:
// never a hand-built harness): the change's design.md at the baseline commit
// becomes the task's revision 1 contract, and the implement instruction names
// its identity; a missing section, a malformed one, a missing design.md, or a
// failed git read creates the task without a contract, journals why, and
// never stops the change. E5 is injected at the executor's `showFile` seam.
// An edit to design.md on the change branch never changes the contract (I1).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { contractHash } from '../team/contractHash'
import { gitShowFile, type ShowFile } from '../plans/execution/contractSnapshot'
import { parseContract } from '../../shared/implementationContract'
import { commitAll, createMatrixBench, createMatrixWorld, removeMatrixWorld, startedExecution, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'

const CONTRACT = ['## Implementation contract', '### Acceptance', '- A1: Exports a CSV', '### Invariants', '- I1: Never writes twice',
  '### Scope', '- `src/export/**`', '### Verification', '- V1: the export test passes', '### Excluded'].join('\n')
const HASH = contractHash(parseContract(CONTRACT).contract!)
const IDENTITY = `r1#${HASH.slice(0, 12)}`

let matrix: MatrixWorld
let h: MatrixBench
beforeAll(async () => { matrix = await createMatrixWorld('kawai-contract-snapshot-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

/** Write the change's design.md into the main checkout; startedExecution commits it into the base. */
const writeDesign = (change: string, text: string) => {
  fs.mkdirSync(path.join(matrix.world.repo, 'openspec', 'changes', change), { recursive: true })
  fs.writeFileSync(path.join(matrix.world.repo, 'openspec', 'changes', change, 'design.md'), text)
}
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const taskOf = (executionId: string, change: string) => h.tasks.store.get(row(executionId, change).taskId!)!
const journalOf = (executionId: string, change: string) => h.tasks.store.journal(row(executionId, change).taskId!, 50).map(entry => entry.text)
const instructionOf = (executionId: string, change: string) => {
  const [assignment] = h.tasks.store.assignmentsOf(row(executionId, change).taskId!)
  return h.mail.get(assignment!.messageId!)!.body
}
/** Run one tick, recording every `git show` revision the snapshot asks for. */
async function tickRecording(show: ShowFile = gitShowFile): Promise<string[]> {
  const revs: string[] = []
  const executor = h.makeExecutor({ showFile: async (cwd, rev, file) => { revs.push(rev); return show(cwd, rev, file) } })
  try { await h.tick(executor) } finally { executor.close() }
  return revs
}
/** E2–E5 never stop the change: the task exists and its implement instruction went out. */
const dispatched = (executionId: string, change: string) => {
  expect(row(executionId, change).state).not.toBe('stopped')
  expect(h.tasks.store.assignmentsOf(row(executionId, change).taskId!)).toHaveLength(1)
}

// @covers: plan-execution › Kawai creates and dispatches one task per change › The task carries the design's contract
test('E1: a well-formed section at the baseline becomes revision 1\'s contract, read at the baseline commit, and the instruction names r1#<hash>', async () => {
  writeDesign('cs-e1', `# Design\n\n${CONTRACT}\n`)
  const executionId = await startedExecution(h, [{ change: 'cs-e1' }])
  const revs = await tickRecording()
  expect(revs).toEqual([row(executionId, 'cs-e1').baselineCommit!])
  expect(taskOf(executionId, 'cs-e1')).toMatchObject({ revision: 1, contractHash: HASH, identity: IDENTITY })
  expect(instructionOf(executionId, 'cs-e1')).toContain(`Implementation contract: ${IDENTITY} (task_get shows its clauses and scope).`)
  expect(journalOf(executionId, 'cs-e1').filter(text => text.startsWith('Created without'))).toEqual([])
})

// @covers: plan-execution › Kawai creates and dispatches one task per change › A change without a contract section
test('E2: a design.md without the section creates and dispatches the task without a contract and journals the missing section', async () => {
  writeDesign('cs-e2', '# Design\n\nNo contract here.\n')
  const executionId = await startedExecution(h, [{ change: 'cs-e2' }])
  await h.tick()
  const sha7 = row(executionId, 'cs-e2').baselineCommit!.slice(0, 7)
  expect(taskOf(executionId, 'cs-e2')).toMatchObject({ contract: null, contractHash: null })
  expect(journalOf(executionId, 'cs-e2')).toContain(`Created without an implementation contract: no Implementation contract section in openspec/changes/cs-e2/design.md at ${sha7}.`)
  expect(instructionOf(executionId, 'cs-e2')).toContain('Implementation contract: none (revision identity r1#')
  dispatched(executionId, 'cs-e2')
})

test('E3: a section that does not parse journals the first five problems with lines and the count', async () => {
  // Seven duplicate ids under Acceptance, and no Verification heading: eight problems.
  const bullets = Array.from({ length: 8 }, () => '- A1: twice').join('\n')
  writeDesign('cs-e3', CONTRACT.replace('- A1: Exports a CSV', bullets).replace('### Verification\n- V1: the export test passes\n', ''))
  const executionId = await startedExecution(h, [{ change: 'cs-e3' }])
  await h.tick()
  const [note] = journalOf(executionId, 'cs-e3').filter(text => text.startsWith('Created without'))
  expect(note).toContain('does not parse (8 problems: line 1: Missing `### Verification` heading; line 4: Duplicate clause id A1; ')
  expect(note!.match(/line \d+:/g)).toHaveLength(5)
  expect(note).toEndWith('; …).')
  expect(taskOf(executionId, 'cs-e3').contract).toBeNull()
  dispatched(executionId, 'cs-e3')
})

test('E4: no design.md at the baseline journals it as missing', async () => {
  const executionId = await startedExecution(h, [{ change: 'cs-e4' }])
  await h.tick()
  const sha7 = row(executionId, 'cs-e4').baselineCommit!.slice(0, 7)
  expect(journalOf(executionId, 'cs-e4')).toContain(`Created without an implementation contract: openspec/changes/cs-e4/design.md missing at ${sha7}.`)
  expect(taskOf(executionId, 'cs-e4').contract).toBeNull()
  dispatched(executionId, 'cs-e4')
})

test('E5: a failed git read journals the failure and the change still dispatches', async () => {
  writeDesign('cs-e5', CONTRACT)
  const executionId = await startedExecution(h, [{ change: 'cs-e5' }])
  await tickRecording(async () => ({ ok: false, missing: false, error: 'git timed out after 10000 ms' }))
  expect(journalOf(executionId, 'cs-e5').find(text => text.startsWith('Created without'))).toMatch(/reading openspec\/changes\/cs-e5\/design\.md at [0-9a-f]{7} failed \(git timed out after 10000 ms\)\.$/)
  expect(taskOf(executionId, 'cs-e5').contract).toBeNull()
  dispatched(executionId, 'cs-e5')
})

// @covers: plan-execution › Artifact edits never change an execution task's contract › Design edited on the change branch
test('an edit to the contract section committed on the change branch leaves the task\'s contract and identity unchanged', async () => {
  writeDesign('cs-i1', CONTRACT)
  const executionId = await startedExecution(h, [{ change: 'cs-i1' }])
  await h.tick()
  const worktree = row(executionId, 'cs-i1').worktree!
  fs.writeFileSync(path.join(worktree, 'openspec', 'changes', 'cs-i1', 'design.md'), CONTRACT.replace('Never writes twice', 'Writes as often as it likes'))
  commitAll(worktree, 'loosen the contract')
  await h.tick()
  expect(taskOf(executionId, 'cs-i1')).toMatchObject({ revision: 1, contractHash: HASH, identity: IDENTITY })
})

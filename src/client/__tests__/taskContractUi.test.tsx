// The contract in the task UI (implementation-contract 3.1, D7): the revision
// history shows each revision's identity and contract or "No contract"; the
// draft editor starts from the saved draft's raw text (a draft that does not
// parse comes back with its problems), live problems disable publishing,
// clearing a carried contract is refused before it is sent, and a fixed
// contract publishes with the text. The create form's optional contract
// field shows live problems and keeps a malformed contract from being sent.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { HumanTaskDetail, TeamTaskSummary } from '@shared/teamTasks'
import { parseContract, renderContract } from '@shared/implementationContract'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import TeamTasksPanel from '../components/team/TeamTasksView'
import { useTeamTaskStore } from '../stores/teamTaskStore'

afterEach(() => { useTeamTaskStore.setState({ views: {} }) })

const TEXT = ['## Implementation contract', '### Acceptance', '- A1: Lists tasks', '### Invariants', '- I1: Never twice',
  '### Scope', '- `src/server/team/**`', '### Verification', '- V1: check passes', '### Excluded', '- X1: The client'].join('\n')
const CONTRACT = parseContract(TEXT).contract!
/** Two clauses with id I2: one problem, on line 6 (the second). */
const BAD = TEXT.replace('- I1: Never twice', '- I2: Never twice\n- I2: Again')
const R1 = 'r1#aaaaaaaaaaaa'
const R2 = 'r2#bbbbbbbbbbbb'

const task = (extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: null, openspecChange: null, revision: 2, direction: 'CSV export', acceptance: null, createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z', participants: [], assignment: null, contract: CONTRACT, contractHash: 'b'.repeat(64), identity: R2, ...extra,
})
const author = { kind: 'human' as const, sessionId: null }
const detail = (summary: TeamTaskSummary, extra: Partial<HumanTaskDetail> = {}): HumanTaskDetail => ({
  task: summary, journal: [], subtasks: [], assignments: [], messages: [],
  revisions: [
    { revision: 1, direction: 'CSV', acceptance: null, author, createdAt: '2026-10-14T00:00:00.000Z', rationale: null, notify: null, contract: null, contractHash: null, identity: R1 },
    { revision: 2, direction: summary.direction, acceptance: null, author, createdAt: '2026-10-14T01:00:00.000Z', rationale: 'Contract added', notify: false,
      contract: summary.contract ?? null, contractHash: summary.contractHash ?? null, identity: summary.identity! },
  ],
  draft: null, acknowledgements: [],
  publications: [{ revision: 2, previousRevision: 1, author, publishedAt: '2026-10-14T01:00:00.000Z', rationale: 'Contract added', notify: false, recipients: [] }],
  ...extra,
})

let sent: ClientMessage[]
let renderer: TestRenderer.ReactTestRenderer
function mount(view: HumanTaskDetail) {
  sent = []
  useTeamTaskStore.getState().open('dev', 't1')
  useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view, directory: [] })
  act(() => {
    renderer = TestRenderer.create(<TeamTaskDetail teamPath="dev" projectPath="/repo" view={useTeamTaskStore.getState().views.dev!}
      sendMessage={message => sent.push(message)} connected sessions={[]} />)
  })
  act(() => { renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props.onClick() })
}
const textOf = (node: TestRenderer.ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
const testIds = (id: string) => renderer.root.findAllByProps({ 'data-testid': id }).filter(node => typeof node.type === 'string')
const publishButton = () => renderer.root.findByProps({ 'data-testid': 'task-publish' })
const type = (label: string, value: string) => act(() => field(label).props.onChange({ target: { value } }))
const publishes = () => sent.filter((message): message is Extract<ClientMessage, { type: 'team-task-publish' }> => message.type === 'team-task-publish')

// @covers: team-tasks › Task reads show each revision's contract › Revision history shows contracts
test('the revision history labels revision 1 as having no contract and shows revision 2\'s identity, clauses, and scope', () => {
  mount(detail(task()))
  const [first, second] = testIds('revision-contract')
  expect(first!.props['data-contract']).toBe('none')
  expect(textOf(first!)).toBe(`No contract · ${R1}`)
  expect(second!.props['data-contract']).toBe('present')
  const shown = textOf(second!)
  for (const part of [R2, 'A1: Lists tasks', 'I1: Never twice', 'src/server/team/**', 'V1: check passes', 'X1: The client']) expect(shown).toContain(part)
  // The current contract and each publication name the identity too.
  expect(textOf(testIds('task-current-contract')[0]!)).toContain(R2)
  expect(textOf(testIds('publication-identity')[0]!)).toBe(R2)
})

// @covers: task-revision-publication › A draft never publishes › Draft contract survives restart unparsed
test('a saved draft whose contract does not parse comes back with its text and the parser\'s problems, and cannot publish', () => {
  mount(detail(task(), { draft: { taskId: 't1', baseRevision: 2, direction: 'CSV export v2', acceptance: null, rationale: 'Why', contractText: BAD, updatedAt: 'now' } }))
  expect(field('Draft implementation contract').props.value).toBe(BAD)
  expect(textOf(testIds('task-contract-problems')[0]!)).toContain('Line 6: Duplicate clause id I2')
  expect(publishButton().props.disabled).toBe(true)
  // Fixing the text clears the problems and enables Publish, which sends the contract.
  type('Draft implementation contract', TEXT.replace('- I1: Never twice', '- I1: Never twice\n- I2: Again'))
  expect(testIds('task-contract-problems')).toHaveLength(0)
  expect(publishButton().props.disabled).toBe(false)
  act(() => publishButton().props.onClick())
  expect(publishes()[0]).toMatchObject({ fromDraft: true, contract: TEXT.replace('- I1: Never twice', '- I1: Never twice\n- I2: Again') })
})

test('the editor starts from the revision\'s rendered contract; a contract-only edit publishes, a malformed one does not', () => {
  mount(detail(task()))
  expect(field('Draft implementation contract').props.value).toBe(renderContract(CONTRACT))
  type('Rationale', 'Tighten')
  // Unchanged: nothing to publish.
  expect(publishButton().props.disabled).toBe(true)
  type('Draft implementation contract', BAD)
  expect(publishButton().props.disabled).toBe(true)
  type('Draft implementation contract', TEXT.replace('Never twice', 'Never thrice'))
  expect(publishButton().props.disabled).toBe(false)
  act(() => publishButton().props.onClick())
  expect(publishes()).toMatchObject([{ direction: 'CSV export', contract: TEXT.replace('Never twice', 'Never thrice') }])
})

test('clearing a contract the task carries is refused in the form before anything is sent', () => {
  mount(detail(task()))
  type('Rationale', 'Drop it')
  type('Draft direction', 'CSV export v2')
  type('Draft implementation contract', '')
  expect(textOf(testIds('task-contract-clear-refused')[0]!)).toContain('can be replaced but not removed')
  expect(publishButton().props.disabled).toBe(true)
})

test('a task without a contract publishes a direction edit without a contract and shows "No contract"', () => {
  mount(detail(task({ contract: null, contractHash: null, identity: 'r2#cccccccccccc' })))
  expect(field('Draft implementation contract').props.value).toBe('')
  expect(textOf(testIds('task-current-contract')[0]!)).toBe('No contract · r2#cccccccccccc')
  type('Draft direction', 'CSV export v2')
  type('Rationale', 'Wider')
  expect(testIds('task-contract-clear-refused')).toHaveLength(0)
  act(() => publishButton().props.onClick())
  expect(publishes()).toMatchObject([{ direction: 'CSV export v2' }])
  expect(publishes()[0]).not.toHaveProperty('contract')
})

// @covers: team-tasks › A task revision may carry a contract › Task without a contract
test('the create form sends a valid contract, none when blank, and never a malformed one', () => {
  sent = []
  useTeamTaskStore.getState().open('dev')
  const render = () => <TeamTasksPanel teamPath="dev" projectPath="/repo" view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [] }}
    sendMessage={message => sent.push(message)} connected />
  act(() => { renderer = TestRenderer.create(render()) })
  const setField = (label: string, value: string) => {
    act(() => field(label).props.onChange({ target: { value } }))
    act(() => renderer.update(render()))
  }
  const submit = () => act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  const creates = () => sent.filter((message): message is Extract<ClientMessage, { type: 'team-task-create' }> => message.type === 'team-task-create')
  setField('Task title', 'Export')
  setField('Task direction', 'CSV')
  setField('Implementation contract', BAD)
  expect(textOf(testIds('task-create-contract-problems')[0]!)).toContain('Line 6: Duplicate clause id I2')
  expect(renderer.root.findByProps({ 'data-testid': 'task-create-button' }).props.disabled).toBe(true)
  submit()
  expect(creates()).toHaveLength(0)
  setField('Implementation contract', TEXT)
  expect(testIds('task-create-contract-problems')).toHaveLength(0)
  submit()
  expect(creates()).toMatchObject([{ title: 'Export', direction: 'CSV', contract: TEXT }])
  // A blank field sends no contract: the task has none.
  act(() => useTeamTaskStore.setState({ views: {} }))
  sent = []
  useTeamTaskStore.getState().open('dev')
  act(() => renderer.update(render()))
  setField('Task title', 'Plain')
  setField('Task direction', 'CSV')
  submit()
  expect(creates()).toHaveLength(1)
  expect(creates()[0]).not.toHaveProperty('contract')
})

// The bounded task sections through both registered tool runtimes
// (bounded-task-reads H2, H8): the Claude team MCP server and the Codex
// dynamic-tool dispatch, built from teamToolTable over real services, with
// the blind-first seal applied in the read transaction. Ground truth is the
// stored rows and the stores' own derivations.
import { describe, expect, test } from 'bun:test'
import { agent, useTaskToolHarness } from './taskToolHarness'
import { at } from './taskJournalFixture'

const h = useTaskToolHarness('kawai-read-tools-')
const newTask = async () => h.tasks.create(agent('lead'), { title: 'Export', direction: 'CSV' })
const child = (parentId: string, seconds: number) =>
  h.tasks.store.create({ teamId: h.team.teamId, title: `child ${seconds}`, direction: 'd'.repeat(2000), creator: { kind: 'agent', sessionId: 'lead' }, parentId }, at(seconds))

for (const { runtime, call } of h.runtimes) {
  describe(`task_get sections through the ${runtime} adapter`, () => {
    // @covers: team-tasks › task_get subtasks are compact rows › Foreign subtask anchor
    test(`G1, G2 (${runtime}): subtasks are task_list rows with a next anchor, and a foreign or unknown subtask anchor is refused naming it`, async () => {
      const task = await newTask()
      const other = await newTask()
      const children = Array.from({ length: 103 }, (_, i) => child(task.id, i).id)
      const foreign = child(other.id, 200).id
      const { error, value } = await call('dev', 'task_get', { task_id: task.id })
      expect(error).toBeNull()
      expect(value.subtasks.map((row: { id: string }) => row.id)).toEqual(children.slice(-100))
      expect(value.subtasks.every((row: Record<string, unknown>) => !('direction' in row) && !('participants' in row) && !('acceptance' in row))).toBe(true)
      const listed = (await call('dev', 'task_list', { status: 'all', limit: 200 })).value.tasks
      expect(value.subtasks[0]).toEqual(listed.find((row: { id: string }) => row.id === children[3]))
      expect(value.bounds.subtasks).toEqual({ total: 103, returned: 100, truncated: true, nextBefore: children[3] })
      for (const anchor of [foreign, 'task-unknown', other.id]) {
        const refused = await call('dev', 'task_get', { task_id: task.id, subtasks_before: anchor })
        expect(refused.value).toBeNull()
        expect(refused.error).toContain(`Unknown subtask of this task: ${anchor}`)
      }
    })
  })
}

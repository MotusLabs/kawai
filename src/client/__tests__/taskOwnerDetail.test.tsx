// The task detail names the owner beside the creator once they differ
// (group-mail-task-affinity D7, task 2.4); an untransferred or ownerless task
// shows the creator alone.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import type { TeamTaskSummary } from '@shared/teamTasks'
import TeamTasksPanel from '../components/team/TeamTasksView'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'

afterEach(() => {
  useTeamTaskStore.setState({ views: {} })
  useTeamWorkspaceStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [] })
})

const summary = (extra: Partial<TeamTaskSummary>): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Task', status: 'open', creator: { kind: 'agent', sessionId: 'lead-a' }, parentId: null,
  worktree: null, openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z', participants: ['lead-a'], assignment: null, ...extra,
})
const session = (id: string, name: string) => ({ id, name, projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', kind: 'chat' } as Session)

function render(task: TeamTaskSummary) {
  useSessionStore.setState({ sessions: [session('lead-a', 'Lead A'), session('lead-b', 'Lead B')] })
  useTeamTaskStore.getState().open('dev')
  const view: TaskView = {
    ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [task], selectedTaskId: task.id,
    detail: { task, revisions: [], journal: [], subtasks: [], assignments: [], messages: [] },
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view} sendMessage={() => {}} connected />) })
  return renderer
}

test('a moved task shows "owned by" its new owner beside the creator', () => {
  const renderer = render(summary({ ownerSession: 'lead-b' }))
  expect(renderer.root.findByProps({ 'data-testid': 'task-creator' }).children.join('')).toBe('Lead A')
  expect(renderer.root.findByProps({ 'data-testid': 'task-owner' }).children.join('')).toBe('Lead B')
  act(() => renderer.unmount())
})

test('an untransferred or ownerless task shows no owner', () => {
  for (const ownerSession of ['lead-a', null, undefined]) {
    const renderer = render(summary(ownerSession === undefined ? {} : { ownerSession }))
    expect(renderer.root.findAllByProps({ 'data-testid': 'task-owner' })).toEqual([])
    act(() => renderer.unmount())
  }
})

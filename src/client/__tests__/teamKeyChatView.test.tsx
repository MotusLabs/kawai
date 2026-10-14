// Team views follow workspace discovery (team-workspace-pages D2): a view
// keyed by an undiscovered worktree path moves to the repository's main
// checkout when discovery reports it — whether or not anything is mounted —
// and never into a different team when a chat's directory moves elsewhere.
// The Team page, the views' only host (D4), re-subscribes under the new key.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, Session } from '@shared/types'
import type { WorkspaceRepository, WorkspaceSnapshot } from '@shared/workspace'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { startTeamViewMigration } from '../stores/teamViewMigration'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { clearTeamKeyAliases } from '../utils/teamKeyAliases'
import { resetTeamLocationForTests } from '../hooks/useTeamLocation'

let stop: () => void
beforeEach(() => { stop = startTeamViewMigration() })
afterEach(() => {
  stop()
  act(() => {
    useTeamTaskStore.setState({ views: {} })
    useWorkspaceStore.setState({ snapshot: null })
    useSessionStore.setState({ sessions: [], selectedSessionId: null, selectedHibernatingSessionId: null })
  })
  clearTeamKeyAliases()
  resetTeamLocationForTests()
})

const chat = (projectPath: string) => ({
  id: 'chat-1', name: 'Chat', projectPath, status: 'waiting', kind: 'chat',
} as unknown as Session)

const repository = (main: string, ...linked: string[]) => ({
  id: `${main}/.git`, name: main, commonDir: `${main}/.git`, branches: [], stale: false,
  worktrees: [main, ...linked].map((path, index) => ({
    id: path, repositoryId: `${main}/.git`, path, headRevision: 'a', detached: false, isMain: index === 0, dirty: false,
  })),
} as unknown as WorkspaceRepository)

const discover = (...repositories: WorkspaceRepository[]) => act(() => {
  useWorkspaceStore.setState({ snapshot: { repositories, generatedAt: 'now' } as WorkspaceSnapshot })
})

const mountPage = (teamKey: string, sent: ClientMessage[]) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamWorkspaceView
      teamKey={teamKey} location={{ teamKey, tab: 'tasks' }}
      sendMessage={message => sent.push(message)} connected connectionEpoch={0} />)
  })
  return renderer
}

const subscriptions = (sent: ClientMessage[]) => sent.filter(message => message.type === 'team-tasks-open' || message.type === 'team-tasks-close')

test('an open Tasks view follows its team when discovery maps the worktree to the main checkout', () => {
  const sent: ClientMessage[] = []
  act(() => { useSessionStore.setState({ sessions: [chat('/repo/.worktrees/feature')], hasLoaded: true }) })
  const renderer = mountPage('/repo/.worktrees/feature', sent)
  expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(1)

  discover(repository('/repo', '/repo/.worktrees/feature'))

  expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(0)
  expect(useTeamTaskStore.getState().views['/repo']?.open).toBe(true)
  expect(useTeamTaskStore.getState().views['/repo/.worktrees/feature']).toBeUndefined()
  expect(subscriptions(sent)).toEqual([
    { type: 'team-tasks-open', teamPath: '/repo/.worktrees/feature' },
    { type: 'team-tasks-close', teamPath: '/repo/.worktrees/feature' },
  ])
  act(() => renderer.unmount())
})

test('a re-discovered team re-opens on the Team page under its main-checkout key', () => {
  // Opened under the worktree key, then discovery lands: the view (and its
  // draft) move, and a Team page mounted afterwards works from the new key.
  act(() => {
    useTeamTaskStore.getState().open('/repo/.worktrees/feature')
    useTeamTaskStore.getState().setDraft('/repo/.worktrees/feature', { title: 'Half-typed task' })
  })
  discover(repository('/repo', '/repo/.worktrees/feature'))
  expect(useTeamTaskStore.getState().views['/repo/.worktrees/feature']).toBeUndefined()

  const sent: ClientMessage[] = []
  act(() => { useSessionStore.setState({ sessions: [chat('/repo/.worktrees/feature')], hasLoaded: true }) })
  const renderer = mountPage('/repo', sent)
  expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(1)
  expect(useTeamTaskStore.getState().views['/repo']!.draft.title).toBe('Half-typed task')
  expect(subscriptions(sent)).toEqual([{ type: 'team-tasks-open', teamPath: '/repo' }])
  act(() => renderer.unmount())
})

test('a chat whose directory moves to another repository leaves the old team’s view where it is', () => {
  discover(repository('/alpha'), repository('/beta'))
  act(() => {
    useTeamTaskStore.getState().open('/alpha', 'task-a')
    useTeamTaskStore.getState().setDraft('/alpha', { title: 'Alpha draft' })
  })
  expect(useTeamTaskStore.getState().views['/alpha']).toMatchObject({ open: true, selectedTaskId: 'task-a', draft: { title: 'Alpha draft' } })
  expect(useTeamTaskStore.getState().views['/beta']).toBeUndefined()
})

test('keys outside every discovered repository, and keys already at the main checkout, stay put', () => {
  act(() => {
    useTeamTaskStore.getState().open('/tmp/notes')
    useTeamTaskStore.getState().open('/repo')
  })
  discover(repository('/repo', '/repo/.worktrees/feature'))
  expect(Object.keys(useTeamTaskStore.getState().views).sort()).toEqual(['/repo', '/tmp/notes'])
})

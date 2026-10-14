// Team views follow workspace discovery (team-workspace-pages D2): a view
// keyed by an undiscovered worktree path moves to the repository's main
// checkout when discovery reports it — whether or not its chat is on screen —
// and never into a different team when a chat's directory moves elsewhere.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, Session } from '@shared/types'
import type { WorkspaceRepository, WorkspaceSnapshot } from '@shared/workspace'
import ChatView from '../components/chat/ChatView'
import { useChatStore } from '../stores/chatStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { startTeamViewMigration } from '../stores/teamViewMigration'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { clearTeamKeyAliases } from '../utils/teamKeyAliases'

let stop: () => void
beforeEach(() => { stop = startTeamViewMigration() })
afterEach(() => {
  stop()
  act(() => {
    useTeamTaskStore.setState({ views: {} })
    useWorkspaceStore.setState({ snapshot: null })
    useChatStore.setState({ sessions: {} })
  })
  clearTeamKeyAliases()
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

const mount = (session: Session, sent: ClientMessage[]) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView
      session={session} sendMessage={message => sent.push(message)}
      connectionStatus="connected" connectionEpoch={0} error={null}
      onClose={() => {}} onKill={() => {}} />)
  })
  return renderer
}
const tasksPanels = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })
const subscriptions = (sent: ClientMessage[]) => sent.filter(message => message.type === 'team-tasks-open' || message.type === 'team-tasks-close')

test('an open Tasks panel follows its chat when discovery maps the worktree to the main checkout', () => {
  const sent: ClientMessage[] = []
  const renderer = mount(chat('/repo/.worktrees/feature'), sent)
  act(() => { useTeamTaskStore.getState().open('/repo/.worktrees/feature') })
  expect(tasksPanels(renderer)).toHaveLength(1)

  discover(repository('/repo', '/repo/.worktrees/feature'))

  expect(tasksPanels(renderer)).toHaveLength(1)
  expect(useTeamTaskStore.getState().views['/repo']?.open).toBe(true)
  expect(useTeamTaskStore.getState().views['/repo/.worktrees/feature']).toBeUndefined()
  expect(subscriptions(sent)).toEqual([
    { type: 'team-tasks-open', teamPath: '/repo/.worktrees/feature' },
    { type: 'team-tasks-close', teamPath: '/repo/.worktrees/feature' },
    { type: 'team-tasks-open', teamPath: '/repo' },
  ])
  act(() => renderer.unmount())
})

test('a chat that is not on screen finds its panel and draft after discovery lands', () => {
  // Opened while the chat was selected, then the user switched away.
  act(() => {
    useTeamTaskStore.getState().open('/repo/.worktrees/feature')
    useTeamTaskStore.getState().setDraft('/repo/.worktrees/feature', { title: 'Half-typed task' })
  })
  discover(repository('/repo', '/repo/.worktrees/feature'))
  expect(useTeamTaskStore.getState().views['/repo/.worktrees/feature']).toBeUndefined()

  const sent: ClientMessage[] = []
  const renderer = mount(chat('/repo/.worktrees/feature'), sent)
  expect(tasksPanels(renderer)).toHaveLength(1)
  expect(useTeamTaskStore.getState().views['/repo']!.draft.title).toBe('Half-typed task')
  expect(subscriptions(sent)).toEqual([{ type: 'team-tasks-open', teamPath: '/repo' }])
  act(() => renderer.unmount())
})

test('a chat whose directory moves to another repository leaves the old team’s view where it is', () => {
  discover(repository('/alpha'), repository('/beta'))
  const sent: ClientMessage[] = []
  const renderer = mount(chat('/alpha'), sent)
  act(() => {
    useTeamTaskStore.getState().open('/alpha', 'task-a')
    useTeamTaskStore.getState().setDraft('/alpha', { title: 'Alpha draft' })
  })
  act(() => renderer.update(<ChatView
    session={chat('/beta')} sendMessage={message => sent.push(message)}
    connectionStatus="connected" connectionEpoch={0} error={null}
    onClose={() => {}} onKill={() => {}} />))

  // Beta has no open view of its own, so nothing shows; alpha's view is untouched.
  expect(tasksPanels(renderer)).toHaveLength(0)
  const views = useTeamTaskStore.getState().views
  expect(views['/beta']).toBeUndefined()
  expect(views['/alpha']).toMatchObject({ open: true, selectedTaskId: 'task-a', draft: { title: 'Alpha draft' } })
  act(() => renderer.unmount())
})

test('keys outside every discovered repository, and keys already at the main checkout, stay put', () => {
  act(() => {
    useTeamTaskStore.getState().open('/tmp/notes')
    useTeamTaskStore.getState().open('/repo')
  })
  discover(repository('/repo', '/repo/.worktrees/feature'))
  expect(Object.keys(useTeamTaskStore.getState().views).sort()).toEqual(['/repo', '/tmp/notes'])
})

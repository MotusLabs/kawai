// A chat's team key moves once workspace discovery places it in a repository
// (team-workspace-pages D2): an open team panel follows the chat to the new
// key — its view moves and its subscription re-opens under the new path —
// instead of reading as closed and leaving the old view orphaned.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, Session } from '@shared/types'
import type { WorkspaceRepository, WorkspaceSnapshot } from '@shared/workspace'
import ChatView from '../components/chat/ChatView'
import { useChatStore } from '../stores/chatStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { useWorkspaceStore } from '../stores/workspaceStore'

afterEach(() => {
  act(() => {
    useTeamTaskStore.setState({ views: {} })
    useWorkspaceStore.setState({ snapshot: null })
    useChatStore.setState({ sessions: {} })
  })
})

const session = {
  id: 'chat-1', name: 'Chat', projectPath: '/repo/.worktrees/feature', status: 'waiting', kind: 'chat',
} as unknown as Session

const repository = {
  id: '/repo/.git', name: 'repo', commonDir: '/repo/.git', branches: [], stale: false,
  worktrees: [
    { id: 'main', repositoryId: '/repo/.git', path: '/repo', headRevision: 'a', detached: false, isMain: true, dirty: false },
    { id: 'feature', repositoryId: '/repo/.git', path: '/repo/.worktrees/feature', headRevision: 'b', detached: false, isMain: false, dirty: false },
  ],
} as unknown as WorkspaceRepository

test('an open Tasks panel follows the chat when discovery moves its key to the main checkout', () => {
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView
      session={session} sendMessage={message => sent.push(message)}
      connectionStatus="connected" connectionEpoch={0} error={null}
      onClose={() => {}} onKill={() => {}} />)
  })
  // Before discovery the chat keys by its own directory.
  act(() => { useTeamTaskStore.getState().open('/repo/.worktrees/feature') })
  expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(1)
  expect(sent.filter(message => message.type === 'team-tasks-open')).toEqual([
    { type: 'team-tasks-open', teamPath: '/repo/.worktrees/feature' },
  ])

  act(() => { useWorkspaceStore.setState({ snapshot: { repositories: [repository], generatedAt: 'now' } as WorkspaceSnapshot }) })

  // Still open, now under the repository's key, and re-subscribed there.
  expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(1)
  const views = useTeamTaskStore.getState().views
  expect(views['/repo']?.open).toBe(true)
  expect(views['/repo/.worktrees/feature']).toBeUndefined()
  expect(sent.filter(message => message.type === 'team-tasks-open' || message.type === 'team-tasks-close')).toEqual([
    { type: 'team-tasks-open', teamPath: '/repo/.worktrees/feature' },
    { type: 'team-tasks-close', teamPath: '/repo/.worktrees/feature' },
    { type: 'team-tasks-open', teamPath: '/repo' },
  ])
  act(() => renderer.unmount())
})

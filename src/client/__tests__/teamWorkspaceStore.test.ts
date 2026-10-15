// Per-team Team page view state (team-workspace-pages D8): each tab's
// search, filters, expansion, and collapsed sections survive tab switches,
// chat visits, and reconnects, are never shared between teams, and stay out
// of the URL and the wire.
import { afterEach, expect, test } from 'bun:test'
import { closedWorkspaceView, emptyTabViewState, useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'

afterEach(() => {
  useTeamWorkspaceStore.setState({ views: {} })
})

test('view state survives tab switches within a team', () => {
  const store = useTeamWorkspaceStore.getState()
  store.open('/repo')
  store.setSearch('/repo', 'mailbox', 'strategy-ui')
  store.setFilters('/repo', 'mailbox', { hideEmpty: true, state: 'queued' })
  store.toggleExpanded('/repo', 'mailbox', 'm-1')
  store.toggleSectionCollapsed('/repo', 'mailbox', 'Receiving')
  store.setTab('/repo', 'tasks')
  store.setTab('/repo', 'mailbox')
  const view = useTeamWorkspaceStore.getState().views['/repo']!
  expect(view.tabs.mailbox).toEqual({
    ...emptyTabViewState(),
    search: 'strategy-ui',
    filters: { hideEmpty: true, state: 'queued' },
    expanded: ['m-1'],
    collapsedSections: ['Receiving'],
  })
  // Other tabs keep their own, untouched state.
  expect(view.tabs.tasks).toEqual(emptyTabViewState())
})

test('a chat visit keeps state: close marks closed and reopen keeps everything', () => {
  const store = useTeamWorkspaceStore.getState()
  store.open('/repo')
  store.setTab('/repo', 'mailbox')
  store.setSearch('/repo', 'mailbox', 'held')
  store.setExpanded('/repo', 'mailbox', ['m-1', 'm-2'])
  store.close('/repo')
  expect(useTeamWorkspaceStore.getState().views['/repo']?.open).toBe(false)
  useTeamWorkspaceStore.getState().open('/repo')
  const view = useTeamWorkspaceStore.getState().views['/repo']!
  expect(view.open).toBe(true)
  expect(view.tab).toBe('mailbox')
  expect(view.tabs.mailbox.search).toBe('held')
  expect(view.tabs.mailbox.expanded).toEqual(['m-1', 'm-2'])
})

test('reconnect changes nothing: state set before a re-open persists', () => {
  useTeamWorkspaceStore.getState().open('/repo')
  useTeamWorkspaceStore.getState().toggleSectionCollapsed('/repo', 'tasks', 'Revision history')
  // A reconnect re-opens the view; nothing resets the per-tab state.
  useTeamWorkspaceStore.getState().open('/repo')
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tabs.tasks.collapsedSections).toEqual(['Revision history'])
})

test('two teams never share view state', () => {
  const store = useTeamWorkspaceStore.getState()
  store.open('/a')
  store.open('/b')
  store.setSearch('/a', 'tasks', 'usage bar')
  store.setTab('/a', 'tasks')
  expect(useTeamWorkspaceStore.getState().views['/b']?.tabs.tasks.search).toBe('')
  expect(useTeamWorkspaceStore.getState().views['/b']?.tab).toBe(closedWorkspaceView().tab)
})

test('a collapsed detail section stays collapsed across selections and tasks', () => {
  const store = useTeamWorkspaceStore.getState()
  store.open('/repo')
  store.toggleSectionCollapsed('/repo', 'tasks', 'Revision history')
  // Opening another task keeps the section state: sections key by name (D8).
  store.toggleExpanded('/repo', 'tasks', 'task-2')
  const tab = useTeamWorkspaceStore.getState().views['/repo']!.tabs.tasks
  expect(tab.collapsedSections).toEqual(['Revision history'])
  store.toggleSectionCollapsed('/repo', 'tasks', 'Revision history')
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tabs.tasks.collapsedSections).toEqual([])
})

test('setExpanded replaces the list for expand-all and collapse-all', () => {
  useTeamWorkspaceStore.getState().open('/repo')
  useTeamWorkspaceStore.getState().toggleExpanded('/repo', 'messages', 't-1')
  useTeamWorkspaceStore.getState().setExpanded('/repo', 'messages', ['t-1', 't-2', 't-3'])
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tabs.messages.expanded).toEqual(['t-1', 't-2', 't-3'])
  useTeamWorkspaceStore.getState().setExpanded('/repo', 'messages', [])
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tabs.messages.expanded).toEqual([])
})

test('rekey moves the view with its team and an existing target wins', () => {
  useTeamWorkspaceStore.getState().open('/worktree-path')
  useTeamWorkspaceStore.getState().setSearch('/worktree-path', 'tasks', 'find me')
  useTeamWorkspaceStore.getState().rekey('/worktree-path', '/main')
  expect(useTeamWorkspaceStore.getState().views['/worktree-path']).toBeUndefined()
  expect(useTeamWorkspaceStore.getState().views['/main']?.tabs.tasks.search).toBe('find me')
  useTeamWorkspaceStore.getState().open('/main')
  useTeamWorkspaceStore.getState().rekey('/gone', '/main')
  expect(useTeamWorkspaceStore.getState().views['/main']?.tabs.tasks.search).toBe('find me')
})

test('notice set and clear', () => {
  useTeamWorkspaceStore.getState().open('/repo')
  useTeamWorkspaceStore.getState().setNotice('/repo', 'Task not found')
  expect(useTeamWorkspaceStore.getState().views['/repo']?.notice).toBe('Task not found')
  useTeamWorkspaceStore.getState().setNotice('/repo', null)
  expect(useTeamWorkspaceStore.getState().views['/repo']?.notice).toBeNull()
})

// The Team page's URL location (team-workspace-pages D3): the hash grammar
// `#/team/<key>/<tab>[/<sub>][/<id>]`, its pure parse/format round trip, and
// the location store's navigate/leave history writes.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  DEFAULT_WORKSPACE_TAB,
  parseTeamHash,
  teamHashOf,
} from '../utils/teamLocation'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'

const globalAny = globalThis as typeof globalThis & { window?: Window & typeof globalThis }
const originalWindow = globalAny.window

const pushed: string[] = []
let replaced: string[] = []

beforeEach(() => {
  pushed.length = 0
  replaced = []
  globalAny.window = {
    location: {
      hash: '',
      pathname: '/app',
      search: '?x=1',
    },
    history: {
      pushState: (_state: unknown, _title: string, url: string | URL) => { pushed.push(String(url)) },
      replaceState: (_state: unknown, _title: string, url: string | URL) => { replaced.push(String(url)) },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis
})

afterEach(() => {
  globalAny.window = originalWindow
  resetTeamLocationForTests()
})

test('format and parse round-trip a task location', () => {
  const hashString = teamHashOf({ teamKey: '/home/coder/kawai', tab: 'tasks', id: 'task-12' })
  expect(hashString).toBe('#/team/%2Fhome%2Fcoder%2Fkawai/tasks/task-12')
  expect(parseTeamHash(hashString)).toEqual({ teamKey: '/home/coder/kawai', tab: 'tasks', id: 'task-12' })
})

test('a strategy review location carries sub and revision id', () => {
  const hashString = teamHashOf({ teamKey: '/repo', tab: 'strategy', sub: 'review', id: '3' })
  expect(hashString).toBe('#/team/%2Frepo/strategy/review/3')
  expect(parseTeamHash(hashString)).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'review', id: '3' })
})

test('an impact review location carries the impact sub-view and the review\'s strategy revision (strategy-revision-impact D9)', () => {
  const hashString = teamHashOf({ teamKey: '/repo', tab: 'strategy', sub: 'impact', id: '2' })
  expect(hashString).toBe('#/team/%2Frepo/strategy/impact/2')
  expect(parseTeamHash(hashString)).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'impact', id: '2' })
  expect(parseTeamHash('#/team/%2Frepo/strategy/impact')).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'impact' })
})

test('a bare key opens the default tab and other hash content is not a team route', () => {
  expect(parseTeamHash('#/team/%2Frepo')).toEqual({ teamKey: '/repo', tab: DEFAULT_WORKSPACE_TAB })
  expect(parseTeamHash('#/team/')).toBeNull()
  expect(parseTeamHash('#/other/route')).toBeNull()
  expect(parseTeamHash('')).toBeNull()
})

test('an unknown tab reads as the default tab, never an error', () => {
  expect(parseTeamHash('#/team/%2Frepo/bogus/t-1')).toEqual({ teamKey: '/repo', tab: DEFAULT_WORKSPACE_TAB, id: 't-1' })
})

test('a non-strategy tab keeps its id in the third segment', () => {
  expect(parseTeamHash('#/team/%2Frepo/messages/thread-9')).toEqual({ teamKey: '/repo', tab: 'messages', id: 'thread-9' })
  // A strategy sub-view word under a non-strategy tab is an id, not a sub.
  expect(parseTeamHash('#/team/%2Frepo/tasks/history')).toEqual({ teamKey: '/repo', tab: 'tasks', id: 'history' })
})

test('navigate pushes a history entry and records the location', () => {
  const store = useTeamLocationStore.getState()
  store.navigate({ teamKey: '/repo', tab: 'mailbox' })
  expect(pushed).toEqual(['#/team/%2Frepo/mailbox'])
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'mailbox' })
})

test('navigate with replace swaps the current entry instead of pushing', () => {
  useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks' })
  useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks', id: 't-1' }, { replace: true })
  expect(pushed).toHaveLength(1)
  expect(replaced).toEqual(['#/team/%2Frepo/tasks/t-1'])
  expect(useTeamLocationStore.getState().location?.id).toBe('t-1')
})

test('leave pushes the hashless URL once and is a no-op off the page', () => {
  useTeamLocationStore.getState().leave()
  expect(pushed).toEqual([])
  useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks' })
  useTeamLocationStore.getState().leave()
  expect(pushed.at(-1)).toBe('/app?x=1')
  expect(useTeamLocationStore.getState().location).toBeNull()
  useTeamLocationStore.getState().leave()
  expect(pushed).toHaveLength(2)
})

test('a malformed key escape is no route, never an error', () => {
  expect(parseTeamHash('#/team/%E0')).toBeNull()
  expect(parseTeamHash('#/team/%E0/tasks')).toBeNull()
  expect(parseTeamHash('#/team/%2Frepo/tasks/%E0')).toEqual({ teamKey: '/repo', tab: 'tasks' })
})

test('navigating to the location already shown pushes no history entry', () => {
  const store = useTeamLocationStore.getState()
  store.navigate({ teamKey: '/repo', tab: 'mailbox' })
  store.navigate({ teamKey: '/repo', tab: 'mailbox' })
  store.navigate({ teamKey: '/repo', tab: 'mailbox' })
  expect(pushed).toEqual(['#/team/%2Frepo/mailbox'])
  // A different location still pushes.
  store.navigate({ teamKey: '/repo', tab: 'mailbox', id: 'm-1' })
  expect(pushed).toEqual(['#/team/%2Frepo/mailbox', '#/team/%2Frepo/mailbox/m-1'])
})

test('a metrics location carries its window, then a report id (team-process-metrics D5)', () => {
  expect(teamHashOf({ teamKey: '/repo', tab: 'metrics', window: '3d' })).toBe('#/team/%2Frepo/metrics/3d')
  expect(parseTeamHash('#/team/%2Frepo/metrics/3d')).toEqual({ teamKey: '/repo', tab: 'metrics', window: '3d' })
  const withReport = teamHashOf({ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'rep-1' })
  expect(withReport).toBe('#/team/%2Frepo/metrics/7d/rep-1')
  expect(parseTeamHash(withReport)).toEqual({ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'rep-1' })
  // The window segment is kept raw: the view validates it and falls back with a notice.
  expect(parseTeamHash('#/team/%2Frepo/metrics/30d')).toEqual({ teamKey: '/repo', tab: 'metrics', window: '30d' })
  expect(parseTeamHash('#/team/%2Frepo/metrics')).toEqual({ teamKey: '/repo', tab: 'metrics' })
  // Only the Metrics tab has a window segment.
  expect(parseTeamHash('#/team/%2Frepo/tasks/7d')).toEqual({ teamKey: '/repo', tab: 'tasks', id: '7d' })
})

test('a window change pushes a history entry; the same window pushes nothing', () => {
  const store = useTeamLocationStore.getState()
  store.navigate({ teamKey: '/repo', tab: 'metrics', window: '7d' })
  store.navigate({ teamKey: '/repo', tab: 'metrics', window: '1d' })
  store.navigate({ teamKey: '/repo', tab: 'metrics', window: '1d' })
  expect(pushed).toEqual(['#/team/%2Frepo/metrics/7d', '#/team/%2Frepo/metrics/1d'])
})

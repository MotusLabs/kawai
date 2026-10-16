// SessionList + chat search: the box sits in the filter bar, a searchable
// query swaps the sections for results, and clearing brings the sections back
// with the project filter exactly as it was.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import type { SessionSearchResponse } from '@shared/sessionSearch'
import ProjectFilterDropdown from '../components/ProjectFilterDropdown'
import SessionList from '../components/SessionList'
import SessionSearchBox from '../components/SessionSearchBox'
import SessionSearchResults from '../components/SessionSearchResults'
import { useSessionSearchStore } from '../stores/sessionSearchStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & { window?: Window & typeof globalThis }
const originalWindow = globalAny.window

const base: Session = {
  id: 'session-1', name: 'alpha-visible', tmuxWindow: 'agentboard:1', projectPath: '/tmp/visible',
  status: 'working', lastActivity: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z', source: 'managed',
}
const sessions: Session[] = [base, { ...base, id: 'session-2', name: 'beta-hidden', projectPath: '/tmp/hidden' }]

const found: SessionSearchResponse = {
  query: '#147', truncated: false, unsearchable: 0,
  results: [{
    sessionId: 'session-2', name: 'beta-hidden', projectPath: '/tmp/hidden', matchCount: 2, nameMatch: false,
    lastMatchAt: '2026-10-15T09:50:00.000Z', snippets: [],
  }],
}

const mounted: TestRenderer.ReactTestRenderer[] = []
function render() {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <SessionList
        sessions={sessions} historySessions={[]} selectedSessionId={null} loading={false}
        error={null} onSelect={() => {}} onRename={() => {}}
      />
    )
  })
  mounted.push(renderer)
  return renderer
}
const dump = (renderer: TestRenderer.ReactTestRenderer) => JSON.stringify(renderer.toJSON())
const search = (query: string, response: SessionSearchResponse | null = found) =>
  act(() => { useSessionSearchStore.setState({ query, status: 'ready', response }) })

beforeEach(() => {
  globalAny.window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  } as unknown as Window & typeof globalThis
  useSettingsStore.setState({
    sessionSortMode: 'created', sessionSortDirection: 'desc', manualSessionOrder: [],
    historySessionsExpanded: false, showProjectName: true, showLastUserMessage: true,
    showSessionIdPrefix: false, projectFilters: ['/tmp/visible'], hostFilters: [],
  })
  useSessionStore.setState({ exitingSessions: new Map() })
  useSessionSearchStore.getState().clear()
})

afterEach(() => {
  act(() => { for (const renderer of mounted.splice(0)) renderer.unmount() })
  useSessionSearchStore.getState().clear()
  globalAny.window = originalWindow
  useSettingsStore.setState({ projectFilters: [], hostFilters: [] })
})

describe('SessionList chat search', () => {
  test('the search box sits in the filter bar after the project filter', () => {
    const renderer = render()
    const bar = renderer.root.findByType(ProjectFilterDropdown).parent!
    const kinds = bar.children.map(child => (typeof child === 'string' ? child : child.type))
    expect(kinds.indexOf(SessionSearchBox)).toBe(kinds.indexOf(ProjectFilterDropdown) + 1)
  })

  test('without a searchable query the sections show and no results render', () => {
    const renderer = render()
    expect(dump(renderer)).toContain('alpha-visible')
    expect(renderer.root.findAllByType(SessionSearchResults)).toHaveLength(0)
    search('x', null)
    expect(renderer.root.findAllByType(SessionSearchResults)).toHaveLength(0)
    expect(dump(renderer)).toContain('alpha-visible')
  })

  test('a searchable query replaces the sections with results', () => {
    const renderer = render()
    search('#147')
    expect(renderer.root.findAllByType(SessionSearchResults)).toHaveLength(1)
    expect(dump(renderer)).not.toContain('alpha-visible')
  })

  test('the project filter does not narrow search results', () => {
    const renderer = render()
    search('#147')
    // beta-hidden is outside the active /tmp/visible filter but is listed.
    expect(dump(renderer)).toContain('beta-hidden')
    expect(renderer.root.findByType(ProjectFilterDropdown).props.selectedProjects).toEqual(['/tmp/visible'])
  })

  test('clearing restores the sections and leaves the filter as it was', () => {
    const renderer = render()
    search('#147')
    act(() => { useSessionSearchStore.getState().clear() })
    expect(renderer.root.findAllByType(SessionSearchResults)).toHaveLength(0)
    expect(dump(renderer)).toContain('alpha-visible')
    expect(renderer.root.findByType(ProjectFilterDropdown).props.selectedProjects).toEqual(['/tmp/visible'])
  })

  test('the results stay while a chat is opened from them', () => {
    const renderer = render()
    search('#147')
    act(() => {
      renderer.root.findAll(node => typeof node.type === 'string' && node.props.id === 'search-opt-session-2')[0]!.props.onClick()
    })
    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')
    expect(renderer.root.findAllByType(SessionSearchResults)).toHaveLength(1)
  })
})

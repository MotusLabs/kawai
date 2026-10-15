import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { SessionSearchResponse, SessionSearchResult } from '@shared/sessionSearch'
import type { WorkspaceSnapshot } from '@shared/workspace'
import SessionSearchResults from '../components/SessionSearchResults'
import { useSessionSearchStore } from '../stores/sessionSearchStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useWorkspaceStore } from '../stores/workspaceStore'

const NOW = Date.parse('2026-10-15T10:00:00.000Z')

function result(over: Partial<SessionSearchResult> & { sessionId: string }): SessionSearchResult {
  return {
    name: over.sessionId, projectPath: `/repo/.worktrees/${over.sessionId}`, matchCount: 1, nameMatch: false,
    lastMatchAt: '2026-10-15T09:50:00.000Z', snippets: [], ...over,
  }
}
const withSnippet = (sessionId: string, over: Partial<SessionSearchResult> = {}) => result({
  sessionId, matchCount: 4,
  snippets: [{
    eventId: `${sessionId}-e1`, anchorId: `tool:${sessionId}-t1`, kind: 'tool_result', tool: 'Bash',
    at: '2026-10-15T09:50:00.000Z', text: '…created https://x/pull/147 ok', ranges: [{ start: 23, end: 27 }],
  }],
  ...over,
})
const response = (results: SessionSearchResult[], extra: Partial<SessionSearchResponse> = {}): SessionSearchResponse =>
  ({ query: '#147', results, truncated: false, unsearchable: 0, ...extra })

const mounted: TestRenderer.ReactTestRenderer[] = []
function render(selectedSessionId: string | null = null) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<SessionSearchResults selectedSessionId={selectedSessionId} now={NOW} />) })
  mounted.push(renderer)
  return renderer
}
const show = (state: Partial<ReturnType<typeof useSessionSearchStore.getState>>) =>
  act(() => { useSessionSearchStore.setState({ query: '#147', status: 'ready', ...state }) })
const text = (node: TestRenderer.ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('')
const classOf = (node: TestRenderer.ReactTestInstance) => String(node.props.className ?? '')
/** The option's DOM element (not the component that renders it). */
const option = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props.id === id)[0]!

describe('SessionSearchResults', () => {
  beforeEach(() => {
    useSessionSearchStore.getState().clear()
    useSessionStore.getState().setSelectedSessionId(null)
    useChatStore.getState().clearReveal()
    useWorkspaceStore.setState({ snapshot: null })
  })
  afterEach(() => {
    act(() => { for (const renderer of mounted.splice(0)) renderer.unmount() })
    useSessionSearchStore.getState().clear()
    useWorkspaceStore.setState({ snapshot: null })
  })

  test('the status line is a polite live region with the settled outcome', () => {
    const renderer = render()
    const status = () => renderer.root.findByProps({ role: 'status' })
    expect(status().props['aria-live']).toBe('polite')

    show({ status: 'loading', response: null })
    expect(text(status())).toBe('Searching…')
    show({ status: 'ready', response: response([result({ sessionId: 'a' }), result({ sessionId: 'b' }), result({ sessionId: 'c' })]) })
    expect(text(status())).toBe('3 chats match')
    show({ response: response([result({ sessionId: 'a' })]) })
    expect(text(status())).toBe('1 chat matches')
    show({ response: response([]) })
    expect(text(status())).toBe('No active chat matches')
    show({ status: 'error', error: 'Search failed (500)' })
    expect(text(status())).toBe('Search failed (500)')
    show({ status: 'error', error: null })
    expect(text(status())).toBe('Search failed')
  })

  test('keeps the previous results visible while a newer query loads', () => {
    const renderer = render()
    show({ response: response([withSnippet('a')]) })
    show({ status: 'loading' })
    expect(renderer.root.findAllByProps({ role: 'option' }).length).toBe(2)
  })

  test('the list is a listbox that never scrolls horizontally', () => {
    const renderer = render()
    show({ response: response([withSnippet('a')]) })
    const listbox = renderer.root.findByProps({ role: 'listbox' })
    expect(listbox.props.id).toBe('session-search-results')
    expect(classOf(listbox)).toContain('overflow-x-hidden')
  })

  test('a header shows name, worktree name, count, and relative time', () => {
    useWorkspaceStore.setState({
      snapshot: { repositories: [{ worktrees: [{ path: '/repo/.worktrees/fix-login' }] }] } as unknown as WorkspaceSnapshot,
    })
    const renderer = render()
    show({ response: response([withSnippet('a', { name: 'middle-dev', projectPath: '/repo/.worktrees/fix-login/src' })]) })
    const header = option(renderer, 'search-opt-a')
    const [name, tree, meta] = header.findAllByType('span').filter(span => span.parent === header)
    expect(text(name!)).toBe('middle-dev')
    expect(text(tree!)).toBe('fix-login')
    expect(tree!.props.title).toBe('/repo/.worktrees/fix-login/src')
    expect(text(meta!)).toBe('4 matches · 10m ago')
    // Truncation order and the whole-meta guarantee.
    expect(classOf(name!)).toContain('shrink-[3]')
    expect(classOf(name!)).toContain('truncate')
    expect(classOf(tree!)).toContain('truncate')
    expect(classOf(meta!)).toContain('shrink-0')
    expect(classOf(meta!)).toContain('whitespace-nowrap')
  })

  test('a chat outside every worktree falls back to its path leaf', () => {
    const renderer = render()
    show({ response: response([result({ sessionId: 'a', projectPath: '/tmp/proj' })]) })
    expect(text(option(renderer, 'search-opt-a'))).toContain('proj')
  })

  test('a name-only match says so and has no snippets', () => {
    const renderer = render()
    show({ response: response([result({ sessionId: 'a', matchCount: 0, nameMatch: true })]) })
    expect(text(option(renderer, 'search-opt-a'))).toContain('name match')
    expect(renderer.root.findAllByProps({ role: 'option' })).toHaveLength(1)
  })

  test('marks the selected chat like a selected navigator row', () => {
    const renderer = render('b')
    show({ response: response([result({ sessionId: 'a' }), result({ sessionId: 'b' })]) })
    expect(classOf(option(renderer, 'search-opt-b'))).toContain('session-row')
    expect(classOf(option(renderer, 'search-opt-b'))).toMatch(/\bselected\b/)
    expect(classOf(option(renderer, 'search-opt-a'))).not.toMatch(/\bselected\b/)
  })

  test('the keyboard-active option has its own marker, separate from selection', () => {
    const renderer = render('b')
    show({ response: response([withSnippet('a'), result({ sessionId: 'b' })]), activeIndex: 1 })
    const snippet = option(renderer, 'search-opt-a-a-e1')
    expect(snippet.props['aria-selected']).toBe(true)
    expect(classOf(snippet)).toContain('search-active')
    expect(classOf(option(renderer, 'search-opt-b'))).not.toContain('search-active')
    expect(classOf(option(renderer, 'search-opt-b'))).toMatch(/\bselected\b/)
  })

  test('a snippet shows its label, a clamped excerpt, highlighted matches, and the absolute time', () => {
    const renderer = render()
    show({ response: response([withSnippet('a')]) })
    const snippet = option(renderer, 'search-opt-a-a-e1')
    const [label, excerpt] = snippet.children as TestRenderer.ReactTestInstance[]
    expect(text(label!)).toBe('Tool result · Bash')
    expect(classOf(excerpt!)).toContain('line-clamp-2')
    const marks = snippet.findAllByType('mark')
    expect(marks.map(mark => text(mark))).toEqual(['/147'])
    expect(marks[0]!.props.className).toBe('search-match')
    expect(text(excerpt!)).toBe('…created https://x/pull/147 ok')
    expect(snippet.props.title).toBe(new Date('2026-10-15T09:50:00.000Z').toLocaleString())
  })

  test('clicking a header opens the chat without a reveal; a snippet also reveals its row', () => {
    const renderer = render()
    show({ response: response([withSnippet('a'), withSnippet('b')]) })
    useChatStore.getState().requestReveal('x', 'stale')

    act(() => { option(renderer, 'search-opt-a').props.onClick() })
    expect(useSessionStore.getState().selectedSessionId).toBe('a')
    expect(useChatStore.getState().pendingReveal).toBeNull()

    act(() => { option(renderer, 'search-opt-b-b-e1').props.onClick() })
    expect(useSessionStore.getState().selectedSessionId).toBe('b')
    expect(useChatStore.getState().pendingReveal).toEqual({ sessionId: 'b', anchorId: 'tool:b-t1' })
    // Opening a result keeps the search.
    expect(useSessionSearchStore.getState().query).toBe('#147')
  })

  test('hovering and clicking leave the keyboard-active item alone', () => {
    const renderer = render()
    show({ response: response([withSnippet('a')]), activeIndex: 0 })
    const snippet = option(renderer, 'search-opt-a-a-e1')
    expect(snippet.props.onMouseEnter).toBeUndefined()
    expect(snippet.props.onMouseMove).toBeUndefined()
    act(() => { snippet.props.onClick() })
    expect(useSessionSearchStore.getState().activeIndex).toBe(0)
  })

  test('notes a truncated result set and unsearchable chats', () => {
    const renderer = render()
    show({ response: response([result({ sessionId: 'a' })], { truncated: true, unsearchable: 1 }) })
    const all = text(renderer.root.findByProps({ 'data-testid': 'session-search-results' }))
    expect(all).toContain('Showing the 50 most recent chats')
    expect(all).toContain('1 chat could not be fully searched')
    show({ response: response([result({ sessionId: 'a' })], { unsearchable: 3 }) })
    const again = text(renderer.root.findByProps({ 'data-testid': 'session-search-results' }))
    expect(again).toContain('3 chats could not be fully searched')
    expect(again).not.toContain('Showing the 50')
  })
})

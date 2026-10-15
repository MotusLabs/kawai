import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { SessionSearchResponse } from '@shared/sessionSearch'
import SessionSearchBox from '../components/SessionSearchBox'
import { SEARCH_LISTBOX_ID, useSessionSearchStore } from '../stores/sessionSearchStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'

const response: SessionSearchResponse = {
  query: '#147', truncated: false, unsearchable: 0,
  results: [{
    sessionId: 'chat-a', name: 'dev', projectPath: '/w/a', matchCount: 1, nameMatch: false,
    lastMatchAt: '2026-10-15T09:00:00.000Z',
    snippets: [{
      eventId: 'e1', anchorId: 'tool:t1', kind: 'tool_result', tool: 'Bash',
      at: '2026-10-15T09:00:00.000Z', text: 'pull/#147', ranges: [{ start: 5, end: 9 }],
    }],
  }],
}

interface FakeInput { focus: () => void; select: () => void; blur: () => void; calls: string[] }
function fakeInput(): FakeInput {
  const calls: string[] = []
  return { calls, focus: () => calls.push('focus'), select: () => calls.push('select'), blur: () => calls.push('blur') }
}

const mounted: TestRenderer.ReactTestRenderer[] = []
function render(input = fakeInput()) {
  // Created inside act(): otherwise later store updates never re-render it.
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<SessionSearchBox modDisplay="⌃⇧" />, {
      createNodeMock: element => (element.type === 'input' ? input : null),
    })
  })
  mounted.push(renderer)
  return { renderer, input }
}
const keyEvent = (key: string) => {
  const event = { key, prevented: false, preventDefault() { event.prevented = true } }
  return event
}
const inputOf = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByType('input')

describe('SessionSearchBox', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useSessionSearchStore.getState().clear()
    useSessionStore.getState().setSelectedSessionId(null)
    useChatStore.getState().clearReveal()
  })
  afterEach(() => {
    act(() => { for (const renderer of mounted.splice(0)) renderer.unmount() })
    useSessionSearchStore.getState().clear()
    jest.useRealTimers()
  })

  function withResults() {
    useSessionSearchStore.setState({ query: '#147', status: 'ready', response, activeIndex: -1 })
  }

  test('is a labelled combobox controlling the results listbox', () => {
    const { renderer } = render()
    const input = inputOf(renderer)
    expect(input.props).toMatchObject({
      role: 'combobox', 'aria-label': 'Search chats', placeholder: 'Search chats',
      'aria-controls': SEARCH_LISTBOX_ID, 'aria-expanded': false,
    })
    act(() => { withResults() })
    expect(inputOf(renderer).props['aria-expanded']).toBe(true)
  })

  test('typing sets the query', () => {
    const { renderer } = render()
    act(() => { inputOf(renderer).props.onChange({ target: { value: '#14' } }) })
    expect(useSessionSearchStore.getState().query).toBe('#14')
    expect(inputOf(renderer).props.value).toBe('#14')
  })

  test('shows the shortcut hint only while empty and unfocused', () => {
    const { renderer } = render()
    expect(renderer.root.findByType('kbd').children.join('')).toBe('⌃⇧K')
    act(() => { inputOf(renderer).props.onFocus() })
    expect(renderer.root.findAllByType('kbd')).toHaveLength(0)
    act(() => { inputOf(renderer).props.onBlur() })
    expect(renderer.root.findAllByType('kbd')).toHaveLength(1)
  })

  test('shows a clear button once there is text, which clears and refocuses', () => {
    const { renderer, input } = render()
    act(() => { withResults() })
    expect(renderer.root.findAllByType('kbd')).toHaveLength(0)
    act(() => { renderer.root.findByProps({ 'aria-label': 'Clear search' }).props.onClick() })
    expect(useSessionSearchStore.getState()).toMatchObject({ query: '', response: null })
    expect(input.calls).toContain('focus')
    expect(renderer.root.findAllByProps({ 'aria-label': 'Clear search' })).toHaveLength(0)
  })

  test('down, down, Enter opens the first snippet while focus stays in the box', () => {
    const { renderer, input } = render()
    act(() => { withResults() })
    const down = keyEvent('ArrowDown')
    act(() => { inputOf(renderer).props.onKeyDown(down) })
    expect(down.prevented).toBe(true)
    expect(inputOf(renderer).props['aria-activedescendant']).toBe('search-opt-chat-a')
    act(() => { inputOf(renderer).props.onKeyDown(keyEvent('ArrowDown')) })
    expect(inputOf(renderer).props['aria-activedescendant']).toBe('search-opt-chat-a-e1')

    const enter = keyEvent('Enter')
    act(() => { inputOf(renderer).props.onKeyDown(enter) })
    expect(enter.prevented).toBe(true)
    expect(useSessionStore.getState().selectedSessionId).toBe('chat-a')
    expect(useChatStore.getState().pendingReveal).toEqual({ sessionId: 'chat-a', anchorId: 'tool:t1' })
    expect(input.calls).not.toContain('blur')
    // The results stay for opening another match.
    expect(useSessionSearchStore.getState().query).toBe('#147')
  })

  test('Enter on a header opens the chat without a reveal', () => {
    const { renderer } = render()
    act(() => { withResults() })
    useChatStore.getState().requestReveal('chat-x', 'old')
    act(() => { inputOf(renderer).props.onKeyDown(keyEvent('ArrowDown')) })
    act(() => { inputOf(renderer).props.onKeyDown(keyEvent('Enter')) })
    expect(useSessionStore.getState().selectedSessionId).toBe('chat-a')
    expect(useChatStore.getState().pendingReveal).toBeNull()
  })

  test('Enter before any down opens nothing', () => {
    const { renderer } = render()
    act(() => { withResults() })
    const enter = keyEvent('Enter')
    act(() => { inputOf(renderer).props.onKeyDown(enter) })
    expect(enter.prevented).toBe(false)
    expect(useSessionStore.getState().selectedSessionId).toBeNull()
    expect(useChatStore.getState().pendingReveal).toBeNull()
  })

  test('up moves back and the active option is dropped when results change', () => {
    const { renderer } = render()
    act(() => { withResults() })
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) act(() => { inputOf(renderer).props.onKeyDown(keyEvent(key)) })
    expect(inputOf(renderer).props['aria-activedescendant']).toBe('search-opt-chat-a')
    act(() => { useSessionSearchStore.getState().setQuery('#1478') })
    expect(inputOf(renderer).props['aria-activedescendant']).toBeUndefined()
  })

  test('Escape clears a query but is left alone when the box is empty', () => {
    const { renderer } = render()
    const idle = keyEvent('Escape')
    act(() => { inputOf(renderer).props.onKeyDown(idle) })
    expect(idle.prevented).toBe(false)

    act(() => { withResults() })
    const escape = keyEvent('Escape')
    act(() => { inputOf(renderer).props.onKeyDown(escape) })
    expect(escape.prevented).toBe(true)
    expect(useSessionSearchStore.getState()).toMatchObject({ query: '', response: null })
  })

  test('other keys are ignored', () => {
    const { renderer } = render()
    const other = keyEvent('a')
    act(() => { inputOf(renderer).props.onKeyDown(other) })
    expect(other.prevented).toBe(false)
  })

  test('a focus token bumped before mounting does not steal focus', () => {
    act(() => { useSessionSearchStore.getState().requestFocus() })
    const { input } = render()
    expect(input.calls).toEqual([])
  })

  test('the focus request focuses the box and selects its text', () => {
    const { input } = render()
    expect(input.calls).toEqual([])
    act(() => { useSessionSearchStore.getState().requestFocus() })
    expect(input.calls).toEqual(['focus', 'select'])
  })
})

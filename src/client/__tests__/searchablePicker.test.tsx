// SearchablePicker (task-assignment 5.1): filter-as-you-type over the
// server-listed options, keyboard selection, manual entry passing the typed
// value straight through (the server validates it on submit), refresh on
// open/focus, and the create-worktree link.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import SearchablePicker from '../components/chat/SearchablePicker'

afterEach(() => {})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const mount = (props: Partial<Parameters<typeof SearchablePicker>[0]> = {}) => {
  const events: Array<{ value?: string; refreshed?: true; created?: true }> = []
  let renderer!: TestRenderer.ReactTestRenderer
  const base = {
    value: '', onChange: (value: string) => events.push({ value }), options: [
      { value: '/repo', label: '/repo', hint: 'branch: master' },
      { value: '/repo-feature', label: '/repo-feature', hint: 'branch: feature' },
      { value: '/repo-ui', label: '/repo-ui', hint: 'branch: ui' },
    ], placeholder: 'Target worktree', ariaLabel: 'Target worktree', testId: 'picker',
    refresh: () => events.push({ refreshed: true }),
    ...props,
  }
  act(() => { renderer = TestRenderer.create(<SearchablePicker {...base} />) })
  return {
    renderer, events,
    input: () => renderer.root.findByProps({ 'data-testid': 'picker-input' }),
    options: () => renderer.root.findAllByProps({ 'data-testid': 'picker-option' }),
    list: () => renderer.root.findByProps({ 'data-testid': 'picker-options' }),
    rerender: (patch: Partial<Parameters<typeof SearchablePicker>[0]>) =>
      act(() => { renderer.update(<SearchablePicker {...base} {...patch} />) }),
  }
}

test('typing filters the list on value, label, and hint', () => {
  const picker = mount({ value: 'feature' })
  act(() => picker.input().props.onFocus())
  expect(picker.options().map(node => node.props['data-value'])).toEqual(['/repo-feature'])
  picker.rerender({ value: 'branch: ui' })
  expect(picker.options().map(node => node.props['data-value'])).toEqual(['/repo-ui'])
  picker.rerender({ value: 'zzz' })
  expect(picker.options()).toHaveLength(0)
  expect(textOf(picker.list())).toContain('No matches')
})

test('keyboard selection picks the highlighted option; Escape closes', () => {
  const picker = mount()
  act(() => picker.input().props.onFocus())
  act(() => picker.input().props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} }))
  act(() => picker.input().props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} }))
  expect(picker.options().map(node => node.props['aria-selected'])).toEqual([false, false, true])
  act(() => picker.input().props.onKeyDown({ key: 'Enter', preventDefault: () => {} }))
  expect(picker.events.filter(event => 'value' in event)).toEqual([{ value: '/repo-ui' }])
  // Choosing closes the list; Escape closes it without picking.
  act(() => picker.input().props.onFocus())
  act(() => picker.input().props.onKeyDown({ key: 'Escape' }))
  expect(picker.events.filter(event => 'value' in event)).toHaveLength(1)
})

test('manual entry passes the typed value through unchanged', () => {
  const picker = mount()
  act(() => picker.input().props.onChange({ target: { value: '/typed/manual/path' } }))
  expect(picker.events).toEqual([{ value: '/typed/manual/path' }])
})

test('focus re-requests the list; the create-worktree link opens the flow and hides without one', () => {
  const created: true[] = []
  const picker = mount({ onCreateWorktree: () => created.push(true) })
  act(() => picker.input().props.onFocus())
  expect(picker.events.filter(event => 'refreshed' in event)).toHaveLength(1)
  const link = picker.renderer.root.findByProps({ 'data-testid': 'picker-create' })
  act(() => link.props.onMouseDown({ preventDefault: () => {} }))
  expect(created).toHaveLength(1)
  // Without a callback the link is not offered at all.
  const bare = mount()
  act(() => bare.input().props.onFocus())
  expect(bare.renderer.root.findAllByProps({ 'data-testid': 'picker-create' })).toHaveLength(0)
})

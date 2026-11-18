// Shared composer acceptance rows W2-W4/W6 on both runtime fixtures.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage, Session } from '../../shared/types'
import ChatView from '../components/chat/ChatView'
import { useChatStore } from '../stores/chatStore'

// Table W2-W4/W6 verbatim: [Id, Input / seam, Observable result].
const oracles = [
  ['W2', 'Codex composer: name/description filter, Up/Down then Tab/Enter; pointer hover/click', 'Visible selection follows choice; replaces only caret word with slash name and space; sends nothing'],
  ['W3', 'Codex composer: later line, path, Escape, no-match Enter', 'Later line opens; paths do not; Escape preserves draft; no-match sends text'],
  ['W4', 'Local /clear, /reset, /new versus middle-of-message /clear', 'Local commands keep profile/policy and create/archive as before; middle word goes unchanged with no skill'],
  ['W6', 'Claude composer and driver regression fixture', 'Existing command discovery, insertion, and submission unchanged'],
] as const
afterEach(() => useChatStore.setState({ sessions: {}, drafts: {}, closedAccountNotices: {} }))

function composer(runtime: 'codex' | 'claude') {
  const session = { id: 'chat-autocomplete', kind: 'chat', name: 'Test', runtime,
    projectPath: '/project', status: 'waiting', claudeProfileId: `${runtime}-profile`, approvalPolicy: 'auto' } as Session
  useChatStore.getState().setCommands({ type: 'chat-commands', sessionId: session.id, state: { status: 'ready', commands: [
    { name: 'explore', description: 'Investigate code', source: 'project', aliases: [] },
    { name: 'review', description: 'Find defects', source: 'user', aliases: [] },
  ] } })
  const sent: ClientMessage[] = []
  const listeners: Array<(message: ServerMessage) => void> = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ChatView session={session}
    sendMessage={message => sent.push(message)} subscribe={listener => { listeners.push(listener); return () => {} }}
    connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />) })
  const textarea = () => renderer.root.findByType('textarea')
  const type = (value: string, caret = value.length) => act(() => textarea().props.onChange({ target: { value, selectionStart: caret, selectionEnd: caret } }))
  const submit = () => act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  const key = (key: string) => act(() => textarea().props.onKeyDown({ key, preventDefault() {}, currentTarget: { form: { requestSubmit: submit } } }))
  const options = () => renderer.root.findAllByProps({ role: 'option' })
  return { renderer, session, sent, listeners, textarea, type, submit, key, options }
}

for (const runtime of ['codex', 'claude'] as const) {
  // @covers: codex-chat-sessions › Codex autocomplete uses the shared composer interactions › Choose a skill in the middle of a message
  // @covers: codex-chat-sessions › Codex autocomplete uses the shared composer interactions › Pointer selection and dismissal
  test(`W2/W6: ${runtime} filters, highlights and inserts at the caret by keyboard and pointer without sending`, () => {
    expect(oracles.map(row => row[0])).toContain('W2')
    const h = composer(runtime)
    h.type('please /invest on this', 14)
    expect(h.options().map(option => option.props['data-command-name'])).toEqual(['explore'])
    h.key('Tab')
    expect(h.textarea().props.value).toBe('please /explore on this')
    h.type('please / on this', 8)
    h.key('ArrowDown')
    expect(h.options()[1]!.props['aria-selected']).toBe(true)
    expect(h.options()[1]!.props.className).toContain('bg-hover')
    h.key('ArrowUp'); h.key('Enter')
    expect(h.textarea().props.value).toBe('please /explore on this')
    h.type('/'); act(() => h.options()[1]!.props.onPointerMove())
    expect(h.options()[1]!.props['aria-selected']).toBe(true)
    act(() => h.options()[1]!.props.onClick())
    expect(h.textarea().props.value).toBe('/review ')
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    h.renderer.unmount()
  })

  // @covers: codex-chat-sessions › Codex autocomplete uses the shared composer interactions › Paths and unknown names
  test(`W3/W6: ${runtime} later lines, paths, Escape and unknown-command sending retain existing behavior`, () => {
    const h = composer(runtime)
    h.type('first\n/exp'); expect(h.options()).toHaveLength(1)
    h.key('Escape'); expect(h.options()).toHaveLength(0)
    expect(h.textarea().props.value).toBe('first\n/exp')
    for (const value of ['https://example', '/usr/bin']) {
      h.type(value)
      expect(h.renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
    }
    h.type('/missing'); h.key('Enter')
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([{ type: 'chat-send', sessionId: h.session.id, text: '/missing' }])
    h.renderer.unmount()
  })
}

// A1 (r1#ecfe1b7633b3): stationary-pointer hijack regression. Chromium re-emits
// pointerenter boundary events, without movement, on the row under a parked
// cursor when the menu mounts or re-renders (diagnosis task-acaf9d73); the
// highlight must follow only actual pointer movement, so injecting the bare
// boundary event at a keyboard transition must not flip the keyboard choice.
test('A1: stationary pointer boundary events do not flip the keyboard highlight', () => {
  const h = composer('codex')
  h.type('first\n/')
  expect(h.options().map(option => option.props['data-command-name'])).toEqual(['explore', 'review'])
  h.key('ArrowDown')
  expect(h.options()[1]!.props['aria-selected']).toBe(true)
  // The boundary event Chromium emits without movement: highlighting ignores it.
  act(() => h.options()[0]!.props.onPointerEnter?.())
  expect(h.options()[1]!.props['aria-selected']).toBe(true)
  h.key('ArrowUp'); h.key('Enter')
  expect(h.textarea().props.value).toBe('first\n/explore ')
  expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
  h.renderer.unmount()
})

// F1 (findings-69740b38, r1#ecfe1b7633b3 › I1): the keyboard wraps at both
// list ends — ArrowDown past the last row lands on the first, ArrowUp before
// the first lands on the last (the modulo branches in ChatComposer) — and a
// stationary boundary burst at those wrapped transitions must not steal the
// choice; Enter/Tab insert the wrapped command without sending.
test('I1: keyboard wraps past both list ends and stationary boundary events do not steal the wrapped choice', () => {
  const h = composer('codex')
  h.type('/')
  expect(h.options().map(option => option.props['data-command-name'])).toEqual(['explore', 'review'])
  h.key('ArrowDown')
  expect(h.options()[1]!.props['aria-selected']).toBe(true)
  h.key('ArrowDown')
  expect(h.options()[0]!.props['aria-selected']).toBe(true)
  act(() => h.options()[1]!.props.onPointerEnter?.())
  expect(h.options()[0]!.props['aria-selected']).toBe(true)
  h.key('Enter')
  expect(h.textarea().props.value).toBe('/explore ')
  expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
  h.type('/')
  h.key('ArrowUp')
  expect(h.options()[1]!.props['aria-selected']).toBe(true)
  act(() => h.options()[0]!.props.onPointerEnter?.())
  expect(h.options()[1]!.props['aria-selected']).toBe(true)
  h.key('Tab')
  expect(h.textarea().props.value).toBe('/review ')
  expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
  h.renderer.unmount()
})

// task-748ad131 A1: a new slash token owns its highlight and Escape state from
// its first render. Outside act() each handler renders synchronously while the
// passive effects stay pending (as a pending Scheduler task does in the
// browser), so a reset left to a passive effect would let the previous token's
// index or dismissal act on the reopened menu (the CI failure at
// chat-codex-autocomplete.spec.ts:121). act() afterwards flushes them.
function withoutAct(run: () => void) {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = scope.IS_REACT_ACT_ENVIRONMENT
  scope.IS_REACT_ACT_ENVIRONMENT = false
  try { run() } finally { scope.IS_REACT_ACT_ENVIRONMENT = previous }
  act(() => {})
}
const rawType = (h: ReturnType<typeof composer>, value: string) =>
  h.textarea().props.onChange({ target: { value, selectionStart: value.length, selectionEnd: value.length } })
const rawKey = (h: ReturnType<typeof composer>, key: string) =>
  h.textarea().props.onKeyDown({ key, preventDefault() {}, currentTarget: { form: { requestSubmit: h.submit } } })
const selected = (h: ReturnType<typeof composer>) => h.options().map(option => option.props['aria-selected'])
// @covers: chat-sessions › The slash-command menu marks the selected option › The first option starts selected
test('A1: a reopened token starts on its first match before passive effects run', () => {
  const h = composer('codex')
  h.type('/'); h.key('ArrowUp')
  expect(h.options()[1]!.props['aria-selected']).toBe(true)
  h.key('Tab')
  expect(h.textarea().props.value).toBe('/review ')
  const seen: boolean[][] = []
  withoutAct(() => {
    rawType(h, '/'); seen.push(selected(h))
    rawKey(h, 'ArrowDown'); seen.push(selected(h))
    rawKey(h, 'ArrowDown'); seen.push(selected(h))
  })
  expect(seen).toEqual([[true, false], [false, true], [true, false]])
  expect(selected(h)).toEqual([true, false])
  h.key('Enter')
  expect(h.textarea().props.value).toBe('/explore ')
  expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
  h.renderer.unmount()
})

// Preserved behavior (A3): Escape dismisses only its own token. The legacy
// test root flushes the pending passive effect before the reopening's second
// render, so this row passes on the effect-based reset too; the browser spec's
// same-task Escape probe is the discriminating oracle for dismissal.
// @covers: chat-sessions › The composer offers a slash-command menu › Dismiss the menu
test('A3: Escape dismissal ends when the token changes, without passive effects', () => {
  const h = composer('codex')
  h.type('/expl'); h.key('Escape')
  expect(h.options()).toHaveLength(0)
  expect(h.textarea().props.value).toBe('/expl')
  const seen: string[][] = []
  withoutAct(() => {
    rawType(h, '/'); seen.push(h.options().map(option => option.props['data-command-name']))
    rawKey(h, 'Enter')
  })
  expect(seen).toEqual([['explore', 'review']])
  expect(h.textarea().props.value).toBe('/explore ')
  expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
  h.renderer.unmount()
})

for (const command of ['/clear', '/reset', '/new']) {
  test(`W4: Codex ${command} keeps the profile and policy, archives after creation, and middle /clear stays text`, () => {
    const h = composer('codex')
    h.type('please /clear later'); h.submit()
    expect(h.sent.find(message => message.type === 'chat-send')).toMatchObject({ text: 'please /clear later' })
    h.sent.length = 0
    h.type(command); h.submit()
    expect(h.sent.find(message => message.type === 'session-create')).toMatchObject({ claudeProfileId: 'codex-profile', approvalPolicy: 'auto', projectPath: '/project' })
    expect(h.sent.some(message => message.type === 'chat-send' || message.type === 'chat-archive')).toBe(false)
    const next = { ...h.session, id: 'next' }
    act(() => h.listeners.forEach(listener => listener({ type: 'session-created', session: next })))
    expect(h.sent.find(message => message.type === 'chat-archive')).toEqual({ type: 'chat-archive', sessionId: h.session.id })
    h.renderer.unmount()
  })
}

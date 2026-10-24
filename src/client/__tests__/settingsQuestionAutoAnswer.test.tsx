// The question auto-answer Settings field and its store cache
// (question-auto-answer 4.3): the wait loads from the server, saves with its
// own control, refuses invalid input inline before any request, shows the
// server's refusal, renders 0 as off, and follows the change broadcast
// through the settings store.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ServerMessage } from '@shared/types'
import QuestionAutoAnswerSetting from '../components/settings/QuestionAutoAnswerSetting'
import { useSettingsStore } from '../stores/settingsStore'
import { handleQuestionAutoAnswerChanged } from '../protocol/serverMessages'

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')

const originalFetch = globalThis.fetch
let requests: Array<{ method: string; body: unknown }>
let nextResponse: { status: number; body: unknown } | null

beforeEach(() => {
  requests = []
  nextResponse = null
  useSettingsStore.setState({ questionAutoAnswerMinutes: 5 })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ method, body })
    // The canned refusal answers the next save, never the mount's load.
    if (nextResponse && method === 'PUT') {
      const { status, body: responseBody } = nextResponse
      nextResponse = null
      return new Response(JSON.stringify(responseBody), { status })
    }
    return Response.json(method === 'GET' ? { minutes: 5 } : { minutes: (body as { minutes: number }).minutes })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  useSettingsStore.setState({ questionAutoAnswerMinutes: 5 })
})

const mount = async () => {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<QuestionAutoAnswerSetting />)
  })
  return renderer
}

const input = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findByProps({ 'aria-label': 'Question auto-answer wait in minutes' })
const apply = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByType('button').find(node => textOf(node) === 'Apply')!
const refusal = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByProps({ 'data-testid': 'question-auto-answer-refusal' })[0]
const hint = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findByProps({ 'data-testid': 'question-auto-answer-hint' })

describe('settings question auto-answer field', () => {
  test('the wait loads from the server on mount (QA-S3)', async () => {
    globalThis.fetch = (async () => Response.json({ minutes: 7 })) as unknown as typeof fetch
    const renderer = await mount()
    expect(useSettingsStore.getState().questionAutoAnswerMinutes).toBe(7)
    expect(input(renderer).props.value).toBe('7')
    expect(hint(renderer).props.children).toBe('Fully recommended questions answer themselves after 7 minutes.')
    renderer.unmount()
  })

  test('Apply saves a valid wait; the store and hint follow (QA-S3)', async () => {
    const renderer = await mount()
    await act(async () => { input(renderer).props.onChange({ target: { value: '3' } }) })
    await act(async () => { apply(renderer).props.onClick() })
    const put = requests.find(request => request.method === 'PUT')
    expect(put?.body).toEqual({ minutes: 3 })
    expect(useSettingsStore.getState().questionAutoAnswerMinutes).toBe(3)
    expect(input(renderer).props.value).toBe('3')
    expect(hint(renderer).props.children).toBe('Fully recommended questions answer themselves after 3 minutes.')
    expect(refusal(renderer)).toBeUndefined()
    renderer.unmount()
  })

  test.each(['2.5', '1441', '-1', 'abc', ''])('an out-of-range or non-integer wait (%s) is refused inline with no request and nothing stored (QA-S4)', async (value) => {
    const renderer = await mount()
    await act(async () => { input(renderer).props.onChange({ target: { value } }) })
    await act(async () => { apply(renderer).props.onClick() })
    expect(refusal(renderer) !== undefined).toBe(true)
    expect(textOf(refusal(renderer))).toContain('whole number')
    expect(requests.filter(request => request.method === 'PUT')).toEqual([])
    expect(useSettingsStore.getState().questionAutoAnswerMinutes).toBe(5)
    renderer.unmount()
  })

  test('the server refusal shows inline and the store keeps the old wait (QA-S4)', async () => {
    nextResponse = { status: 400, body: { error: 'minutes must be a whole number between 0 and 1440' } }
    const renderer = await mount()
    await act(async () => { input(renderer).props.onChange({ target: { value: '30' } }) })
    await act(async () => { apply(renderer).props.onClick() })
    expect(textOf(refusal(renderer))).toContain('whole number')
    expect(useSettingsStore.getState().questionAutoAnswerMinutes).toBe(5)
    renderer.unmount()
  })

  test('a saved wait of 0 renders as off (QA-S2)', async () => {
    globalThis.fetch = (async () => Response.json({ minutes: 0 })) as unknown as typeof fetch
    const renderer = await mount()
    expect(input(renderer).props.value).toBe('0')
    expect(hint(renderer).props.children).toBe('Off — questions wait for you.')
    renderer.unmount()
  })

  test('the broadcast updates an untouched field live and leaves a draft alone (QA-S3)', async () => {
    const renderer = await mount()
    act(() => handleQuestionAutoAnswerChanged(
      { type: 'question-auto-answer-changed', minutes: 9 } as Extract<ServerMessage, { type: 'question-auto-answer-changed' }>,
      undefined as never
    ))
    expect(input(renderer).props.value).toBe('9')
    expect(hint(renderer).props.children).toBe('Fully recommended questions answer themselves after 9 minutes.')
    // The user's unsaved edit is never clobbered by a broadcast (#112).
    await act(async () => { input(renderer).props.onChange({ target: { value: '12' } }) })
    act(() => handleQuestionAutoAnswerChanged(
      { type: 'question-auto-answer-changed', minutes: 2 } as Extract<ServerMessage, { type: 'question-auto-answer-changed' }>,
      undefined as never
    ))
    expect(input(renderer).props.value).toBe('12')
    renderer.unmount()
  })
})

describe('settings store auto-answer cache', () => {
  test('a bad wire value never enters the store (QA-S4)', () => {
    for (const bad of [1441, -1, 2.5, '7', null]) {
      useSettingsStore.getState().setQuestionAutoAnswerMinutes(bad)
      expect(useSettingsStore.getState().questionAutoAnswerMinutes).toBe(5)
    }
    useSettingsStore.getState().setQuestionAutoAnswerMinutes(0)
    expect(useSettingsStore.getState().questionAutoAnswerMinutes).toBe(0)
  })
})

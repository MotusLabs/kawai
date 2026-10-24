// The question auto-answer client surfaces (question-auto-answer 4.1, 4.2):
// the countdown and Wait for me on the question form, the one hold the
// form's first edit sends while a deadline stands, and the transcript
// markers that keep a timeout answer, a held deadline, and a user answer
// apart.
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ChatEvent, ChatPendingRequest } from '@shared/chat'
import type { ClientMessage } from '@shared/types'
import ChatRequests from '../components/chat/ChatRequests'
import ChatMessages from '../components/chat/ChatMessages'
import { autoAnswerChoiceLabels, formatCountdown, timeoutAnswerLabels } from '../components/chat/autoAnswerLabels'

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')

const questionRequest = (autoAnswer?: Extract<ChatPendingRequest, { kind: 'question' }>['autoAnswer']): ChatPendingRequest => ({
  kind: 'question',
  requestId: 'r1',
  at: '2026-10-24T10:00:00.000Z',
  questions: [{ question: 'Deploy?', header: 'Deploy', multiSelect: false, options: [{ label: 'Go (Recommended)' }, { label: 'Wait' }] }],
  ...(autoAnswer ? { autoAnswer } : {}),
})

const deadline = { at: new Date(Date.now() + 95_000).toISOString(), answers: { 'Deploy?': { options: ['Go (Recommended)'] } } }

const renderRequests = (request: ChatPendingRequest, sent: ClientMessage[], disabled = false) =>
  TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={disabled} sendMessage={message => sent.push(message)}
    requests={[request]} />)

describe('question auto-answer countdown', () => {
  test('a standing deadline shows what will be chosen and m:ss left (QA-1)', () => {
    const renderer = renderRequests(questionRequest(deadline), [])
    const countdown = renderer.root.findByProps({ 'data-testid': 'auto-answer-countdown' })
    expect(textOf(countdown)).toMatch(/^Will choose Go \(Recommended\) in \d+:\d\d$/)
    renderer.unmount()
  })

  test('multi-select labels join with commas, questions with semicolons', () => {
    expect(autoAnswerChoiceLabels({
      'First?': { options: ['Blue (Recommended)', 'Green (Recommended)'] },
      'Second?': { options: ['Now (Recommended)'] },
    })).toBe('Blue (Recommended), Green (Recommended); Now (Recommended)')
    expect(timeoutAnswerLabels({ 'First?': 'Blue', 'Second?': 'Now' })).toBe('Blue; Now')
  })

  test('the countdown formats m:ss, ceiled, 0:00 at and past the deadline', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z')
    expect(formatCountdown('2026-10-24T10:01:35.000Z', now)).toBe('1:35')
    expect(formatCountdown('2026-10-24T10:01:00.000Z', now)).toBe('1:00')
    // Ceiled: any remainder above 59 s still reads 1:00, and the final
    // second reads 0:01 until the deadline itself.
    expect(formatCountdown('2026-10-24T10:00:59.499Z', now)).toBe('1:00')
    expect(formatCountdown('2026-10-24T10:00:59.000Z', now)).toBe('0:59')
    expect(formatCountdown('2026-10-24T10:00:00.500Z', now)).toBe('0:01')
    expect(formatCountdown('2026-10-24T10:00:00.000Z', now)).toBe('0:00')
    expect(formatCountdown('2026-10-24T09:59:00.000Z', now)).toBe('0:00')
    expect(formatCountdown('not-a-time', now)).toBe('0:00')
  })

  test('no deadline, no countdown row (QA-27)', () => {
    const renderer = renderRequests(questionRequest(), [])
    expect(renderer.root.findAllByProps({ 'data-testid': 'auto-answer-deadline' })).toHaveLength(0)
    renderer.unmount()
  })
})

describe('question auto-answer hold', () => {
  test('Wait for me sends chat-question-hold, disabled while disconnected (QA-3)', () => {
    const sent: ClientMessage[] = []
    const renderer = renderRequests(questionRequest(deadline), sent)
    const button = renderer.root.findAllByType('button').find(node => textOf(node) === 'Wait for me')!
    act(() => button.props.onClick())
    expect(sent).toEqual([{ type: 'chat-question-hold', sessionId: 'chat-1', requestId: 'r1' }])
    renderer.unmount()
    const offline: ClientMessage[] = []
    const offlineRenderer = renderRequests(questionRequest(deadline), offline, true)
    expect(offlineRenderer.root.findAllByType('button').find(node => textOf(node) === 'Wait for me')!.props.disabled).toBe(true)
    offlineRenderer.unmount()
  })

  test('the form sends exactly one hold on its first edit while a deadline stands (QA-4)', () => {
    const sent: ClientMessage[] = []
    const renderer = renderRequests(questionRequest(deadline), sent)
    const inputs = () => renderer.root.findAllByType('input')
    // First edit — an option — holds once; later edits hold no more.
    act(() => inputs()[0]!.props.onChange({ target: { checked: true } }))
    act(() => inputs()[1]!.props.onChange({ target: { checked: true } }))
    act(() => inputs()[2]!.props.onChange({ target: { value: 'my own' } }))
    expect(sent).toEqual([{ type: 'chat-question-hold', sessionId: 'chat-1', requestId: 'r1' }])
    renderer.unmount()
  })

  test('an edit without a deadline sends no hold at all (QA-27)', () => {
    const sent: ClientMessage[] = []
    const renderer = renderRequests(questionRequest(), sent)
    const inputs = () => renderer.root.findAllByType('input')
    act(() => inputs()[0]!.props.onChange({ target: { checked: true } }))
    act(() => inputs()[2]!.props.onChange({ target: { value: 'my own' } }))
    expect(sent).toEqual([])
    // The ordinary answer still submits (single-select: the typed text
    // replaced the option).
    act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
    expect(sent).toEqual([{ type: 'chat-answer', sessionId: 'chat-1', requestId: 'r1', answers: { 'Deploy?': { text: 'my own' } } }])
    renderer.unmount()
  })

  test('after the held event the countdown is gone and later edits hold nothing (QA-23)', () => {
    const sent: ClientMessage[] = []
    const renderer = renderRequests(questionRequest(deadline), sent)
    act(() => renderer.root.findAllByType('input')[0]!.props.onChange({ target: { checked: true } }))
    expect(sent).toHaveLength(1)
    // The store folded the held event: the same form, autoAnswer dropped.
    const held = questionRequest()
    act(() => renderer.update(<ChatRequests sessionId="chat-1" disabled={false}
      sendMessage={message => sent.push(message)} requests={[held]} />))
    expect(renderer.root.findAllByProps({ 'data-testid': 'auto-answer-deadline' })).toHaveLength(0)
    act(() => renderer.root.findAllByType('input')[1]!.props.onChange({ target: { checked: true } }))
    expect(sent).toHaveLength(1)
    renderer.unmount()
  })
})

describe('question auto-answer transcript markers', () => {
  const render = (events: ChatEvent[]) => TestRenderer.create(<ChatMessages events={events} />)

  test('a timeout answer renders apart from a user answer (QA-1, QA-12, QA-18)', () => {
    const timeout: ChatEvent = { type: 'request_resolved', id: 'x1', sequence: 2, at: 'now', requestId: 'r1', outcome: 'answered', decidedBy: 'timeout', answers: { 'Deploy?': 'Go (Recommended)' } }
    const renderer = render([
      { type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'deploy?' },
      timeout,
    ])
    const marker = renderer.root.findByProps({ 'data-testid': 'auto-answered' })
    expect(textOf(marker)).toBe('Answered automatically: Go (Recommended)')
    renderer.unmount()
    // The user's own answer keeps today's line; the two never merge.
    const user: ChatEvent = { type: 'request_resolved', id: 'x2', sequence: 2, at: 'now', requestId: 'r1', outcome: 'answered', decidedBy: 'user' }
    const userRenderer = render([
      { type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'deploy?' },
      user,
    ])
    expect(textOf(userRenderer.root.findByProps({ 'data-testid': 'chat-transcript' }))).toContain('Request answered')
    expect(userRenderer.root.findAllByProps({ 'data-testid': 'auto-answered' })).toHaveLength(0)
    userRenderer.unmount()
  })

  test('a policy grant still renders as auto-approved (preserved)', () => {
    const renderer = render([
      { type: 'request_resolved', id: 'x3', sequence: 1, at: 'now', requestId: 'r2', outcome: 'allowed', decidedBy: 'policy', tool: 'Bash' },
    ])
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'auto-approved' }))).toBe('Auto-approved Bash')
    renderer.unmount()
  })

  test('the held event renders Auto-answer held (QA-3)', () => {
    const renderer = render([
      { type: 'question_auto_answer_held', id: 'h1', sequence: 1, at: 'now', requestId: 'r1' },
    ])
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'auto-answer-held' }))).toBe('Auto-answer held')
    renderer.unmount()
  })

  test('a replayed timeout answer reaches history through the tool result note (QA-17)', () => {
    const note = 'No answer from the user within 1 minute; the recommended option was selected automatically.'
    const renderer = render([
      { type: 'tool_call', id: 'c1', sequence: 0, at: 'now', turnId: 't', toolCallId: 'tool-1', tool: 'AskUserQuestion', input: { questions: [] } },
      { type: 'tool_result', id: 'r9', sequence: 1, at: 'now', turnId: 't', toolCallId: 'tool-1', output: JSON.stringify({ updatedInput: { response: note } }) },
    ])
    expect(textOf(renderer.root.findByType('summary'))).toContain('AskUserQuestion')
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-transcript' }))).toContain('the recommended option was selected automatically')
    expect(renderer.root.findAllByProps({ 'data-testid': 'auto-answered' })).toHaveLength(0)
    renderer.unmount()
  })
})

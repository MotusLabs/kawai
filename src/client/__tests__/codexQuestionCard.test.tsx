// Codex question cards (codex-chat-sessions F3): the carried isSecret/isOther
// flags shape the card — a secret question masks its input, on the pending and
// the answered card; free text is offered only where Codex allows another
// answer; a Claude question (no flags) renders exactly as before. The carried
// flags themselves are asserted against the fake app-server in
// src/server/__tests__/codexApprovals.test.ts.
import { expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatPendingRequest } from '@shared/chat'
import type { ClientMessage } from '@shared/types'
import ChatRequests from '../components/chat/ChatRequests'

test('a secret Codex question masks its input, on the pending and the answered card', () => {
  const sent: ClientMessage[] = []
  const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={message => sent.push(message)}
    requests={[{ kind: 'question', requestId: 'q', at: 'now', questions: [{ question: 'Paste the token?', header: 'Token', multiSelect: false,
      options: [], isSecret: true, isOther: true }] }]} />)
  const input = () => renderer.root.findByProps({ 'aria-label': 'Free-text answer: Paste the token?' })
  expect(input().props.type).toBe('password')
  act(() => input().props.onChange({ target: { value: 'sk-test' } }))
  expect(input().props.value).toBe('sk-test')
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  // The answer returns keyed by question, and stays masked on the card
  // until the resolved event removes it.
  expect(sent).toEqual([{ type: 'chat-answer', sessionId: 'chat-1', requestId: 'q',
    answers: { 'Paste the token?': { text: 'sk-test' } } }])
  expect(input().props.type).toBe('password')
  renderer.unmount()
})

test('free text is offered only where Codex allows another answer', () => {
  const request = (isOther: boolean | undefined): ChatPendingRequest => ({
    kind: 'question', requestId: 'q', at: 'now',
    questions: [{ question: 'Q', header: 'H', multiSelect: false, options: [{ label: 'A' }],
      ...(isOther === undefined ? {} : { isOther }) }],
  })
  const inputs = (isOther: boolean | undefined) => {
    const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={() => {}} requests={[request(isOther)]} />)
    const found = renderer.root.findAllByProps({ 'aria-label': 'Free-text answer: Q' })
    renderer.unmount()
    return found
  }
  expect(inputs(true)).toHaveLength(1) // Codex allows another answer
  expect(inputs(false)).toHaveLength(0) // Codex offers only its options
  expect(inputs(undefined)).toHaveLength(1) // A Claude question: unchanged
})

test('a Claude question renders exactly as before: plain input with free text', () => {
  const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={() => {}}
    requests={[{ kind: 'question', requestId: 'q', at: 'now', questions: [{ question: 'Pick?', header: 'Pick', multiSelect: false,
      options: [{ label: 'A' }] }] }]} />)
  const input = renderer.root.findByProps({ 'aria-label': 'Free-text answer: Pick?' })
  expect(input.props.type).toBeUndefined()
  expect(input.props.placeholder).toBe('Or type your own answer')
  renderer.unmount()
})

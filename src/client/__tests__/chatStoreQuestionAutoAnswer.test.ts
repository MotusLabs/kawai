// The question auto-answer fold in the chat transcript store
// (question-auto-answer 4.1): a pending question carries the server's
// autoAnswer while the deadline stands, the held event drops it in place,
// and any resolution removes the request — so a settled question offers no
// form to edit, answer again, or hold.
import { describe, expect, test } from 'bun:test'
import type { ChatEvent, ChatPendingRequest } from '@shared/chat'
import { applyChatEvents, emptyTranscript } from '../stores/chatStore'

const questionRequest = (overrides: Partial<Extract<ChatEvent, { type: 'question_request' }>> = {}): ChatEvent => ({
  type: 'question_request',
  id: 'q1',
  sequence: 1,
  at: '2026-10-24T10:00:00.000Z',
  turnId: 't1',
  requestId: 'r1',
  questions: [{ question: 'Deploy?', header: 'Deploy', multiSelect: false, options: [{ label: 'Go (Recommended)' }, { label: 'Wait' }] }],
  ...overrides,
})

const autoAnswer = {
  at: '2026-10-24T10:05:00.000Z',
  answers: { 'Deploy?': { options: ['Go (Recommended)'] } },
}

const questionOf = (requests: ChatPendingRequest[]): Extract<ChatPendingRequest, { kind: 'question' }> =>
  requests[0] as Extract<ChatPendingRequest, { kind: 'question' }>

describe('chat store question auto-answer', () => {
  test('a pending question carries autoAnswer while the deadline stands (QA-1)', () => {
    const state = applyChatEvents(emptyTranscript(), [questionRequest({ autoAnswer })])
    const pending = questionOf(state.pendingRequests)
    expect(pending.autoAnswer).toEqual(autoAnswer)
    expect(state.status).toBe('permission')
    // A request without a deadline carries none (QA-8's no-deadline class).
    const plain = applyChatEvents(emptyTranscript(), [questionRequest({ id: 'q2', requestId: 'r2' })])
    expect(questionOf(plain.pendingRequests).autoAnswer).toBeUndefined()
  })

  test('the held event drops autoAnswer but keeps the question pending (QA-3, QA-23)', () => {
    const pending = applyChatEvents(emptyTranscript(), [questionRequest({ autoAnswer })])
    const held = applyChatEvents(pending, [
      { type: 'question_auto_answer_held', id: 'h1', sequence: 2, at: '2026-10-24T10:01:00.000Z', requestId: 'r1' },
    ])
    const request = questionOf(held.pendingRequests)
    expect(request.requestId).toBe('r1')
    expect(request.autoAnswer).toBeUndefined()
    expect(held.status).toBe('permission')
    // The held event is a transcript row ("Auto-answer held", 4.2).
    expect(held.events.at(-1)?.type).toBe('question_auto_answer_held')
  })

  test('a hold of another request leaves this one untouched', () => {
    const pending = applyChatEvents(emptyTranscript(), [questionRequest({ autoAnswer })])
    const held = applyChatEvents(pending, [
      { type: 'question_auto_answer_held', id: 'h2', sequence: 2, at: 'now', requestId: 'other' },
    ])
    expect(questionOf(held.pendingRequests).autoAnswer).toEqual(autoAnswer)
  })

  test('a timeout resolution removes the request: no second answer or edit is possible (QA-12, QA-14)', () => {
    const pending = applyChatEvents(emptyTranscript(), [questionRequest({ autoAnswer })])
    const answered = applyChatEvents(pending, [
      { type: 'request_resolved', id: 'x1', sequence: 2, at: 'now', requestId: 'r1', outcome: 'answered', decidedBy: 'timeout', answers: { 'Deploy?': 'Go (Recommended)' } },
    ])
    expect(answered.pendingRequests).toEqual([])
    // Status leaves permission for the running turn, as with a user answer.
    expect(answered.status).toBe('working')
  })

  test('a cancelled resolution removes the request: a racing edit is inert (QA-25)', () => {
    const pending = applyChatEvents(emptyTranscript(), [questionRequest({ autoAnswer })])
    const cancelled = applyChatEvents(pending, [
      { type: 'request_resolved', id: 'x2', sequence: 2, at: 'now', requestId: 'r1', outcome: 'cancelled' },
    ])
    expect(cancelled.pendingRequests).toEqual([])
  })

  test('a user answer resolves the same way; no deadline survives it (QA-18 live face)', () => {
    const pending = applyChatEvents(emptyTranscript(), [questionRequest({ autoAnswer })])
    const answered = applyChatEvents(pending, [
      { type: 'request_resolved', id: 'x3', sequence: 2, at: 'now', requestId: 'r1', outcome: 'answered', decidedBy: 'user' },
    ])
    expect(answered.pendingRequests).toEqual([])
    expect(answered.status).toBe('working')
  })
})

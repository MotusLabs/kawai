// Status dot colors and the chat header's indicator (chat-header-layout D7).
import { expect, test } from 'bun:test'
import { chatStatusIndicator, sessionStatusDot } from '../utils/sessionStatus'

test('each session status has its dot color', () => {
  expect(sessionStatusDot).toEqual({
    working: 'bg-working', waiting: 'bg-waiting', permission: 'bg-approval', unknown: 'bg-muted',
  })
  for (const status of ['working', 'waiting', 'permission', 'unknown'] as const) {
    expect(chatStatusIndicator(status, 'connected', false)).toEqual({ word: status, dot: sessionStatusDot[status] })
  }
})

test('connection states win over the session status, even when archived', () => {
  expect(chatStatusIndicator('working', 'connecting', false)).toEqual({ word: 'connecting', dot: 'bg-approval' })
  expect(chatStatusIndicator('working', 'reconnecting', true)).toEqual({ word: 'reconnecting', dot: 'bg-approval' })
  expect(chatStatusIndicator('waiting', 'disconnected', false)).toEqual({ word: 'disconnected', dot: 'bg-danger' })
})

test('an archived chat reads archived while connected', () => {
  expect(chatStatusIndicator('waiting', 'connected', true)).toEqual({ word: 'archived', dot: 'bg-muted' })
})

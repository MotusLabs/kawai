// Shared waiting-reason model (team-waiting-reasons 1.1) and the label
// formatting (1.2): every constraint kind's fields are exercised by
// construction, the snapshot stays optional-field compatible, and dead-letter
// codes map to readable labels with unknown codes passing through unchanged.
import { expect, test } from 'bun:test'
import type { ServerMessage } from '@shared/types'
import type { WaitingConstraint, WaitingReason } from '@shared/team'
import { constraintLabel, deadLetterLabel, elapsedLabel } from '../utils/waitingLabels'

type Snapshot = Extract<ServerMessage, { type: 'team-mailbox-snapshot' }>

test('every constraint kind carries its fields', () => {
  const constraints: WaitingConstraint[] = [
    { kind: 'recipient-busy' },
    { kind: 'recipient-pending-request' },
    { kind: 'recipient-unavailable', detail: 'the project directory /x is gone' },
    { kind: 'profile-cooling', retryAt: '2026-10-13T12:00:00.000Z' },
    { kind: 'startup-failed', detail: 'lost auth' },
    { kind: 'no-eligible-member', sessionIds: ['dev-1', 'dev-2'], detail: 'dev-1 working, dev-2 has a pending card' },
    { kind: 'group-cap', counts: { live: 2, cap: 2 } },
    { kind: 'profile-cap', counts: { live: 1, cap: 1 }, detail: 'glm' },
    { kind: 'team-spawn-cap', counts: { live: 5, cap: 5 } },
    { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, sessionIds: ['dev-1'], detail: '/repo/feat-x' },
    { kind: 'spawn-backoff', retryAt: '2026-10-13T12:00:30.000Z' },
    { kind: 'routing-hold', retryAt: '2026-10-13T12:10:00.000Z', detail: 'quota low' },
    { kind: 'all-profiles-cooling', retryAt: '2026-10-13T13:00:00.000Z' },
    { kind: 'group-missing' },
    { kind: 'starting-agent', reservation: { group: 'devs', profile: 'glm', worktree: '/repo/feat-x', startedAt: '2026-10-13T11:59:00.000Z' } },
  ]
  expect(new Set(constraints.map(constraint => constraint.kind)).size).toBe(15)
  const reason: WaitingReason = { blocker: constraints[0]!, others: constraints.slice(1) }
  expect(reason.blocker.kind).toBe('recipient-busy')
  expect(reason.others).toHaveLength(14)
})

test('the snapshot accepts the new optional fields and stays compatible without them', () => {
  const withFields: Extract<ServerMessage, { type: 'team-mailbox-snapshot' }> = {
    type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [],
    waiting: { m1: { blocker: { kind: 'group-cap', counts: { live: 2, cap: 2 } }, others: [] } },
    worktrees: [{ worktree: '/repo', sessions: [{ sessionId: 'dev', group: 'devs', profile: 'default', status: 'waiting', spawned: false, taskId: null }], pendingSpawns: [] }],
  }
  // An older payload (no `waiting`, no `worktrees`) is still a valid snapshot.
  const legacy: Extract<ServerMessage, { type: 'team-mailbox-snapshot' }> = {
    type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [],
  }
  expect(withFields.waiting!.m1!.blocker.kind).toBe('group-cap')
  expect(legacy.waiting).toBeUndefined()
  expect(legacy.worktrees).toBeUndefined()
})

test('known dead-letter codes read as sentences and unknown codes pass through', () => {
  expect(deadLetterLabel('worktree-missing: /repo/feat-x')).toBe('The target worktree is missing')
  expect(deadLetterLabel('killed-recipient')).toBe('The recipient session no longer exists')
  expect(deadLetterLabel('killed-sender-without-group')).toBe('The sender session no longer exists and has no group')
  expect(deadLetterLabel('context-exhausted')).toBe("The recipient's context was exhausted; the message was not processed")
  expect(deadLetterLabel('hop-limit')).toBe('The reply chain reached its hop limit')
  expect(deadLetterLabel('some-future-code')).toBe('some-future-code')
  expect(deadLetterLabel('worktree-missing: /gone')).toBe('The target worktree is missing')
})

test('constraint labels mention their counts, names, and details', () => {
  expect(constraintLabel({ kind: 'group-cap', counts: { live: 2, cap: 2 } })).toContain('2/2')
  expect(constraintLabel({ kind: 'worktree-occupied', detail: '/repo/feat-x', sessionIds: ['s1'] }, () => 'dev-1'))
    .toBe('Worktree /repo/feat-x is held by dev-1')
  expect(constraintLabel({ kind: 'worktree-occupied', detail: '/repo/feat-x' })).toBe('Worktree /repo/feat-x is held by a pending spawn')
  expect(constraintLabel({ kind: 'starting-agent', reservation: { group: 'devs', profile: 'glm', worktree: '/repo/feat-x', startedAt: 'now' } }))
    .toBe('Starting agent (devs, glm, feat-x)')
  expect(constraintLabel({ kind: 'recipient-unavailable', detail: 'no directory' })).toContain('no directory')
  expect(constraintLabel({ kind: 'startup-failed', detail: 'lost auth' })).toContain('lost auth')
  // The provider is named when its cooldown decided (providers-and-workers D15);
  // the label keeps today's text without the detail.
  const coolingUntil = new Date(Date.parse('2026-10-13T12:00:00.000Z')).toLocaleTimeString()
  expect(constraintLabel({ kind: 'profile-cooling', detail: 'zai', retryAt: '2026-10-13T12:00:00.000Z' }))
    .toBe(`Recipient's provider zai is cooling until ${coolingUntil}`)
  expect(constraintLabel({ kind: 'profile-cooling', retryAt: '2026-10-13T12:00:00.000Z' }))
    .toBe(`Recipient's provider is cooling until ${coolingUntil}`)
})

test('elapsed labels tick in minutes', () => {
  const now = Date.parse('2026-10-13T12:01:30.000Z')
  expect(elapsedLabel('2026-10-13T12:00:00.000Z', now)).toBe('1m')
  expect(elapsedLabel('2026-10-13T12:01:30.000Z', now)).toBe('0m')
})

// Compile-time only: the snapshot type keeps both fields optional.
type Fields = keyof Snapshot
const waitingField: Fields = 'waiting'
const worktreesField: Fields = 'worktrees'
expect([waitingField, worktreesField]).toEqual(['waiting', 'worktrees'])

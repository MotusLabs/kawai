// The shared team workspace model (team-workspace 1.1/3.3): attention item
// identity, the task-row filter's default exclusion of closed tasks, and the
// plan-supervision kinds and links (plan-supervision D13).
import { describe, expect, test } from 'bun:test'
import {
  attentionItemId,
  filterTeamTaskRows,
  type AttentionItem,
  type AttentionKind,
  type AttentionLink,
  type TeamTaskRow,
} from '../teamWorkspace'

const row = (overrides: Partial<TeamTaskRow> = {}): TeamTaskRow => ({
  id: 'task-1',
  title: 'Implement workspace',
  status: 'open',
  stage: 'unstarted',
  accountable: null,
  groupId: null,
  worktree: null,
  waitingReason: null,
  needsReevaluation: false,
  acknowledgement: null,
  nextAction: null,
  requiresHuman: false,
  ...overrides,
})

describe('attentionItemId', () => {
  test('is kind-prefixed over the source id (D5)', () => {
    expect(attentionItemId('approval', 'chat-1:req-9')).toBe('approval:chat-1:req-9')
    expect(attentionItemId('uncertain-delivery', 'msg-3')).toBe('uncertain-delivery:msg-3')
    // A Wave C kind typed as a plain string still forms the same shape.
    expect(attentionItemId('plan-hold', 'plan-2')).toBe('plan-hold:plan-2')
  })

  test('the six plan kinds (plan-supervision D13) are members and form their ids', () => {
    // Typed as the union: removing a member from AttentionKind fails the typecheck.
    const kinds: AttentionKind[] = ['plan-stop', 'plan-stall', 'decision-question', 'plan-fix', 'plan-condition', 'plan-promotion']
    expect(kinds.map(kind => attentionItemId(kind, 'x'))).toEqual([
      'plan-stop:x', 'plan-stall:x', 'decision-question:x', 'plan-fix:x', 'plan-condition:x', 'plan-promotion:x',
    ])
  })
})

describe('AttentionLink.plan (plan-supervision D13)', () => {
  test('a plan link names its plan and change; a card link carries its planId', () => {
    // Typed as the union: dropping `plan` or the optional fields fails the typecheck.
    const links: AttentionLink[] = [
      { kind: 'plan', id: 'plan-1', planId: 'plan-1', change: 'api' },
      { kind: 'plan', id: 'plan-1', planId: 'plan-1' },
      { kind: 'card', id: 'card-9', planId: 'plan-1' },
    ]
    expect(links.map(link => `${link.kind}:${link.id}:${link.planId ?? ''}:${link.change ?? ''}`)).toEqual([
      'plan:plan-1:plan-1:api', 'plan:plan-1:plan-1:', 'card:card-9:plan-1:',
    ])
  })

  test('a plan item carries its link whole (compile-time shape over the item contract)', () => {
    const item: AttentionItem = {
      id: 'plan-stop:exec-1:api:0', kind: 'plan-stop', cause: 'Change api stopped',
      owner: { kind: 'human', id: null, label: 'Human' }, impact: {},
      nextAction: 'Retry or stop execution',
      link: { kind: 'plan', id: 'plan-1', planId: 'plan-1', change: 'api' },
      requiresHuman: true,
    }
    expect(item.link.kind).toBe('plan')
    expect(item.link.planId).toBe('plan-1')
    expect(item.link.change).toBe('api')
  })
})

describe('filterTeamTaskRows', () => {
  const rows = [
    row(),
    row({ id: 'task-2', title: 'Blocked thing', status: 'blocked', requiresHuman: true, groupId: 'devs' }),
    row({ id: 'task-3', title: 'Shipped thing', status: 'done', stage: null }),
    row({ id: 'task-4', title: 'Dropped thing', status: 'cancelled', stage: null }),
    row({ id: 'task-5', title: 'In review soon', stage: 'awaiting-acceptance', worktree: '/wt' }),
  ]

  test('closed tasks are absent by default and found by search', () => {
    expect(filterTeamTaskRows(rows).map(r => r.id)).toEqual(['task-1', 'task-2', 'task-5'])
    expect(filterTeamTaskRows(rows, { search: 'shipped' }).map(r => r.id)).toEqual(['task-3'])
    // Search matches open rows too, case-insensitively.
    expect(filterTeamTaskRows(rows, { search: 'BLOCKED' }).map(r => r.id)).toEqual(['task-2'])
  })

  test('includeClosed keeps closed rows for a host whose own search is active', () => {
    expect(filterTeamTaskRows(rows, { includeClosed: true }).map(r => r.id)).toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-5'])
  })

  test('an explicit status filter surfaces that status, closed or not', () => {
    expect(filterTeamTaskRows(rows, { status: 'done' }).map(r => r.id)).toEqual(['task-3'])
    expect(filterTeamTaskRows(rows, { status: 'blocked' }).map(r => r.id)).toEqual(['task-2'])
  })

  test('awaiting-human, awaiting-acceptance, group, and worktree filters narrow', () => {
    expect(filterTeamTaskRows(rows, { awaitingHuman: true }).map(r => r.id)).toEqual(['task-2'])
    expect(filterTeamTaskRows(rows, { awaitingAcceptance: true }).map(r => r.id)).toEqual(['task-5'])
    expect(filterTeamTaskRows(rows, { groupId: 'devs' }).map(r => r.id)).toEqual(['task-2'])
    expect(filterTeamTaskRows(rows, { worktree: '/wt' }).map(r => r.id)).toEqual(['task-5'])
    expect(filterTeamTaskRows(rows, { worktree: null }).map(r => r.id)).toEqual(['task-1', 'task-2'])
  })
})

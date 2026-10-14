// The client half of Messages text search (team-workspace-pages D7): change
// pushes are unfiltered, so the store re-applies the view's filters with the
// same match the server's SQL makes, and a row outside the search is dropped.
import { describe, expect, test } from 'bun:test'
import { matchesMessageFilters, matchesMessageText, messageSearchText, type TeamMessage } from '../team'

const message = (extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead',
  fromGroup: 'leads', originPath: '/repo', priority: 'normal', tags: [], threadId: 'th', inReplyTo: null,
  hop: 1, body: 'Please review the strategy page', state: 'queued', claimedBy: null, claimedAt: null, deliverAt: null,
  createdAt: '2026-10-14T10:00:00.000Z', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: null, taskRevision: null, claimCommit: null,
  parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
  ...extra,
})

describe('message text search', () => {
  test('a push inside the search is kept, one outside it is dropped', () => {
    expect(matchesMessageFilters({ text: 'strategy' }, message())).toBe(true)
    expect(matchesMessageFilters({ text: 'mailbox' }, message())).toBe(false)
  })

  test('combines with the other filters', () => {
    expect(matchesMessageFilters({ text: 'review', priority: 'urgent' }, message())).toBe(false)
    expect(matchesMessageFilters({ text: 'review', priority: 'urgent' }, message({ priority: 'urgent' }))).toBe(true)
  })

  test('is ASCII case-insensitive, like SQLite LIKE', () => {
    expect(matchesMessageText('STRATEGY PAGE', message())).toBe(true)
    expect(matchesMessageText('100%', message({ body: 'at 100% now' }))).toBe(true)
  })

  test('matches group ids on either side and participant names through the caller’s labels', () => {
    expect(matchesMessageText('leads', message({ body: 'x' }))).toBe(true)
    expect(matchesMessageText('devs', message({ body: 'x', fromGroup: null }))).toBe(true)
    // A session recipient's id is not a group id.
    expect(matchesMessageText('dev-1', message({ body: 'x', fromGroup: null, toKind: 'session', toId: 'dev-1' }))).toBe(false)
    const labels = new Map([['dev-1', 'Strategy UI dev'], ['lead', 'Team lead']])
    const labelOf = (id: string) => labels.get(id)
    expect(matchesMessageText('ui dev', message({ body: 'x', fromGroup: null, toKind: 'session', toId: 'dev-1' }), labelOf)).toBe(true)
    expect(matchesMessageText('team lead', message({ body: 'x' }), labelOf)).toBe(true)
    expect(matchesMessageText('ui dev', message({ body: 'x', claimedBy: 'dev-1' }), labelOf)).toBe(true)
  })

  test('the human side matches Human', () => {
    expect(matchesMessageText('human', message({ body: 'x', fromKind: 'human', fromSession: null, fromGroup: null }))).toBe(true)
    expect(matchesMessageText('human', message({ body: 'x' }))).toBe(false)
  })

  test('blank text keeps everything', () => {
    expect(messageSearchText({ text: '  ' })).toBeNull()
    expect(matchesMessageFilters({ text: '  ' }, message())).toBe(true)
  })
})

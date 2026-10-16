import { describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { searchActiveSessions, type SearchSource } from '../chat/sessionSearchWalker'

const user = (id: string, text: string, at: string): ChatEvent =>
  ({ id, sequence: 0, at, turnId: 't', type: 'user_message', text })

interface FakeSession {
  name?: string
  lastActivityAt?: string
  events?: ChatEvent[]
  readable?: boolean
  throws?: boolean
}

function source(sessions: Record<string, FakeSession>, onRead?: (id: string) => Promise<void> | void): SearchSource {
  return {
    activeRecords: () => Object.entries(sessions).map(([sessionId, s]) => ({
      sessionId, name: s.name ?? sessionId, projectPath: `/work/${sessionId}`,
      lastActivityAt: s.lastActivityAt ?? '2026-10-01T00:00:00.000Z',
    })),
    searchableEvents: async id => {
      await onRead?.(id)
      const s = sessions[id]!
      if (s.throws) throw new Error('boom')
      return { events: s.events ?? [], readable: s.readable ?? true }
    },
  }
}

describe('searchActiveSessions', () => {
  test('groups matches per session, newest match first', async () => {
    const response = await searchActiveSessions(source({
      a: { events: [user('a1', 'see #147', '2026-10-15T08:00:00.000Z')] },
      b: { events: [user('b1', 'see #147', '2026-10-15T09:50:00.000Z')] },
      c: { events: [user('c1', 'unrelated', '2026-10-15T09:55:00.000Z')] },
    }), '#147')
    expect(response.query).toBe('#147')
    expect(response.results.map(r => r.sessionId)).toEqual(['b', 'a'])
    expect(response.results[0]).toMatchObject({
      matchCount: 1, nameMatch: false, projectPath: '/work/b', lastMatchAt: '2026-10-15T09:50:00.000Z',
    })
    expect(response.truncated).toBe(false)
    expect(response.unsearchable).toBe(0)
  })

  test('a name-only match has no snippets and sorts by the session activity time', async () => {
    const response = await searchActiveSessions(source({
      named: { name: 'PR 147 review', lastActivityAt: '2026-10-10T00:00:00.000Z' },
      body: { events: [user('x', 'PR 147 landed', '2026-10-12T00:00:00.000Z')] },
    }), 'pr 147')
    expect(response.results.map(r => r.sessionId)).toEqual(['body', 'named'])
    expect(response.results[1]).toMatchObject({
      nameMatch: true, matchCount: 0, snippets: [], lastMatchAt: '2026-10-10T00:00:00.000Z',
    })
  })

  test('a name and content match reports both', async () => {
    const response = await searchActiveSessions(source({
      both: { name: 'pr 147', events: [user('e', 'PR 147', '2026-10-12T00:00:00.000Z')] },
    }), 'PR 147')
    expect(response.results[0]).toMatchObject({ nameMatch: true, matchCount: 1 })
  })

  test('ties sort by name', async () => {
    const at = '2026-10-12T00:00:00.000Z'
    const response = await searchActiveSessions(source({
      zed: { name: 'zed', events: [user('z', 'needle', at)] },
      alpha: { name: 'alpha', events: [user('a', 'needle', at)] },
    }), 'needle')
    expect(response.results.map(r => r.name)).toEqual(['alpha', 'zed'])
  })

  test('caps at 50 sessions and says so', async () => {
    const sessions: Record<string, FakeSession> = {}
    for (let i = 0; i < 53; i++) {
      sessions[`s${String(i).padStart(2, '0')}`] = {
        events: [user(`e${i}`, 'needle', new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())],
      }
    }
    const response = await searchActiveSessions(source(sessions), 'needle')
    expect(response.results).toHaveLength(50)
    expect(response.truncated).toBe(true)
    // The three oldest dropped.
    expect(response.results.at(-1)!.sessionId).toBe('s03')
  })

  test('exactly 50 matches is not truncated', async () => {
    const sessions: Record<string, FakeSession> = {}
    for (let i = 0; i < 50; i++) sessions[`s${i}`] = { events: [user(`e${i}`, 'needle', '2026-10-01T00:00:00.000Z')] }
    const response = await searchActiveSessions(source(sessions), 'needle')
    expect(response.results).toHaveLength(50)
    expect(response.truncated).toBe(false)
  })

  test('counts unreadable and failing sessions but still searches the rest and the names', async () => {
    const response = await searchActiveSessions(source({
      lost: { name: 'needle notes', readable: false },
      broken: { throws: true },
      fine: { events: [user('f', 'needle', '2026-10-12T00:00:00.000Z')] },
    }), 'needle')
    expect(response.unsearchable).toBe(2)
    expect(response.results.map(r => r.sessionId).sort()).toEqual(['fine', 'lost'])
  })

  test('reads at most four sessions at once', async () => {
    let active = 0
    let peak = 0
    const sessions: Record<string, FakeSession> = {}
    for (let i = 0; i < 12; i++) sessions[`s${i}`] = {}
    await searchActiveSessions(source(sessions, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
    }), 'needle')
    expect(peak).toBe(4)
  })

  test('no sessions, no results', async () => {
    expect(await searchActiveSessions(source({}), 'needle')).toEqual({
      query: 'needle', results: [], truncated: false, unsearchable: 0,
    })
  })
})

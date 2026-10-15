import { describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import type { SessionSearchResponse } from '../../shared/sessionSearch'
import { createChatSearchRoutes } from '../routes/chatSearch'
import type { SearchSource } from '../chat/sessionSearchWalker'

const event: ChatEvent = {
  id: 'e1', sequence: 0, at: '2026-10-15T09:00:00.000Z', turnId: 't', type: 'user_message',
  text: 'opened https://github.com/acme/app/pull/147',
}
const source: SearchSource = {
  activeRecords: () => [{ sessionId: 's1', name: 'dev', projectPath: '/work/dev', lastActivityAt: '2026-10-15T09:00:00.000Z' }],
  searchableEvents: async () => ({ events: [event], readable: true }),
}
const routes = createChatSearchRoutes({ source })

describe('GET /api/chat/search', () => {
  test('returns grouped results for a searchable query', async () => {
    const response = await routes.request(`/?q=${encodeURIComponent(' pull/147 ')}`)
    expect(response.status).toBe(200)
    const body = await response.json() as SessionSearchResponse
    expect(body.query).toBe('pull/147')
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ sessionId: 's1', matchCount: 1 })
  })

  test('refuses a missing, too-short, or too-long query with 400', async () => {
    for (const q of ['', '/?q=', '/?q=a', '/?q=%20a%20', `/?q=${'x'.repeat(201)}`]) {
      const response = await routes.request(q === '' ? '/' : q)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Query must be 2 to 200 characters.' })
    }
  })
})

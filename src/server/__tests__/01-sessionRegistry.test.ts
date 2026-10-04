import { describe, expect, test } from 'bun:test'
import { SessionRegistry } from '../SessionRegistry'
import type { AgentSession, Session } from '../../shared/types'

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/Users/example/project',
  status: 'waiting',
  lastActivity: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  source: 'managed',
}

const baseAgentSession: AgentSession = {
  sessionId: 'agent-1',
  logFilePath: '/tmp/agent-1.jsonl',
  projectPath: '/tmp/project',
  agentType: 'claude',
  displayName: 'alpha',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: true,
  isPinned: false,
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return { ...baseSession, ...overrides }
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return { ...baseAgentSession, ...overrides }
}

describe('SessionRegistry', () => {
  test('replaceSessions keeps latest activity and emits removals', () => {
    const registry = new SessionRegistry()
    const sessionsEvents: Session[][] = []
    const removedIds: string[] = []

    registry.on('sessions', (sessions) => sessionsEvents.push(sessions))
    registry.on('session-removed', (sessionId) => removedIds.push(sessionId))

    const latest = makeSession({
      id: 'alpha',
      lastActivity: new Date('2024-02-02T00:00:00.000Z').toISOString(),
    })
    const toRemove = makeSession({
      id: 'bravo',
      lastActivity: new Date('2024-02-01T00:00:00.000Z').toISOString(),
    })

    registry.replaceSessions([latest, toRemove])

    const olderUpdate = makeSession({
      id: 'alpha',
      lastActivity: new Date('2023-01-01T00:00:00.000Z').toISOString(),
    })
    registry.replaceSessions([olderUpdate])

    const stored = registry.get('alpha')
    expect(stored?.lastActivity).toBe(latest.lastActivity)
    expect(removedIds).toEqual(['bravo'])
    expect(sessionsEvents).toHaveLength(2)
  })

  test('updateSession merges updates and emits event', () => {
    const registry = new SessionRegistry()
    const updates: Session[] = []
    registry.on('session-update', (session) => updates.push(session))

    const session = makeSession({ id: 'delta', name: 'delta' })
    registry.replaceSessions([session])

    const result = registry.updateSession('delta', {
      status: 'working',
      name: 'renamed',
    })

    expect(result?.status).toBe('working')
    expect(registry.get('delta')?.name).toBe('renamed')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.name).toBe('renamed')
  })

  test('updateSession returns undefined when missing', () => {
    const registry = new SessionRegistry()
    const updates: Session[] = []
    registry.on('session-update', (session) => updates.push(session))

    const result = registry.updateSession('missing', { status: 'working' })
    expect(result).toBeUndefined()
    expect(updates).toHaveLength(0)
  })

	  test('replaceSessions skips session emit when data is unchanged', () => {
	    const registry = new SessionRegistry()
	    const sessionsEvents: Session[][] = []

    registry.on('sessions', (sessions) => sessionsEvents.push(sessions))

    const session = makeSession({ id: 'alpha' })
    registry.replaceSessions([session])
    registry.replaceSessions([session])

	    expect(sessionsEvents).toHaveLength(1)
	  })

	  test('replaceSessions emits when window ownership fields change', () => {
	    const registry = new SessionRegistry()
	    const sessionsEvents: Session[][] = []

	    registry.on('sessions', (sessions) => sessionsEvents.push(sessions))

	    const session = makeSession({ id: 'alpha' })
	    registry.replaceSessions([session])
	    sessionsEvents.length = 0

	    registry.replaceSessions([
	      makeSession({
	        id: 'alpha',
	        tmuxWindow: 'agentboard:2',
	        source: 'external',
	      }),
	    ])

	    expect(sessionsEvents).toHaveLength(1)
	    expect(sessionsEvents[0][0]).toMatchObject({
	      id: 'alpha',
	      tmuxWindow: 'agentboard:2',
	      source: 'external',
	    })
	  })

	  test('setAgentSessions emits only agent-sessions-active when only active sessions change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const history = [makeAgentSession({ sessionId: 'old', isActive: false })]

    // Initial set: both change from empty defaults
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a1' })],
      [],
      history
    )
    fullEvents.length = 0
    activeEvents.length = 0

    // Change only active sessions, keep history identical
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a2' })],
      [],
      history
    )

    expect(activeEvents).toHaveLength(1)
    expect(activeEvents[0][0].sessionId).toBe('a2')
    expect(fullEvents).toHaveLength(0)
  })

  test('setAgentSessions emits only agent-sessions when only history sessions change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const active = [makeAgentSession({ sessionId: 'a1' })]

    // Initial set
    registry.setAgentSessions(
      active,
      [],
      [makeAgentSession({ sessionId: 'old', isActive: false })]
    )
    fullEvents.length = 0
    activeEvents.length = 0

    // Change only history sessions, keep active identical
    registry.setAgentSessions(
      active,
      [],
      [makeAgentSession({ sessionId: 'new-history', isActive: false })]
    )

    expect(fullEvents).toHaveLength(1)
    expect(fullEvents[0].history[0].sessionId).toBe('new-history')
    // active did not change, so no active-only event
    expect(activeEvents).toHaveLength(0)
  })

  test('setAgentSessions emits both events when both active and history change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    // Initial set
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a1' })],
      [],
      [makeAgentSession({ sessionId: 'i1', isActive: false })]
    )
    fullEvents.length = 0
    activeEvents.length = 0

    // Change both active and history
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a2' })],
      [],
      [makeAgentSession({ sessionId: 'i2', isActive: false })]
    )

    expect(activeEvents).toHaveLength(1)
    expect(activeEvents[0][0].sessionId).toBe('a2')
    expect(fullEvents).toHaveLength(1)
    expect(fullEvents[0].active[0].sessionId).toBe('a2')
    expect(fullEvents[0].history[0].sessionId).toBe('i2')
  })

  test('setAgentSessions emits nothing when nothing changes', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const active = [makeAgentSession({ sessionId: 'a1' })]
    const history = [makeAgentSession({ sessionId: 'i1', isActive: false })]

    // Initial set
    registry.setAgentSessions(active, [], history)
    fullEvents.length = 0
    activeEvents.length = 0

    // Same data again
    registry.setAgentSessions(
      [makeAgentSession({ sessionId: 'a1' })],
      [],
      [makeAgentSession({ sessionId: 'i1', isActive: false })]
    )

    expect(activeEvents).toHaveLength(0)
    expect(fullEvents).toHaveLength(0)
  })

  test('setAgentSessions emits full payload when hibernating sessions change', () => {
    const registry = new SessionRegistry()
    const fullEvents: Array<{
      active: AgentSession[]
      hibernating: AgentSession[]
      history: AgentSession[]
    }> = []
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions', (payload) => fullEvents.push(payload))
    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const active = [makeAgentSession({ sessionId: 'a1' })]
    const hibernating = [makeAgentSession({ sessionId: 's1', isActive: false, isPinned: true })]
    registry.setAgentSessions(active, hibernating, [])
    fullEvents.length = 0
    activeEvents.length = 0

    registry.setAgentSessions(
      active,
      [makeAgentSession({ sessionId: 's2', isActive: false, isPinned: true })],
      []
    )

    expect(activeEvents).toHaveLength(0)
    expect(fullEvents).toHaveLength(1)
    expect(fullEvents[0].hibernating[0]?.sessionId).toBe('s2')
  })

  test('agentSessionsEqual correctly compares all 12 fields of AgentSession', () => {
    const registry = new SessionRegistry()
    const activeEvents: AgentSession[][] = []

    registry.on('agent-sessions-active', (active) => activeEvents.push(active))

    const base = makeAgentSession({
      sessionId: 'cmp',
      logFilePath: '/tmp/cmp.jsonl',
      projectPath: '/tmp/proj',
      agentType: 'claude',
      displayName: 'compare',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastActivityAt: '2024-01-01T00:00:00.000Z',
      isActive: true,
      host: 'host-1',
      lastUserMessage: 'hello',
      isPinned: false,
      lastResumeError: undefined,
    })

    // Establish baseline
    registry.setAgentSessions([base], [], [])
    activeEvents.length = 0

    // Identical copy should NOT emit
    registry.setAgentSessions([{ ...base }], [], [])
    expect(activeEvents).toHaveLength(0)

    // Each field change should emit. Test all 12 fields one at a time.
    const fieldChanges: Array<Partial<AgentSession>> = [
      { sessionId: 'cmp-changed' },
      { logFilePath: '/tmp/other.jsonl' },
      { projectPath: '/tmp/other' },
      { agentType: 'codex' },
      { displayName: 'renamed' },
      { createdAt: '2025-01-01T00:00:00.000Z' },
      { lastActivityAt: '2025-01-01T00:00:00.000Z' },
      { isActive: false },
      { host: 'host-2' },
      { lastUserMessage: 'changed' },
      { isPinned: true },
      { lastResumeError: 'error occurred' },
    ]

    for (const change of fieldChanges) {
      // Reset to baseline
      registry.setAgentSessions([base], [], [])
      activeEvents.length = 0

      // Apply single field change
      registry.setAgentSessions([{ ...base, ...change }], [], [])
      expect(activeEvents).toHaveLength(1)
    }
  })

  describe('quantized broadcast change detection (D5)', () => {
    const t0 = new Date('2024-06-01T00:00:10.000Z').toISOString()
    const inBucket = new Date('2024-06-01T00:00:25.000Z').toISOString()
    const nextBucket = new Date('2024-06-01T00:00:45.000Z').toISOString()

    function trackSessions(registry: SessionRegistry) {
      const events: Session[][] = []
      registry.on('sessions', (sessions) => events.push(sessions))
      return events
    }

    test('sub-quantum activity churn produces no broadcast', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      registry.replaceSessions([makeSession({ lastActivity: t0 })])
      expect(events).toHaveLength(1)

      registry.replaceSessions([makeSession({ lastActivity: inBucket })])
      expect(events).toHaveLength(1) // same 30s bucket, nothing else changed
    })

    test('activity crossing into a new bucket broadcasts', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      registry.replaceSessions([makeSession({ lastActivity: t0 })])
      events.length = 0

      registry.replaceSessions([makeSession({ lastActivity: nextBucket })])
      expect(events).toHaveLength(1)
      expect(events[0][0].lastActivity).toBe(nextBucket)
    })

    test('status, name, and membership changes still broadcast', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      registry.replaceSessions([makeSession({ lastActivity: t0 })])
      events.length = 0

      registry.replaceSessions([
        makeSession({ lastActivity: inBucket, status: 'working' }),
      ])
      expect(events).toHaveLength(1)

      registry.replaceSessions([
        makeSession({ lastActivity: inBucket, name: 'renamed' }),
      ])
      expect(events).toHaveLength(2)

      registry.replaceSessions([
        makeSession({ id: 'added', lastActivity: inBucket }),
        makeSession({ lastActivity: inBucket, name: 'renamed' }),
      ])
      expect(events).toHaveLength(3)

      registry.replaceSessions([
        makeSession({ lastActivity: inBucket, name: 'renamed' }),
      ])
      expect(events).toHaveLength(4) // membership removal broadcasts
    })

    test('stored activity never regresses and keeps precision without an emit', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      registry.replaceSessions([makeSession({ lastActivity: inBucket })])
      events.length = 0

      // An older incoming activity must not regress the stored value, and the
      // suppressed replacement must still retain the precise latest value.
      const older = new Date('2024-06-01T00:00:12.000Z').toISOString()
      registry.replaceSessions([makeSession({ lastActivity: older })])
      expect(events).toHaveLength(0)
      expect(registry.get('session-1')?.lastActivity).toBe(inBucket)

      // ...and that precise value ships in the next emitted payload when a
      // bucket crossing (or any other change) triggers a broadcast.
      registry.replaceSessions([makeSession({ lastActivity: nextBucket })])
      expect(events).toHaveLength(1)
      expect(events[0][0].lastActivity).toBe(nextBucket)

      // Sub-quantum advance under suppression: precise value stored, no emit.
      const later = new Date('2024-06-01T00:00:52.000Z').toISOString()
      registry.replaceSessions([makeSession({ lastActivity: later })])
      expect(events).toHaveLength(1)
      expect(registry.get('session-1')?.lastActivity).toBe(later)
    })

    test('equal-status sessions in one bucket retain precise recency when broadcast', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      const a = makeSession({ id: 'a', lastActivity: t0 })
      const b = makeSession({ id: 'b', lastActivity: inBucket })
      registry.replaceSessions([a, b])
      events.length = 0

      // Status change on a triggers a broadcast; both payloads carry precise
      // timestamps, preserving the client's precise activity sort order.
      registry.replaceSessions([
        { ...a, status: 'working' },
        b,
      ])
      expect(events).toHaveLength(1)
      const emitted = events[0].sort(
        (x, y) => Date.parse(y.lastActivity) - Date.parse(x.lastActivity)
      )
      expect(emitted.map((s) => s.id)).toEqual(['b', 'a'])
    })

    test('invalid timestamps keep raw comparison behavior', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      registry.replaceSessions([makeSession({ lastActivity: 'garbage' })])
      events.length = 0

      // Different invalid string is a change (raw comparison, as before).
      registry.replaceSessions([makeSession({ lastActivity: 'garbage~2' })])
      expect(events).toHaveLength(1)

      // Same invalid string is not.
      events.length = 0
      registry.replaceSessions([makeSession({ lastActivity: 'garbage~2' })])
      expect(events).toHaveLength(0)
    })

    test('createdAt is untouched by activity quantization', () => {
      const registry = new SessionRegistry()
      const events = trackSessions(registry)

      const created = new Date('2024-05-01T00:00:00.000Z').toISOString()
      registry.replaceSessions([makeSession({ createdAt: created, lastActivity: t0 })])
      events.length = 0

      registry.replaceSessions([makeSession({ lastActivity: inBucket })])
      expect(events).toHaveLength(0)
      expect(registry.get('session-1')?.createdAt).toBe(created)
    })

    test('Enter-path updateSession still emits immediately', () => {
      const registry = new SessionRegistry()
      registry.replaceSessions([makeSession({ lastActivity: t0 })])

      const updates: Session[] = []
      registry.on('session-update', (session) => updates.push(session))

      const enterActivity = new Date('2024-06-01T00:00:15.000Z').toISOString()
      registry.updateSession('session-1', {
        status: 'working',
        lastActivity: enterActivity,
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        status: 'working',
        lastActivity: enterActivity,
      })
    })
  })
})

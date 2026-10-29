// compact-observation-detail D1–D3 oracles on the chat tracker: table T1
// (event handling), table T2 (phase totals), and the seeded properties P1
// (phase conservation against a reference model of the pre-change per-segment
// rows) and P2 (one row per completed or closed call and request).
import { expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import type { StoredObservation } from '../../shared/processObservations'
import { schemaDb } from './schemaDb'
import { ProcessObservationService } from '../metrics/observations/service'

const origin = Date.parse('2026-10-18T00:00:00Z')
const iso = (second: number) => new Date(origin + second * 1000).toISOString()
const PHASES = ['thinkingSeconds', 'requestingSeconds', 'preparingToolSeconds', 'runningToolsSeconds', 'respondingSeconds', 'retryingSeconds', 'otherPhaseSeconds']

function harness() {
  const db = schemaDb()
  let now = origin, sequence = 0
  const identity = () => ({ teamId: 'team', sessionId: 'chat' })
  const service = new ProcessObservationService(db, identity, () => now)
  const time = (second: number) => { now = origin + second * 1000 }
  /** Emits a chat event; `id` repeats an earlier event's id (a duplicate delivery). */
  const emit = (data: Record<string, unknown>, second: number, id = `e${++sequence}`) => {
    time(second)
    service.chat.event('chat', { id, at: iso(second), turnId: 'turn', ...data } as ChatEvent)
    return id
  }
  const activity = (phase: string | null, second: number) => {
    time(second)
    service.chat.activity('chat', phase ? ({ phase } as never) : null)
  }
  const rows = (kind?: string): StoredObservation[] => service.store.forTeam('team', 0, 1000).filter(row => !kind || row.kind === kind)
  const live = () => {
    const row = db.prepare('SELECT state FROM process_live_observations').get() as { state: string } | null
    return row ? JSON.parse(row.state) : null
  }
  const restart = (second: number) => {
    const restarted = new ProcessObservationService(db, identity, () => origin + second * 1000)
    restarted.chat.recover()
  }
  return { db, service, emit, activity, rows, live, time, restart }
}
type Harness = ReturnType<typeof harness>

// ---- Table T1 -------------------------------------------------------------

const T1: { id: string; title: string; run: (h: Harness) => void }[] = [
  {
    id: 'E1', title: 'a tool call opens the live entry and stores nothing',
    run: h => {
      h.emit({ type: 'tool_call', toolCallId: 'a', tool: 'Bash' }, 1)
      expect(h.rows('tool')).toEqual([])
      expect(h.live().tools.a).toMatchObject({ at: iso(1), category: 'shell' })
    },
  },
  {
    id: 'E2', title: 'a duplicate tool call leaves the open entry unchanged',
    run: h => {
      h.emit({ type: 'tool_call', toolCallId: 'a', tool: 'Bash' }, 1)
      h.emit({ type: 'tool_call', toolCallId: 'a', tool: 'Bash' }, 2)
      expect(h.rows('tool')).toEqual([])
      expect(h.live().tools.a.at).toBe(iso(1))
    },
  },
  {
    id: 'E3', title: 'a tool result stores one row with start, duration and outcome',
    run: h => {
      h.emit({ type: 'tool_call', toolCallId: 'a', tool: 'Bash' }, 1)
      h.emit({ type: 'tool_result', toolCallId: 'a', isError: true }, 42)
      expect(h.rows('tool').map(row => [row.toolCallId, row.data])).toEqual([
        ['a', { category: 'shell', startedAt: iso(1), durationSeconds: 41, outcome: 'failed', partial: false }],
      ])
      expect(h.live().tools).toEqual({})
    },
  },
  {
    id: 'E4', title: 'a redelivered tool result stores nothing more',
    run: h => {
      h.emit({ type: 'tool_call', toolCallId: 'a', tool: 'Bash' }, 1)
      const id = h.emit({ type: 'tool_result', toolCallId: 'a' }, 3)
      h.emit({ type: 'tool_result', toolCallId: 'a' }, 3, id)
      expect(h.rows('tool')).toHaveLength(1)
    },
  },
  {
    id: 'E5', title: 'an approval or question request opens the entry and the wait',
    run: h => {
      h.emit({ type: 'approval_request', requestId: 'r1' }, 2)
      h.emit({ type: 'question_request', requestId: 'r2' }, 3)
      expect(h.rows('request')).toEqual([])
      expect(h.live()).toMatchObject({ waitStarted: iso(2), requests: { r1: { category: 'approval' }, r2: { category: 'question' } } })
    },
  },
  {
    id: 'E6', title: 'a matched resolution stores one request row with kind, start, wait and outcome',
    run: h => {
      h.emit({ type: 'question_request', requestId: 'r1' }, 1)
      h.emit({ type: 'request_resolved', requestId: 'r1', outcome: 'answered' }, 181)
      expect(h.rows('request').map(row => [row.requestId, row.data])).toEqual([
        ['r1', { requestKind: 'question', startedAt: iso(1), durationSeconds: 180, outcome: 'answered', partial: false }],
      ])
      expect(h.live().requests).toEqual({})
    },
  },
  {
    id: 'E7', title: 'an unmatched resolution is counted once and stores nothing',
    run: h => {
      h.emit({ type: 'request_resolved', requestId: 'auto-1', outcome: 'allowed' }, 1)
      h.emit({ type: 'request_resolved', requestId: 'auto-1', outcome: 'allowed' }, 1)
      h.emit({ type: 'request_resolved', requestId: 'auto-2', outcome: 'allowed' }, 2)
      expect(h.rows('request')).toEqual([])
      h.emit({ type: 'turn_completed', subtype: 'success' }, 3)
      expect(h.rows('turn_ended')[0]!.data.unmatchedResolutions).toBe(2)
    },
  },
  {
    id: 'E8', title: 'turn close writes open entries as partial rows, then the totals',
    run: h => {
      h.activity('thinking', 0)
      h.emit({ type: 'tool_call', toolCallId: 'a', tool: 'Read' }, 1)
      h.emit({ type: 'approval_request', requestId: 'r1' }, 2)
      h.emit({ type: 'request_resolved', requestId: 'auto', outcome: 'allowed' }, 3)
      h.emit({ type: 'turn_interrupted' }, 5)
      expect(h.rows('tool').map(row => row.data)).toEqual([
        { category: 'other', startedAt: iso(1), durationSeconds: 1, outcome: 'unavailable', partial: true },
      ])
      expect(h.rows('request').map(row => row.data)).toEqual([
        { requestKind: 'approval', startedAt: iso(2), durationSeconds: 3, outcome: 'unavailable', partial: true },
      ])
      expect(h.rows('turn_ended')[0]!.data).toMatchObject({ outcome: 'interrupted', thinkingSeconds: 2, unmatchedResolutions: 1 })
      expect(h.live()).toBeNull()
    },
  },
  {
    id: 'E9', title: 'a redelivered turn start stores nothing and writes no ledger key',
    run: h => {
      h.emit({ type: 'turn_started' }, 0, 'e-start')
      expect(h.rows('turn_started')).toHaveLength(1)
      expect(h.db.prepare('SELECT count(*) AS n FROM process_observation_keys').get()).toEqual({ n: 0 })
    },
  },
]

for (const row of T1) {
  // E3, E6, E7, E8 and E9 in turn:
  // @covers: process-observations › Tool calls and requests are stored once, at completion › One call, one row
  // @covers: process-observations › Tool calls and requests are stored once, at completion › Answered question
  // @covers: process-observations › Unmatched request resolutions are counted, not stored › Auto-approved tool
  // @covers: process-observations › Tool calls and requests are stored once, at completion › Call open at turn end
  // @covers: process-observations › Observation keys and team scope are stored once › Duplicate chat event
  test(`T1 ${row.id}: ${row.title}`, () => {
    const h = harness()
    h.emit({ type: 'turn_started' }, 0, 'e-start')
    row.run(h)
    h.db.close()
  })
}

// ---- Table T2 -------------------------------------------------------------

const T2: { id: string; run: (h: Harness) => Record<string, unknown> }[] = [
  {
    id: 'P-a',
    run: h => {
      h.activity('thinking', 0)
      h.activity('requesting', 2)
      h.activity('thinking', 5)
      h.emit({ type: 'turn_completed', subtype: 'success' }, 6)
      return { thinkingSeconds: 3, requestingSeconds: 3, respondingSeconds: 0, otherPhaseSeconds: 0, partial: false }
    },
  },
  {
    id: 'P-b',
    run: h => {
      h.activity('running_tools', 1)
      h.emit({ type: 'turn_interrupted' }, 5)
      return { runningToolsSeconds: 4, outcome: 'interrupted', partial: false }
    },
  },
  {
    id: 'P-c',
    run: h => {
      h.activity('thinking', 0)
      h.time(20)
      h.service.chat.checkpoint()
      h.restart(500)
      expect(h.rows('gap')[0]!.data).toMatchObject({ since: iso(20), until: iso(500), source: 'managed-turn' })
      return { thinkingSeconds: 20, outcome: 'process-ended', partial: true }
    },
  },
  {
    id: 'P-d',
    run: h => {
      h.activity('foo', 0)
      h.emit({ type: 'turn_completed', subtype: 'success' }, 2)
      return { otherPhaseSeconds: 2, thinkingSeconds: 0 }
    },
  },
  {
    id: 'P-e',
    run: h => {
      h.activity('thinking', 0)
      h.emit({ type: 'approval_request', requestId: 'r1' }, 2)
      h.activity('responding', 3)
      h.emit({ type: 'request_resolved', requestId: 'r1', outcome: 'allowed' }, 10)
      h.activity('responding', 10)
      h.emit({ type: 'turn_completed', subtype: 'success' }, 12)
      return { thinkingSeconds: 2, respondingSeconds: 2 }
    },
  },
]

for (const row of T2) {
  // @covers: process-observations › Turn activity is recorded as per-turn phase totals › Restart mid-turn
  test(`T2 ${row.id}: phase totals land on turn_ended`, () => {
    const h = harness()
    h.emit({ type: 'turn_started' }, 0)
    const expected = row.run(h)
    expect(h.rows('turn_ended')).toHaveLength(1)
    expect(h.rows('turn_ended')[0]!.data).toMatchObject(expected)
    expect(h.rows('activity')).toEqual([])
    h.db.close()
  })
}

// @covers: process-observations › Turn activity is recorded as per-turn phase totals › Turn with many phase changes
test('seventy phase changes store one turn end and no per-segment rows', () => {
  const h = harness()
  h.emit({ type: 'turn_started' }, 0)
  const phases = ['thinking', 'requesting', 'running_tools']
  for (let i = 0; i < 70; i++) h.activity(phases[i % 3]!, i)
  h.emit({ type: 'turn_completed', subtype: 'success' }, 70)
  expect(h.rows().map(row => row.kind)).toEqual(['turn_started', 'turn_ended'])
  const data = h.rows('turn_ended')[0]!.data
  expect(PHASES.reduce((sum, field) => sum + Number(data[field]), 0)).toBe(70)
  expect([data.thinkingSeconds, data.requestingSeconds, data.runningToolsSeconds]).toEqual([24, 23, 23])
  h.db.close()
})

// ---- Properties P1, P2 ----------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIELD: Record<string, string> = {
  thinking: 'thinkingSeconds', requesting: 'requestingSeconds', preparing_tool: 'preparingToolSeconds',
  running_tools: 'runningToolsSeconds', responding: 'respondingSeconds', retrying: 'retryingSeconds',
}
const ALL_PHASES = [...Object.keys(FIELD), 'foo']

interface Expected { phaseSeconds: number; tools: number; requests: number; unmatched: number }

/**
 * Drives one random turn through the tracker while a reference model sums the
 * durations the pre-change `closePhase` wrote as activity rows: a phase closes
 * at the next activity, at a request opening, or at turn close, and every
 * resolution (matched or not) drops the open phase without charging it.
 */
function randomTurn(h: Harness, random: () => number): Expected {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  let second = 0, lastId = '', lastData: Record<string, unknown> = {}
  let phase: { at: number; name: string } | null = null
  let phaseSeconds = 0, toolRows = 0, requestRows = 0, nextTool = 0, nextRequest = 0
  const openTools = new Set<string>(), openRequests = new Set<string>(), orphans = new Set<string>()
  const close = (at: number) => { if (phase) phaseSeconds += at - phase.at; phase = null }
  const emit = (data: Record<string, unknown>) => { lastData = data; lastId = h.emit(data, second) }
  h.emit({ type: 'turn_started' }, 0)
  const steps = 1 + Math.floor(random() * 40)
  for (let step = 0; step < steps; step++) {
    second += Math.floor(random() * 5) + (random() < 0.5 ? 0.25 : 0)
    const choice = random()
    if (choice < 0.3) {
      const name = random() < 0.1 ? null : pick(ALL_PHASES)
      close(second)
      if (name && openRequests.size === 0) phase = { at: second, name }
      h.activity(name, second)
    } else if (choice < 0.45) {
      const id = `t${++nextTool}`
      openTools.add(id)
      emit({ type: 'tool_call', toolCallId: id, tool: pick(['Bash', 'Read', 'Edit', 'mcp__x']) })
    } else if (choice < 0.6) {
      const id = openTools.size && random() < 0.85 ? pick([...openTools]) : `orphan-t${++nextTool}`
      openTools.delete(id)
      toolRows++
      emit({ type: 'tool_result', toolCallId: id, isError: random() < 0.2 })
    } else if (choice < 0.7) {
      const id = `r${++nextRequest}`
      close(second)
      openRequests.add(id)
      emit({ type: pick(['approval_request', 'question_request']), requestId: id })
    } else if (choice < 0.85) {
      const matched = openRequests.size > 0 && random() < 0.6
      const id = matched ? pick([...openRequests]) : `auto${++nextRequest}`
      if (matched) { openRequests.delete(id); requestRows++ } else orphans.add(id)
      phase = null
      emit({ type: 'request_resolved', requestId: id, outcome: 'allowed' })
    } else if (lastId) {
      // A redelivery of the previous event: same id, same payload.
      h.emit(lastData, second, lastId)
    }
  }
  second += 1
  const end = random()
  if (end < 0.2) {
    h.time(second)
    h.service.chat.checkpoint()
    close(second)
    h.restart(second + 100)
  } else {
    close(second)
    h.emit(end < 0.6 ? { type: 'turn_completed', subtype: 'success' } : { type: 'turn_interrupted' }, second)
  }
  return { phaseSeconds, tools: toolRows + openTools.size, requests: requestRows + openRequests.size, unmatched: orphans.size }
}

test('P1: phase totals conserve the time the per-segment rows recorded (seed 20261029, 300 cases)', () => {
  const random = mulberry32(20261029)
  for (let run = 0; run < 300; run++) {
    const h = harness()
    const expected = randomTurn(h, random)
    const data = h.rows('turn_ended')[0]!.data
    const total = PHASES.reduce((sum, field) => sum + Number(data[field]), 0)
    expect([run, Math.round(total * 1000)]).toEqual([run, Math.round(expected.phaseSeconds * 1000)])
    expect(h.rows('activity')).toEqual([])
    h.db.close()
  }
})

test('P2: one stored row per completed or closed call and request (seed 20261030, 300 cases)', () => {
  const random = mulberry32(20261030)
  for (let run = 0; run < 300; run++) {
    const h = harness()
    const expected = randomTurn(h, random)
    const tools = h.rows('tool'), requests = h.rows('request')
    expect([run, tools.length, requests.length]).toEqual([run, expected.tools, expected.requests])
    expect([...tools, ...requests].filter(row => row.data.outcome === undefined)).toEqual([])
    expect(requests.filter(row => row.data.requestKind === 'unknown')).toEqual([])
    expect([run, h.rows('turn_ended')[0]!.data.unmatchedResolutions]).toEqual([run, expected.unmatched])
    h.db.close()
  }
})

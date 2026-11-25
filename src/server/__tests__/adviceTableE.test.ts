// @reads: openspec/changes/process-quota-history-and-incident-advice/design.md
// Table E (process-quota-history-and-incident-advice D4): alternatives frozen
// at an incident cutoff. Each row records its incident through the
// production LimitEventStore (or the context flag hook), which ManagerAdvice
// snapshots and evaluates through the production queue, evaluator and
// stores; the row reads the stored assessment back. Row text is checked
// against design.md (V1).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { adviceHarness, MIN, recommendations, T0, type AdviceHarness } from './helpers/adviceHarness'

const DESIGN = path.join(import.meta.dir, '../../../openspec/changes/process-quota-history-and-incident-advice/design.md')

let h!: AdviceHarness
let live = false
afterEach(() => {
  if (!live) return
  live = false
  h.close()
})

/** glm (limited, on zai), glm-flash (zai), kimi (moon), each with its own account scope. */
function team(): void {
  h.workers = [{ model: 'glm', provider: 'zai', live: 1 }, { model: 'glm-flash', provider: 'zai' }, { model: 'kimi', provider: 'moon' }]
  h.scopes = { glm: 'scope-zai', 'glm-flash': 'scope-zai', kimi: 'scope-moon' }
}

function alternative(profileId: string) {
  const current = recommendations(h)[0]!.assessments.at(-1)!
  return current.advice.alternatives.find(entry => entry.profileId === profileId)!
}

interface Row { id: string; text: string; run: () => void }

const ROWS: Row[] = [
  {
    id: 'E1', text: '| E1 | eligible worker, F1 evidence, not cooling | listed with its evidence |',
    run() {
      team()
      const observation = h.observe('kimi', 'moon', T0 - 2 * MIN)
      h.limit()
      h.drain()
      const [rec] = recommendations(h)
      expect(rec!.assessments).toHaveLength(1)
      expect(rec!.assessments[0]!.advice.choice).toBe('switch')
      expect(alternative('kimi')).toMatchObject({ listed: true, exclusion: null, headroom: 'known', headroomReason: 'fresh', observationId: observation })
      expect(rec!.assessments[0]!.evidence.map(entry => entry.observationId)).toContain(observation)
    },
  },
  {
    id: 'E2', text: '| E2 | same account as the limited provider (shared window) | excluded: shared window |',
    run() {
      team()
      h.workers.push({ model: 'alias', provider: 'zai-mirror' })
      h.scopes.alias = 'scope-zai'
      h.workers.push({ model: 'shared', provider: 'login-twin' })
      h.sharesLoginWith = { 'login-twin': ['zai'] }
      h.observe('glm-flash', 'zai', T0 - MIN)
      h.limit()
      h.drain()
      for (const profileId of ['glm-flash', 'alias', 'shared']) {
        expect(alternative(profileId)).toMatchObject({ listed: false, headroom: 'unknown', exclusion: { kind: 'shared-window' } })
      }
      // The limited profile itself is no alternative.
      expect(alternative('glm')).toBeUndefined()
    },
  },
  {
    id: 'E3', text: '| E3 | cooling per `cooldownFor` | excluded: cooling |',
    run() {
      team()
      h.observe('kimi', 'moon', T0 - MIN)
      // kimi's own final limit, an hour of cooling, recorded before the incident.
      h.limit({ profileId: 'kimi', providerId: 'moon' })
      h.drain()
      h.clock.now += 1_000
      h.limit()
      h.drain()
      const quota = recommendations(h).find(rec => rec.providerId === 'zai')!
      const kimi = quota.assessments[0]!.advice.alternatives.find(entry => entry.profileId === 'kimi')!
      expect(kimi).toMatchObject({ listed: false, exclusion: { kind: 'cooling' } })
      expect(kimi.exclusion!.detail).toContain(h.limits.cooldownFor('kimi', 'moon').until!)
    },
  },
  {
    id: 'E4', text: '| E4 | hard selector or review restriction forbids | excluded naming it |',
    run() {
      team()
      h.workers.push({ model: 'sonnet', provider: 'anthropic' })
      h.restrictions = {
        kimi: { kind: 'worker-choice', detail: 'worker choice zai' },
        sonnet: { kind: 'review-restriction', detail: 'cross-model review: same family as an author' },
      }
      h.observe('kimi', 'moon', T0 - MIN)
      h.limit()
      h.drain()
      expect(alternative('kimi')).toMatchObject({ listed: false, exclusion: { kind: 'worker-choice', detail: 'worker choice zai' } })
      expect(alternative('sonnet')).toMatchObject({ listed: false, exclusion: { kind: 'review-restriction' } })
      expect(alternative('sonnet').exclusion!.detail).toContain('cross-model review')
    },
  },
  {
    id: 'E5', text: '| E5 | cap reached or writer slot occupied (writer required) | excluded naming it |',
    run() {
      team()
      h.workers[2] = { model: 'kimi', provider: 'moon', cap: 1, live: 1 }
      h.observe('kimi', 'moon', T0 - MIN)
      h.limit()
      h.drain()
      expect(alternative('kimi')).toMatchObject({ listed: false, exclusion: { kind: 'profile-cap', detail: '1 of 1 live on kimi' } })
      // Writer required (the session works a task) and another writer holds the worktree.
      h.close()
      h = adviceHarness()
      team()
      h.records.get('s1')!.taskId = 'task-1'
      h.occupants = ['s9']
      h.observe('kimi', 'moon', T0 - MIN)
      h.limit()
      h.drain()
      expect(alternative('kimi')).toMatchObject({ listed: false, exclusion: { kind: 'writer-slot' } })
      expect(alternative('kimi').exclusion!.detail).toContain('release or hand off first')
      expect(recommendations(h)[0]!.assessments[0]!.advice.choice).not.toBe('switch')
    },
  },
  {
    id: 'E6', text: '| E6 | eligible, evidence F2–F5 | listed with unknown headroom; no numeric saving |',
    run() {
      team()
      h.workers.push({ model: 'host', provider: 'hostp' }, { model: 'fresh-fail', provider: 'flaky' }, { model: 'none', provider: 'nobody' })
      h.scopes = { ...h.scopes, host: 'scope-host', 'fresh-fail': 'scope-flaky' }
      h.observe('kimi', 'moon', T0 - 11 * MIN)
      h.observe('host', 'hostp', T0 - MIN, { basis: 'host-login' })
      h.observe('fresh-fail', 'flaky', T0 - 2 * MIN)
      h.observe('fresh-fail', 'flaky', T0 - MIN, { outcome: 'failed' })
      h.limit()
      h.drain()
      const current = recommendations(h)[0]!.assessments[0]!.advice
      for (const [profileId, reason] of [['kimi', 'stale'], ['host', 'host-login'], ['fresh-fail', 'later-failure'], ['none', 'none']] as const) {
        expect(alternative(profileId)).toMatchObject({ listed: true, headroom: 'unknown', headroomReason: reason })
      }
      expect(current.choice).toBe('no-alternative')
      expect(current.comparison.savingsMs).toBeNull()
      expect(current.unknowns.join(' ')).toContain('no saving is estimated')
    },
  },
  {
    id: 'E7', text: '| E7 | evidence arrives after the cutoff | not in this assessment; a new assessment cites it |',
    run() {
      team()
      h.limit()
      // kimi first reports capacity 30 s after the incident, before the
      // queued first evaluation runs (coalescing, or a restart, R5).
      h.clock.now = T0 + 30_000
      const later = h.observe('kimi', 'moon', h.clock.now)
      h.drain()
      const [first] = recommendations(h)
      expect(first!.assessments).toHaveLength(1)
      expect(first!.assessments[0]!.cutoff).toBe(new Date(T0).toISOString())
      expect(first!.assessments[0]!.advice.alternatives.find(entry => entry.profileId === 'kimi')!.headroom).toBe('unknown')
      expect(first!.assessments[0]!.evidence.map(entry => entry.observationId)).not.toContain(later)
      // The late first assessment enqueued the next one itself (no further
      // trigger needed): the next coalesced pass cites the later evidence.
      h.clock.now = T0 + MIN
      h.drain()
      const [rec] = recommendations(h)
      expect(rec!.assessments).toHaveLength(2)
      expect(rec!.assessments[0]).toEqual(first!.assessments[0]!)
      expect(rec!.assessments[1]!.advice.alternatives.find(entry => entry.profileId === 'kimi')!.headroom).toBe('known')
      expect(rec!.assessments[1]!.evidence.map(entry => entry.observationId)).toContain(later)
      expect(rec!.assessments[1]!.state).toBe('strengthened')
    },
  },
  {
    id: 'E8', text: '| E8 | context exhaustion incident | never treated as account exhaustion |',
    run() {
      team()
      h.observe('glm-flash', 'zai', T0 - MIN)
      h.records.get('s1')!.contextExhausted = { at: new Date(T0).toISOString(), reason: 'prompt_too_long' }
      h.advice.contextFlagged('s1')
      h.drain()
      const [rec] = recommendations(h)
      expect(rec).toMatchObject({ kind: 'context', attentionId: `context-exhausted:s1:${new Date(T0).toISOString()}` })
      const advice = rec!.assessments[0]!.advice
      expect(advice.choice).toBe('fresh-context')
      // The same account stays usable: nothing is excluded as a shared window, and the same profile is an alternative.
      expect(advice.alternatives.some(entry => entry.exclusion?.kind === 'shared-window')).toBe(false)
      expect(advice.alternatives.find(entry => entry.profileId === 'glm')).toMatchObject({ listed: true })
      expect(advice.alternatives.find(entry => entry.profileId === 'glm-flash')).toMatchObject({ listed: true, headroom: 'known' })
    },
  },
]

function runRow(id: string): void {
  h = adviceHarness()
  live = true
  ROWS.find(row => row.id === id)!.run()
}

describe('Table E through the advice service', () => {
  test('the rows are Table E verbatim', () => {
    const design = fs.readFileSync(DESIGN, 'utf8')
    expect(ROWS.map(row => row.text)).toEqual(design.split('\n').filter(line => /^\| E\d+ \|/.test(line)))
  })

  test('E1: listed with its evidence', () => runRow('E1'))
  // @covers: process-recommendations › Switch comparisons respect all eligibility and quota constraints › Another model on the same account
  test('E2: excluded: shared window', () => runRow('E2'))
  test('E3: excluded: cooling', () => runRow('E3'))
  test('E4: excluded naming it', () => runRow('E4'))
  // @covers: process-recommendations › Switch comparisons respect all eligibility and quota constraints › Empty writer slot required
  test('E5: excluded naming it (cap, writer slot)', () => runRow('E5'))
  // @covers: process-recommendations › Incident advice is available before statistical baselines › No usable alternative
  test('E6: listed with unknown headroom; no numeric saving', () => runRow('E6'))
  // @covers: process-observations › Incident alternatives use facts available at the time › Capacity arrives later
  test('E7: not in this assessment; a new assessment cites it', () => runRow('E7'))
  test('E8: never treated as account exhaustion', () => runRow('E8'))
})

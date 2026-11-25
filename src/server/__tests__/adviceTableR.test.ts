// @reads: openspec/changes/process-quota-history-and-incident-advice/design.md
// Table R (process-quota-history-and-incident-advice D5/D6): advice records
// through the production ManagerAdvice, queue, evaluator, stores and the
// read-only team tools. Row text is checked against design.md (V1).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { RECOMMENDATION_TOOL_NAMES, recommendationHandlers } from '../metrics/recommendations/tools'
import { TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import { adviceHarness, MIN, recommendations, T0, TEAM, type AdviceHarness } from './helpers/adviceHarness'

const DESIGN = path.join(import.meta.dir, '../../../openspec/changes/process-quota-history-and-incident-advice/design.md')

let h!: AdviceHarness
let extra: AdviceHarness[] = []
afterEach(() => {
  for (const harness of [...extra.reverse(), h]) harness?.close()
  extra = []
  h = undefined as unknown as AdviceHarness
})

function team(): void {
  h.workers = [{ model: 'glm', provider: 'zai', live: 1 }, { model: 'kimi', provider: 'moon' }]
  h.scopes = { glm: 'scope-zai', kimi: 'scope-moon' }
}

/** A restart over the same database: a new ManagerAdvice with the same fixtures. */
function restart(): AdviceHarness {
  h.advice.shutdown()
  const next = adviceHarness({ db: h.db })
  Object.assign(next, { workers: h.workers, scopes: h.scopes, records: h.records })
  // Time keeps running across the restart.
  next.clock.now = h.clock.now
  extra.push(h)
  h = next
  return next
}

function handoffMessage(id: string, deliveredAt: string): void {
  h.db.db.prepare(`INSERT INTO team_messages (id, team_id, to_kind, to_id, origin_path, thread_id, body, state, created_at, delivered_at, handoff)
    VALUES (?, ?, 'group', 'devs', '/repo', ?, 'forwarded', 'delivered', ?, ?, '{}')`).run(id, TEAM, id, deliveredAt, deliveredAt)
}

const ROWS: Array<{ id: string; text: string }> = [
  { id: 'R1', text: '| R1 | first quota incident, no baseline | provisional advice with sample flag, unknown savings |' },
  { id: 'R2', text: '| R2 | same evidence re-evaluated | no new assessment (material-change check) |' },
  { id: 'R3', text: '| R3 | new quota observation after the cutoff | new assessment version; old one unchanged |' },
  { id: 'R4', text: '| R4 | evaluator throws | health gap recorded; managed work continues |' },
  { id: 'R5', text: '| R5 | crash after incident commit, before evaluation | startup enqueues it once; one assessment |' },
  { id: 'R6', text: '| R6 | restart during a plan stall | advice attached to the existing stall episode; no duplicate alert |' },
  { id: 'R7', text: '| R7 | `process_recommendation_get` of another team\'s id | refused as unknown |' },
  { id: 'R8', text: '| R8 | agent tool list | no approve/apply/decide tool exists |' },
  { id: 'R9', text: '| R9 | observation behind an assessment pruned | evidence summary readable; link states expired |' },
]

describe('Table R through the advice service', () => {
  test('the rows are Table R verbatim', () => {
    const design = fs.readFileSync(DESIGN, 'utf8')
    expect(ROWS.map(row => row.text)).toEqual(design.split('\n').filter(line => /^\| R\d+ \|/.test(line)))
  })

  // @covers: process-recommendations › Incident advice is available before statistical baselines › First quota incident
  test('R1: provisional advice with sample flag, unknown savings', () => {
    h = adviceHarness()
    team()
    h.observe('kimi', 'moon', T0 - MIN)
    h.limit()
    h.drain()
    const [rec] = recommendations(h)
    const advice = rec!.assessments[0]!.advice
    expect(rec!.assessments[0]!.state).toBe('new')
    expect(advice).toMatchObject({ choice: 'switch', provisional: true, sample: { comparisons: 0, small: true } })
    expect(advice.comparison).toEqual({
      wait: { until: rec!.assessments[0]!.advice.comparison.wait.until, basis: 'reset' },
      switchCosts: { handoff: 'unknown', contextRebuild: 'unknown', execution: 'unknown', rework: 'unknown' }, savingsMs: null,
    })
    expect(advice.facts.length).toBeGreaterThan(0)
    expect(advice.assumptions.join(' ')).toContain('comparative metric stays insufficient')
  })

  // @covers: team-process-metrics › Early advice does not waive evidence sufficiency › One handoff
  test('R1: one successful handoff informs provisional advice while the comparison stays insufficient', () => {
    h = adviceHarness()
    team()
    handoffMessage('m-1', new Date(T0 - 60 * MIN).toISOString())
    handoffMessage('m-later', new Date(T0 + MIN).toISOString())
    h.observe('kimi', 'moon', T0 - MIN)
    h.limit()
    h.drain()
    const advice = recommendations(h)[0]!.assessments[0]!.advice
    expect(advice.sample).toEqual({ comparisons: 1, threshold: 10, small: true })
    expect(advice.provisional).toBe(true)
    expect(advice.assumptions.join(' ')).toContain('Only 1 earlier comparison observed')
  })

  test('R2: no new assessment (material-change check)', () => {
    h = adviceHarness()
    team()
    h.observe('kimi', 'moon', T0 - MIN)
    h.limit()
    h.drain()
    h.clock.now += 30_000
    // Re-evaluations with no new evidence: a team history trigger, a non-final limit, and a startup reconcile.
    h.advice.historyWritten([TEAM])
    h.drain()
    h.limit({ final: false })
    h.drain()
    h.advice.service.reconcile()
    h.drain()
    expect(recommendations(h)[0]!.assessments).toHaveLength(1)
  })

  test('R3: new assessment version; old one unchanged', () => {
    h = adviceHarness()
    team()
    h.limit()
    h.drain()
    const before = recommendations(h)[0]!.assessments
    h.clock.now = T0 + 2 * MIN
    h.observe('kimi', 'moon', h.clock.now)
    h.advice.historyWritten([TEAM])
    h.drain()
    const after = recommendations(h)[0]!.assessments
    expect(after.map(assessment => assessment.version)).toEqual([1, 2])
    expect(after[0]).toEqual(before[0]!)
    // The stored row cannot be rewritten (I3).
    expect(() => h.db.db.prepare('UPDATE process_assessments SET state = ? WHERE id = ?').run('revised', after[0]!.id)).toThrow(/immutable/)
    expect(() => h.db.db.prepare('DELETE FROM process_assessment_evidence').run()).toThrow(/immutable/)
  })

  // @covers: process-recommendations › Assessments are immutable and versioned › New evidence reverses advice
  test('R3: a later observed window that removes the alternative\'s headroom adds a withdrawn version and keeps the earlier one readable', () => {
    h = adviceHarness()
    team()
    const room = h.observe('kimi', 'moon', T0 - MIN, { percent: 40 })
    h.limit()
    h.drain()
    const id = recommendations(h)[0]!.id
    const before = h.advice.store.get(TEAM, id)!.assessments
    expect(before).toHaveLength(1)
    expect(before[0]!.advice.choice).toBe('switch')
    // Positive evidence: kimi's own window now reads full.
    h.clock.now = T0 + 2 * MIN
    const full = h.observe('kimi', 'moon', h.clock.now, { percent: 100 })
    h.advice.historyWritten([TEAM])
    h.drain()
    const detail = h.advice.store.get(TEAM, id)!
    expect(detail.current).toMatchObject({ version: 2, state: 'withdrawn', advice: { choice: 'no-alternative' } })
    const second = detail.assessments[1]!
    // The new assessment explains the change: kimi's capacity is no longer known, because its window is exhausted.
    expect(second.advice.alternatives.find(entry => entry.profileId === 'kimi')).toMatchObject({ listed: true, headroom: 'unknown', headroomReason: 'exhausted', observationId: full })
    expect(second.advice.unknowns).toContain('kimi on moon: capacity unknown (exhausted).')
    expect(second.advice.summary).toBe('No eligible alternative has known capacity; switching is not shown as available.')
    // The earlier assessment and its evidence are unchanged under the same recommendation id.
    expect(detail.assessments[0]).toEqual(before[0]!)
    expect(detail.assessments[0]!.evidence.map(entry => entry.observationId)).toContain(room)
    expect(detail.assessments[0]!.evidence.find(entry => entry.observationId === room)).toMatchObject({ expired: false, windows: [{ percentUsed: 40 }] })
  })

  test('R4: health gap recorded; managed work continues', () => {
    h = adviceHarness({ evaluate: () => { throw new RangeError('evaluator broke') } })
    team()
    // The limit event records and returns normally: routing never waits on advice.
    expect(() => h.limit()).not.toThrow()
    expect(h.limits.cooldownFor('glm', 'zai').until).not.toBeNull()
    expect(() => h.drain()).not.toThrow()
    expect(h.advice.store.gaps(TEAM)).toEqual([{ episodeKey: expect.stringMatching(/^quota:zai:/), errorKind: 'RangeError', at: expect.any(String) }])
    expect(recommendations(h)[0]!.assessments).toEqual([])
  })

  test('R5: startup enqueues it once; one assessment', () => {
    h = adviceHarness()
    team()
    h.observe('kimi', 'moon', T0 - MIN)
    h.limit()
    // Crash: the recommendation committed; the queued evaluation never ran.
    expect(recommendations(h)[0]!.assessments).toEqual([])
    restart()
    h.advice.start()
    h.drain()
    restart()
    h.advice.start()
    h.drain()
    const [rec] = recommendations(h)
    expect(recommendations(h)).toHaveLength(1)
    expect(rec!.assessments).toHaveLength(1)
    expect(rec!.assessments[0]!.cutoff).toBe(new Date(T0).toISOString())
  })

  // The first durability boundary: the limit store commits the event before
  // its subscriber runs, so a crash there leaves only the event.
  describe('R5 from a committed limit event alone', () => {
    interface Case { name: string; setup: () => void; expected: number; versions?: number[] }
    const run = (entry: Case) => {
      h = adviceHarness()
      team()
      h.observe('kimi', 'moon', T0 - MIN)
      // The subscriber is gone: the event commits with no advice callback.
      h.advice.shutdown()
      entry.setup()
      expect(recommendations(h)).toEqual([])
      expect(h.limits.forProvider('zai').length).toBeGreaterThan(0)
      for (let boot = 0; boot < 2; boot++) {
        restart()
        h.advice.start()
        h.drain()
      }
      const recs = recommendations(h)
      expect(recs).toHaveLength(entry.expected)
      if (entry.expected === 0) return
      expect(recs[0]).toMatchObject({ kind: 'quota', providerId: 'zai', snapshotBasis: 'reconstructed', cutoff: new Date(T0).toISOString() })
      // The first assessment is frozen at the first event; a later coalesced limit is later evidence (its own version, R3).
      expect(recs[0]!.assessments.map(assessment => assessment.version)).toEqual(entry.versions ?? [1])
      expect(recs[0]!.assessments[0]!.cutoff).toBe(new Date(T0).toISOString())
      expect(recs[0]!.assessments[0]!.advice.choice).toBe('switch')
    }

    test('R5: a committed final limit with no recommendation is reconstructed at startup, once', () =>
      run({ name: 'a final limit in force', setup: () => h.limit(), expected: 1 }))

    test('two final limits of the provider coalesce into one episode: 1 recommendation after restart, no duplicate assessment', () =>
      run({ name: 'coalesce', setup: () => { h.limit(); h.clock.now += MIN; h.limit() }, expected: 1, versions: [1, 2] }))
    test('a retried (non-final) attempt is no incident: 0 recommendation after restart, no duplicate assessment', () =>
      run({ name: 'non-final', setup: () => h.limit({ final: false }), expected: 0 }))
    test('a final limit whose cooldown ended is not reconstructed: 0 recommendation after restart, no duplicate assessment', () =>
      run({ name: 'expired', setup: () => { h.limit({ resetsAt: new Date(T0 + 2 * MIN).toISOString() }); h.clock.now = T0 + 3 * MIN }, expected: 0 }))

    test('a session whose team resolves after startup gets its advice then', () => {
      h = adviceHarness()
      team()
      h.advice.shutdown()
      h.limit()
      const record = h.records.get('s1')!
      restart()
      // Startup: the team is not known yet (resolution is asynchronous).
      h.records.delete('s1')
      h.advice.start()
      h.drain()
      expect(recommendations(h)).toEqual([])
      h.records.set('s1', record)
      h.advice.teamResolved('s1')
      h.advice.teamResolved('s1')
      h.drain()
      expect(recommendations(h)).toHaveLength(1)
      expect(recommendations(h)[0]!.assessments).toHaveLength(1)
    })
  })

  // An open quota episode that predates its stall attaches to it whichever event comes next (R6).
  describe('R6 when the stall is raised after the quota episode opened', () => {
    const attentionId = 'plan-stall:exec-1:chg:ep-3'
    const stall = () => {
      h.db.db.prepare(`INSERT INTO plan_execution_changes (execution_id, change, team_id, position, state, task_id, updated_at)
        VALUES ('exec-1', 'chg', ?, 0, 'implementing', 'task-7', ?)`).run(TEAM, new Date(h.clock.now).toISOString())
      h.db.db.prepare(`INSERT INTO plan_stall_alerts (id, team_id, plan_id, execution_id, change, kind, episode_key, detail_json, raised_at)
        VALUES ('alert-1', ?, 'plan-1', 'exec-1', 'chg', 'no-progress', 'ep-3', '{}', ?)`).run(TEAM, new Date(h.clock.now).toISOString())
    }
    const attachedAfter = (next: () => void) => {
      h = adviceHarness()
      team()
      h.records.get('s1')!.taskId = 'task-7'
      h.limit()
      h.drain()
      expect(recommendations(h)[0]!.attentionId).toBeNull()
      h.clock.now += MIN
      stall()
      next()
      h.drain()
      expect(recommendations(h).map(rec => rec.attentionId)).toEqual([attentionId])
      expect(h.advice.store.attachedAdvice(TEAM)).toEqual(new Map([[attentionId, recommendations(h)[0]!.id]]))
      // The frozen assessment is untouched (I3): only the link moved.
      expect(recommendations(h)[0]!.assessments[0]!.version).toBe(1)
      expect((h.db.db.prepare('SELECT COUNT(*) AS n FROM plan_stall_alerts').get() as { n: number }).n).toBe(1)
      expect((h.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n).toBe(0)
    }

    test('attached on another final limit of the still-cooling provider; one alert, no mail', () => attachedAfter(() => h.limit()))
    test('attached on a restart; one alert, no mail', () => attachedAfter(() => { restart(); h.advice.start() }))
    test('attached on a quota history write; one alert, no mail', () => attachedAfter(() => h.advice.historyWritten([TEAM])))
    test('attached on a retried limit attempt; one alert, no mail', () => attachedAfter(() => h.limit({ final: false })))
  })

  // @covers: process-recommendations › Incident advice reuses existing episodes › Restart during a plan stall
  test('R6: advice attached to the existing stall episode; no duplicate alert', () => {
    h = adviceHarness()
    team()
    h.records.get('s1')!.taskId = 'task-7'
    h.db.db.prepare(`INSERT INTO plan_execution_changes (execution_id, change, team_id, position, state, task_id, updated_at)
      VALUES ('exec-1', 'chg', ?, 0, 'implementing', 'task-7', ?)`).run(TEAM, new Date(T0).toISOString())
    h.db.db.prepare(`INSERT INTO plan_stall_alerts (id, team_id, plan_id, execution_id, change, kind, episode_key, detail_json, raised_at)
      VALUES ('alert-1', ?, 'plan-1', 'exec-1', 'chg', 'no-progress', 'ep-3', '{}', ?)`).run(TEAM, new Date(T0 - 5 * MIN).toISOString())
    h.limit()
    h.drain()
    const attentionId = 'plan-stall:exec-1:chg:ep-3'
    expect(recommendations(h)[0]!.attentionId).toBe(attentionId)
    const alerts = () => (h.db.db.prepare('SELECT COUNT(*) AS n FROM plan_stall_alerts').get() as { n: number }).n
    const mail = () => (h.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n
    restart()
    h.advice.start()
    h.clock.now += MIN
    h.limit()
    h.drain()
    expect(recommendations(h).map(rec => rec.attentionId)).toEqual([attentionId])
    expect(alerts()).toBe(1)
    expect(mail()).toBe(0)
  })

  test('R7: refused as unknown', async () => {
    h = adviceHarness()
    team()
    h.limit()
    h.drain()
    const id = recommendations(h)[0]!.id
    const tools = (sessionTeam: string) => recommendationHandlers({ teamOf: () => sessionTeam, store: h.advice.store }, 'caller')
    expect(await tools(TEAM).process_recommendation_get({ id })).toMatchObject({ id, teamId: TEAM })
    await expect(tools('team-b').process_recommendation_get({ id })).rejects.toThrow(`Unknown recommendation "${id}" in your team.`)
    expect(await tools('team-b').process_recommendations_list({})).toEqual({ recommendations: [] })
  })

  test('R8: no approve/apply/decide tool exists', () => {
    expect([...RECOMMENDATION_TOOL_NAMES]).toEqual(['process_recommendations_list', 'process_recommendation_get'])
    const advice = TEAM_ALLOWED_TOOLS.filter(name => /recommendation/.test(name))
    expect(advice).toEqual(['mcp__kawai-team__process_recommendations_list', 'mcp__kawai-team__process_recommendation_get'])
    expect(TEAM_ALLOWED_TOOLS.filter(name => /recommendation|advice|assessment/.test(name) && /approve|apply|decide|accept|dismiss|switch/.test(name))).toEqual([])
  })

  // @covers: process-observations › Recommendation evidence outlives observation detail › Detail pruned
  test('R9: evidence summary readable; link states expired', () => {
    h = adviceHarness()
    team()
    const observation = h.observe('kimi', 'moon', T0 - MIN, { percent: 37 })
    h.limit()
    h.drain()
    h.clock.now = T0 + 15 * 24 * 60 * MIN
    expect(h.history.prune(new Date(h.clock.now - 14 * 24 * 60 * MIN).toISOString())).toBeGreaterThan(0)
    const evidence = recommendations(h)[0]!.assessments[0]!.evidence.find(entry => entry.observationId === observation)!
    expect(evidence).toMatchObject({ expired: true, providerId: 'moon', outcome: 'supported', windows: [{ key: 'zai:time_limit', percentUsed: 37 }] })
    expect(h.history.get(TEAM, observation)).toBeNull()
  })
})

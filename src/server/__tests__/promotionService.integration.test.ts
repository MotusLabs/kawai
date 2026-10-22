// PromotionService.preview and promote over a real bare origin
// (integration-candidates 5.1, D9): the preview's standing, pinned head,
// carried candidates and outside commits; a refusal names its entries and
// writes nothing; replay and the compared payload; two racing same-key
// Promotes leave one promotion; agents are refused; a completed plan is
// promoted and its state is unchanged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createMatrixBench, createMatrixWorld, originHead, removeMatrixWorld, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'
import { createIntegrationBench, type IntegrationBench } from './integrationMatrixHarness'
import { IntegrationConflict } from '../plans/landing/integration/integrationStore'
import { createPromotionBench, twoLandings, type PromotionBench } from './promotionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let p: PromotionBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-promotion-service-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); p = createPromotionBench(h, i); n += 1 })
afterEach(() => { p.executor.close(); i.executor.close(); h.executor.close(); h.bench.db.close() })

const promotionEvents = (planId: string) => h.bench.plans.events(planId).filter(event => event.kind.startsWith('promotion-'))

describe('PromotionService (5.1, D9)', () => {
  test('the preview lists the standing, the pinned head, and the carried candidates newest first', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    // The owner's commit recorded beside the second candidate (D5's outside commits).
    const outside = [{ sha: 'e'.repeat(40), subject: 'owner fix', author: 'Owner' }]
    h.bench.db.db.prepare("UPDATE plan_integration_candidates SET outside_json = ? WHERE branch = ? AND change = ?").run(JSON.stringify(outside), branch, `b${n}`)
    const preview = await p.service.preview(p.human, { planId, branch })
    if (!preview.ok) throw new Error(preview.message)
    const landed = i.store.candidates(matrix.world.team.teamId, branch).filter(row => row.state === 'landed')
    expect(preview.preview).toMatchObject({ branch, targetBranch: 'master', head: originHead(matrix, branch), failures: [] })
    expect(preview.preview.throughSeq).toBe(Math.max(...landed.map(row => row.seq)))
    expect(preview.preview.carried.map(row => row.change)).toEqual([`b${n}`, `a${n}`])
    expect(preview.preview.outside).toEqual(outside)
  })

  test('a completed plan is promoted, its lifecycle unchanged, with promotion-started recorded once', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    expect(h.bench.plans.get(planId)!.lifecycle).toBe('completed')
    const fromSha = originHead(matrix, branch)!
    const outcome = await p.service.promote(p.human, { planId, branch, fromSha, commandId: `go-${n}` })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.promotion).toMatchObject({ state: 'running', step: 'branch', number: 1, fromSha, targetBranch: 'master', promotionBranch: `${branch}--promote-1` })
    expect(h.bench.plans.get(planId)!.lifecycle).toBe('completed')
    expect(promotionEvents(planId).map(event => [event.kind, event.commandId])).toEqual([['promotion-started', `go-${n}`]])
  })

  test('a cancelled plan is promoted carrying its two landed changes, and stays cancelled', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    h.bench.db.db.prepare("UPDATE plans SET lifecycle = 'cancelled' WHERE id = ?").run(planId)
    const landed = i.store.candidates(matrix.world.team.teamId, branch).filter(row => row.state === 'landed')
    const throughSeq = Math.max(...landed.map(row => row.seq))
    const preview = await p.service.preview(p.human, { planId, branch })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.preview.failures).toEqual([])
    expect(preview.preview.throughSeq).toBe(throughSeq)
    expect(preview.preview.carried.map(row => row.change)).toEqual([`b${n}`, `a${n}`])
    const outcome = await p.service.promote(p.human, { planId, branch, fromSha: originHead(matrix, branch)!, commandId: `go-${n}` })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.promotion.throughSeq).toBe(throughSeq)
    expect(h.bench.plans.get(planId)!.lifecycle).toBe('cancelled')
  })

  test('a replay returns the same promotion; a different branch or fromSha under the id is refused naming the field', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    const fromSha = originHead(matrix, branch)!
    const first = await p.service.promote(p.human, { planId, branch, fromSha, commandId: `go-${n}` })
    const replay = await p.service.promote(p.human, { planId, branch, fromSha, commandId: `go-${n}` })
    expect(replay.ok && first.ok && replay.replayed && replay.promotion.id === first.promotion.id).toBe(true)
    const otherSha = await p.service.promote(p.human, { planId, branch, fromSha: 'f'.repeat(40), commandId: `go-${n}` })
    expect(!otherSha.ok && otherSha.message).toContain('fromSha')
    const otherBranch = await p.service.promote(p.human, { planId, branch: `${branch}-x`, fromSha, commandId: `go-${n}` })
    expect(!otherBranch.ok && otherBranch.message).toContain('branch')
    expect(i.store.promotionsOf(planId).length).toBe(1)
  })

  test('two same-key Promotes that both passed the reads leave one promotion', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    const input = { planId, branch, fromSha: originHead(matrix, branch)!, commandId: `race-${n}` }
    const [a, b] = await Promise.all([p.service.promote(p.human, input), p.service.promote(p.human, input)])
    expect(a.ok && b.ok).toBe(true)
    expect([a.ok && a.replayed, b.ok && b.replayed].sort()).toEqual([false, true])
    expect(i.store.promotionsOf(planId).length).toBe(1)
    // Across processes, the table's own UNIQUE (plan_id, command_id) holds the line.
    const [row] = i.store.promotionsOf(planId)
    i.store.finishPromotion(row!.id, 'cancelled')
    let conflict: unknown = null
    try { i.store.insertPromotion({ ...row!, commandId: row!.commandId }) } catch (error) { conflict = error }
    expect(conflict instanceof IntegrationConflict && conflict.kind).toBe('promotion-replay')
  })

  test('a refusal names every failing entry and writes nothing', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    p.script.allowMergeCommit = false
    const outcome = await p.service.promote(p.human, { planId, branch, fromSha: 'f'.repeat(40), commandId: `no-${n}` })
    expect(!outcome.ok && outcome.failures?.map(failure => failure.name)).toEqual(['from-current', 'something-to-promote', 'merge-commits-allowed'])
    expect(i.store.promotionsOf(planId)).toEqual([])
    expect(promotionEvents(planId)).toEqual([])
  })

  test('a second Promote while one runs is refused as no-promotion', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    const fromSha = originHead(matrix, branch)!
    expect((await p.service.promote(p.human, { planId, branch, fromSha, commandId: `one-${n}` })).ok).toBe(true)
    const second = await p.service.promote(p.human, { planId, branch, fromSha, commandId: `two-${n}` })
    expect(!second.ok && second.failures?.map(failure => failure.name)).toContain('no-promotion')
  })

  test('an agent caller is refused for the preview and Promote', async () => {
    const agent = { kind: 'agent' as const, sessionId: 'dev' }
    const preview = await p.service.preview(agent, { planId: 'x', branch: 'y' })
    const promote = await p.service.promote(agent, { planId: 'x', branch: 'y', fromSha: 'z', commandId: 'c' })
    expect([!preview.ok && preview.reason, !promote.ok && promote.reason]).toEqual(['forbidden', 'forbidden'])
  })
})

describe('PromotionService under holds (revision-control 3.3)', () => {
  test('Promote carrying a held change is refused naming no-hold, and writes nothing', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    try {
      p.script.activeHolds = [{ id: 'h1', scope: 'changes', changes: [`a${n}`] }]
      const preview = await p.service.preview(p.human, { planId, branch })
      expect(preview.ok && preview.preview.failures.map(failure => failure.name)).toContain('no-hold')
      const outcome = await p.service.promote(p.human, { planId, branch, fromSha: originHead(matrix, branch)!, commandId: `held-${n}` })
      expect(!outcome.ok && outcome.reason).toBe('precondition')
      if (!outcome.ok) expect(outcome.message).toContain('Held changes this promotion would carry')
      expect(i.store.promotionsOf(planId).length).toBe(0)
    } finally {
      p.script.activeHolds = []
    }
  })

  test('a running promotion under a hold gives up the slot and waits at held; release re-runs up-to-date and merges', async () => {
    const branch = `wave/svc-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    const fromSha = originHead(matrix, branch)!
    const started = await p.service.promote(p.human, { planId, branch, fromSha, commandId: `go-${n}` })
    if (!started.ok) throw new Error(started.message)
    const promotionId = started.promotion.id
    try {
      // Hold CI pending on the promotion branch's head (created at fromSha), so the promotion sits at the ci step holding the slot.
      h.gh.checks.set(fromSha, [{ name: 'ci', source: 'actions', conclusion: 'pending', link: null, runId: 12, startedAt: '2026-10-17T00:00:00.000Z', completedAt: null }])
      for (let tick = 0; tick < 12 && i.store.promotion(promotionId)!.step !== 'ci'; tick++) await p.tick()
      expect(i.store.promotion(promotionId)!.step).toBe('ci')

      p.script.activeHolds = [{ id: 'h-plan', scope: 'plan', changes: [] }]
      for (let tick = 0; tick < 8 && i.store.promotion(promotionId)!.step !== 'held'; tick++) await p.tick()
      expect(i.store.promotion(promotionId)!.step).toBe('held')
      expect(h.executions.slot(matrix.world.team.teamId)).toBeNull()

      p.script.activeHolds = []
      h.gh.checks.delete(fromSha) // release: the floor's green defaults decide CI again
      for (let tick = 0; tick < 16 && i.store.promotion(promotionId)!.state !== 'finished'; tick++) await p.tick()
      const finished = i.store.promotion(promotionId)!
      expect(finished.outcome).toBe('merged')
    } finally {
      p.script.activeHolds = []
    }
  })
})

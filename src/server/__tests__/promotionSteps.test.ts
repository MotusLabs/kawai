// Promotion steps through the executor over a real bare origin and the
// scripted GitHub (integration-candidates 5.2, 6.1–6.3, D9–D10): Promote
// after two landings merges with a merge commit (a squash team too) and
// fast-forwards the integration branch to the verified head; a target that
// moves goes back to the up-to-date step, and the third move fails; Cancel
// during CI closes the pull request and keeps the branch, during a merge it
// comes too late; a restart after the merge was requested records it
// without merging again; failures of open-pr and close-pr.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { CiCheck } from '../../shared/planExecution'
import { createMatrixBench, createMatrixWorld, git, originHead, pushCommit, removeMatrixWorld, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'
import { createIntegrationBench, startedIntegration, type IntegrationBench } from './integrationMatrixHarness'
import { createPromotionBench, twoLandings as landTwo, type PromotionBench } from './promotionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let p: PromotionBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-promotion-steps-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); p = createPromotionBench(h, i); n += 1 })
afterEach(() => { p.executor.close(); i.executor.close(); h.executor.close(); h.bench.db.close() })

const team = () => matrix.world.team.teamId
const pending = (): CiCheck[] => [{ name: 'ci', source: 'check-run', conclusion: 'pending', link: null, startedAt: null, completedAt: null }]

const twoLandings = (branch: string) => landTwo(h, i, p, branch, String(n))

async function promote(planId: string, branch: string, commandId = `promote-${n}`) {
  const outcome = await p.service.promote(p.human, { planId, branch, fromSha: originHead(matrix, branch)!, commandId })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.promotion
}

/** Tick until the promotion leaves `running` (or reaches `until`), advancing the clock past any backoff. */
async function run(promotionId: string, until?: (step: string | null) => boolean, ticks = 40) {
  for (let tick = 0; tick < ticks; tick++) {
    const row = i.store.promotion(promotionId)!
    if (row.state !== 'running' || until?.(row.step)) return row
    await p.tick()
    h.clock.now += 11 * 60_000
  }
  return i.store.promotion(promotionId)!
}

const finishedEvents = (planId: string) => h.bench.plans.events(planId).filter(event => event.kind === 'promotion-finished')

describe('promotion steps (6.1, 6.3, D10)', () => {
  test('two landings, then Promote merges with a merge commit on a squash team, records the merge, and finishes once', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    const integrationHead = originHead(matrix, branch)!
    const promotion = await promote(planId, branch)
    const done = await run(promotion.id)
    expect(done).toMatchObject({ state: 'finished', outcome: 'merged', treeVerified: true, fastForwarded: true, headSha: integrationHead })
    expect(h.gh.merges).toEqual([{ pr: done.prNumber!, method: 'merge', head: integrationHead }])
    const master = originHead(matrix, 'master')!
    expect(done.mergeSha).toBe(master)
    // The default branch contains each landed candidate's commit.
    for (const candidate of i.store.candidates(team(), branch).filter(row => row.kind !== 'promotion' && row.state === 'landed')) {
      expect(git(['merge-base', '--is-ancestor', candidate.commitSha, master], matrix.origin)).toBe('')
    }
    expect(i.store.candidates(team(), branch).find(row => row.promotionId === promotion.id)).toMatchObject({ kind: 'promotion', state: 'landed', baselineSha: promotion.fromSha, commitSha: integrationHead })
    expect(finishedEvents(planId).map(event => event.commandId)).toEqual([`promo:${promotion.id}:finish`])
    expect(h.executions.slot(team())).toBeNull()
    expect(p.script.closes).toEqual([])
  })

  test('a target that moved before Promote is merged in: the integration branch moves to P and the next change provisions from P', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    pushCommit(matrix, 'master', `owner-${n}.txt`, 'owner\n')
    const promotion = await promote(planId, branch)
    const done = await run(promotion.id)
    expect(done.outcome).toBe('merged')
    expect(h.gh.updates.length).toBe(1)
    const verified = done.headSha!
    expect(verified).not.toBe(promotion.fromSha)
    expect(originHead(matrix, branch)).toBe(verified)
    const next = await startedIntegration(h, i, branch, [{ change: `c${n}` }])
    await p.tick()
    expect(h.executions.change(next, `c${n}`)!.baselineCommit).toBe(verified)
  })

  test('a target moving between the re-read and the merge leaves tree_verified 0', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    h.gh.beforeMerge = () => {
      h.gh.beforeMerge = null
      pushCommit(matrix, 'master', `race-${n}.txt`, 'race\n')
    }
    // The scripted merge pins the head, not the base, so GitHub merges over the moved target.
    const promotion = await promote(planId, branch)
    const done = await run(promotion.id)
    expect(done).toMatchObject({ outcome: 'merged', treeVerified: false })
  })

  test('an integration branch moved during the promotion is left as it is, merged with a note', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    pushCommit(matrix, 'master', `owner-${n}.txt`, 'owner\n')
    const promotion = await promote(planId, branch)
    await run(promotion.id, step => step === 'fast-forward')
    const moved = pushCommit(matrix, branch, `hand-${n}.txt`, 'by hand\n')
    const done = await run(promotion.id)
    expect(done).toMatchObject({ outcome: 'merged', fastForwarded: false })
    expect(done.fastForwardNote).toContain(moved)
    expect(originHead(matrix, branch)).toBe(moved)
    expect(i.store.candidates(team(), branch).find(row => row.promotionId === promotion.id)!.state).toBe('superseded')
  })

  test('a target moving at every re-read fails the third time as target-moved and closes the pull request', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    // Each CI read is followed by a push to the target, so every re-read finds it moved.
    const checkRuns = h.roundAdapters.checkRuns
    let moves = 0
    h.roundAdapters.checkRuns = async (...args) => {
      const answer = await checkRuns(...args)
      pushCommit(matrix, 'master', `move-${n}-${moves++}.txt`, 'move\n')
      return answer
    }
    try {
      const promotion = await promote(planId, branch)
      const done = await run(promotion.id)
      expect(done).toMatchObject({ state: 'finished', outcome: 'failed:target-moved', moves: 3 })
      await p.tick()
      expect(p.script.closes.map(close => close.pr)).toEqual([done.prNumber!])
      expect(h.gh.merges).toEqual([])
    } finally {
      h.roundAdapters.checkRuns = checkRuns
    }
  })

  test('a target that moves once goes back to the up-to-date step and still merges', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    const checkRuns = h.roundAdapters.checkRuns
    h.roundAdapters.checkRuns = async (...args) => {
      h.roundAdapters.checkRuns = checkRuns
      const answer = await checkRuns(...args)
      pushCommit(matrix, 'master', `once-${n}.txt`, 'once\n')
      return answer
    }
    const promotion = await promote(planId, branch)
    const done = await run(promotion.id)
    expect(done).toMatchObject({ outcome: 'merged', moves: 1, treeVerified: true })
    expect(h.gh.updates.length).toBe(1)
    expect(originHead(matrix, branch)).toBe(done.headSha)
  })

  test('a predicted conflict with the target fails as promotion-conflict with the files', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    pushCommit(matrix, 'master', `src/a${n}.ts`, 'conflicting\n')
    const promotion = await promote(planId, branch)
    const done = await run(promotion.id)
    expect(done.outcome).toBe('failed:promotion-conflict')
    expect(done.outcomeDetail).toMatchObject({ files: [`src/a${n}.ts`] })
  })
})

describe('Cancel (5.2, D9)', () => {
  test('while CI runs: cancelled with the reason, the pull request closed, the branch kept', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    h.gh.defaultChecks = pending()
    const promotion = await promote(planId, branch)
    await run(promotion.id, step => step === 'ci')
    await p.tick()
    const cancelled = await p.service.cancel(p.human, { promotionId: promotion.id, reason: ' wrong time ', commandId: `cancel-${n}` })
    expect(cancelled.ok && cancelled.promotion).toMatchObject({ state: 'finished', outcome: 'cancelled' })
    await p.tick()
    expect(p.script.closes.map(close => close.pr)).toEqual([promotion.prNumber ?? i.store.promotion(promotion.id)!.prNumber!])
    expect(originHead(matrix, i.store.promotion(promotion.id)!.promotionBranch)).not.toBeNull()
    const event = h.bench.plans.events(planId).find(row => row.kind === 'promotion-cancelled')!
    expect(event.reason).toBe('wrong time')
    // A replay returns the same result; another reason under the id is refused naming it.
    const replay = await p.service.cancel(p.human, { promotionId: promotion.id, reason: 'wrong time', commandId: `cancel-${n}` })
    expect(replay.ok && replay.replayed).toBe(true)
    const other = await p.service.cancel(p.human, { promotionId: promotion.id, reason: 'other', commandId: `cancel-${n}` })
    expect(!other.ok && other.message).toContain('reason')
  })

  test('during a merge that completes: merged, fast-forwarded, the note says it came too late; then refused naming the merge', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    const promotion = await promote(planId, branch)
    let during: unknown = null
    h.gh.beforeMerge = async () => {
      h.gh.beforeMerge = null
      during = await p.service.cancel(p.human, { promotionId: promotion.id, reason: 'stop', commandId: `cancel-${n}` })
    }
    const done = await run(promotion.id)
    expect(during).toMatchObject({ ok: true })
    expect(done).toMatchObject({ outcome: 'merged', fastForwarded: true })
    expect(String(done.outcomeDetail?.note)).toContain('too late')
    const after = await p.service.cancel(p.human, { promotionId: promotion.id, reason: 'again', commandId: `cancel2-${n}` })
    expect(!after.ok && after.message).toContain(done.mergeSha!)
  })

  test('an agent caller is refused', async () => {
    const outcome = await p.service.cancel({ kind: 'agent', sessionId: 'dev' }, { promotionId: 'x', reason: 'r', commandId: 'c' })
    expect(!outcome.ok && outcome.reason).toBe('forbidden')
  })
})

describe('promotion effects (6.2, D14, L1)', () => {
  test('a restart after the merge was requested finds it merged and records the promotion without merging again', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    const promotion = await promote(planId, branch)
    await run(promotion.id, step => step === 'merge')
    const merge = i.store.promotionEffects(promotion.id).find(effect => effect.kind === 'merge')!
    expect(merge.state).toBe('pending')
    // The crash: the merge ran on GitHub while its effect was running, and its outcome was never recorded.
    const pulled = await h.landingAdapters.prMerge('o/r', Number(merge.command.pr), 'merge', String(merge.command.head))
    expect(pulled.ok).toBe(true)
    h.bench.db.db.prepare("UPDATE plan_promotion_effects SET state = 'running' WHERE id = ?").run(merge.id)
    p.executor.close()
    p.executor = p.restart()
    await p.executor.startup()
    expect(i.store.effect(merge.id)!.state).toBe('unknown')
    expect(h.gh.merges.length).toBe(1)
    const done = await run(promotion.id)
    expect(done.outcome).toBe('merged')
    expect(h.gh.merges.length).toBe(1)
    expect(finishedEvents(planId).length).toBe(1)
  })

  test('three failures to reach GitHub while opening the pull request fail as effect-failed', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    const create = h.roundAdapters.prCreate
    h.roundAdapters.prCreate = async () => ({ ok: false, error: { argv: ['gh', 'pr', 'create'], exitCode: 1, httpStatus: 502, message: 'HTTP 502: Bad Gateway' } })
    try {
      const promotion = await promote(planId, branch)
      const done = await run(promotion.id)
      expect(done.outcome).toBe('failed:effect-failed')
      expect(i.store.promotionEffects(promotion.id).find(effect => effect.kind === 'open-pr')).toMatchObject({ state: 'failed', tries: 3 })
    } finally {
      h.roundAdapters.prCreate = create
    }
  })

  test('a close-pr that fails after its retries leaves the outcome and notes the pull request is still open', async () => {
    const branch = `wave/promo-${n}`
    const planId = await twoLandings(branch)
    pushCommit(matrix, 'master', `src/a${n}.ts`, 'conflicting\n')
    p.script.closeTransient = 99
    const promotion = await promote(planId, branch)
    await run(promotion.id)
    for (let tick = 0; tick < 6; tick++) {
      await p.tick()
      h.clock.now += 11 * 60_000
    }
    const done = i.store.promotion(promotion.id)!
    expect(done.outcome).toBe('failed:promotion-conflict')
    expect(String(done.outcomeDetail?.closePr)).toContain('still open')
    expect(p.script.closes).toEqual([])
  })
})

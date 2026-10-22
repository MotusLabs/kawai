// integration-candidates D10 (tasks 6.1–6.3): the pure promotion step
// planner — every step's next decision over a promotion row, its effects,
// the slot, and the reads the runner gathered.
import { describe, expect, test } from 'bun:test'
import type { CiCheck } from '../../shared/planExecution'
import type { PromotionRow } from '../plans/landing/integration/integrationStore'
import type { PromotionEffectRow } from '../plans/landing/integration/promotionEffectStore'
import { planPromotionStep, promotionEffectKey, type PromotionStepInput } from '../plans/landing/integration/promotionPlanner'

const NOW = '2026-10-19T10:00:00.000Z'
const FLOOR = { lint: ['lint'], typecheck: ['typecheck'], 'unit-tests': ['test'], 'ci-e2e': ['e2e'] }

function promotion(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'promo-1', teamId: 'team', planId: 'plan-1', branch: 'integration/p', number: 1, commandId: 'cmd',
    fromSha: 'f'.repeat(40), throughSeq: 2, targetBranch: 'main', promotionBranch: 'integration/p-promote-1',
    floor: { version: 1, map: FLOOR }, prNumber: null, prUrl: null, headSha: null, step: 'branch', moves: 0,
    ci: null, rerunAt: null, ciWindowFrom: null, state: 'running', outcome: null, outcomeDetail: null,
    mergeSha: null, treeVerified: null, fastForwarded: null, fastForwardNote: null, cancelReason: null,
    startedAt: '2026-10-19T09:00:00.000Z', finishedAt: null,
    ...overrides,
  } as PromotionRow
}

function effect(p: PromotionRow, kind: PromotionEffectRow['kind'], state: PromotionEffectRow['state'], outcome: unknown = null, moves?: number): PromotionEffectRow {
  return {
    id: `e-${kind}`, promotionId: p.id, kind, effectKey: promotionEffectKey(p, kind, moves), command: {}, state, tries: 0,
    nextAt: null, outcome, error: state === 'failed' ? 'boom' : null, createdAt: NOW, startedAt: NOW, finishedAt: null,
  }
}

function plan(p: PromotionRow, rest: Partial<PromotionStepInput> = {}) {
  return planPromotionStep({ promotion: p, effects: [], slot: null, now: NOW, repo: 'o/r', main: '/main', ...rest, heldChanges: rest.heldChanges ?? [] })
}

const pass = (name: string): CiCheck => ({ name, source: 'check-run', conclusion: 'success', link: null, startedAt: NOW, completedAt: NOW })

describe('promotion planner (D10)', () => {
  test('step 1 creates the promotion branch at from_sha, then moves to the pull request', () => {
    const p = promotion()
    expect(plan(p)).toEqual({ kind: 'effect', effect: { kind: 'create-promotion-branch', effectKey: 'promo:promo-1:create-promotion-branch', command: { repo: 'o/r', branch: p.promotionBranch, sha: p.fromSha, cwd: '/main' } } })
    expect(plan(p, { effects: [effect(p, 'create-promotion-branch', 'pending')] }).kind).toBe('wait')
    expect(plan(p, { effects: [effect(p, 'create-promotion-branch', 'done')] })).toEqual({ kind: 'patch', patch: { step: 'pull-request' } })
  })

  test('step 2 opens the pull request into the target and records its number', () => {
    const p = promotion({ step: 'pull-request' })
    const asked = plan(p)
    expect(asked.kind === 'effect' && asked.effect.command).toMatchObject({ head: p.promotionBranch, base: 'main' })
    expect(plan(p, { effects: [effect(p, 'open-pr', 'done', { number: 9, url: 'u' })] })).toEqual({ kind: 'patch', patch: { prNumber: 9, prUrl: 'u', step: 'slot' } })
  })

  test('step 3 takes the slot, waits naming another holder, and proceeds once held', () => {
    const p = promotion({ step: 'slot' })
    expect(plan(p)).toEqual({ kind: 'take-slot' })
    expect(plan(p, { slot: { holderKind: 'change', holderId: 'x', label: 'exec-1/a' } })).toEqual({ kind: 'wait', reason: 'waits for the landing slot, held by exec-1/a' })
    expect(plan(p, { slot: { holderKind: 'promotion', holderId: p.id, label: p.promotionBranch } })).toEqual({ kind: 'patch', patch: { step: 'up-to-date' } })
  })

  test('step 4: a contained target goes to CI; a predicted conflict fails as promotion-conflict; else update-branch', () => {
    const p = promotion({ step: 'up-to-date', prNumber: 9 })
    expect(plan(p)).toEqual({ kind: 'read', step: 'up-to-date' })
    const reads = { step: 'up-to-date' as const, promotionHead: 'h', targetHead: 't', contains: true, conflicts: null }
    expect(plan(p, { reads })).toEqual({ kind: 'patch', patch: { step: 'ci', ciWindowFrom: NOW } })
    const conflict = plan(p, { reads: { ...reads, contains: false, conflicts: ['a.ts'] } })
    expect(conflict.kind === 'fail' && conflict.failure).toBe('promotion-conflict')
    expect(plan(p, { reads: { ...reads, contains: false, conflicts: [] } })).toEqual({ kind: 'effect', effect: { kind: 'update-branch', effectKey: 'promo:promo-1:update-branch:0', command: { repo: 'o/r', pr: 9, head: 'h' } } })
  })

  test('step 4 after the update: a 422 conflict fails, a clean head opens the CI window, a dirty one fails effect-failed', () => {
    const p = promotion({ step: 'up-to-date', prNumber: 9 })
    const refused = plan(p, { effects: [effect(p, 'update-branch', 'done', { requested: false, conflict: true }, 0)] })
    expect(refused.kind === 'fail' && refused.failure).toBe('promotion-conflict')
    const done = [effect(p, 'update-branch', 'done', { requested: true, head: 'h' }, 0)]
    expect(plan(p, { effects: done })).toEqual({ kind: 'read', step: 'clean' })
    expect(plan(p, { effects: done, reads: { step: 'clean', clean: null, head: 'h' } }).kind).toBe('wait')
    expect(plan(p, { effects: done, reads: { step: 'clean', clean: true, head: 'h2' } })).toEqual({ kind: 'patch', patch: { step: 'ci', ciWindowFrom: NOW, ci: null } })
    const dirty = plan(p, { effects: done, reads: { step: 'clean', clean: false, head: 'h2' } })
    expect(dirty.kind === 'fail' && dirty.failure).toBe('effect-failed')
  })

  test('step 5: pending waits, a pass records the verified head, a failure is ci-failed', () => {
    const p = promotion({ step: 'ci', ciWindowFrom: NOW })
    expect(plan(p)).toEqual({ kind: 'read', step: 'ci' })
    const all = Object.values(FLOOR).flat().map(pass)
    expect(plan(p, { reads: { step: 'ci', head: 'h', checks: all } })).toEqual({ kind: 'patch', patch: { ci: all, headSha: 'h', step: 're-read' } })
    const pending = plan(p, { reads: { step: 'ci', head: 'h', checks: [{ ...pass('lint'), conclusion: 'pending' }] } })
    expect(pending.kind).toBe('wait')
    const failed = plan(p, { reads: { step: 'ci', head: 'h', checks: [{ ...pass('lint'), conclusion: 'failure', source: 'status' }] } })
    expect(failed.kind === 'fail' && failed.failure).toBe('ci-failed')
  })

  test('step 5: no checks for 30 minutes stops as ci-missing, checks pending for 3 hours as ci-timeout', () => {
    const missing = plan(promotion({ step: 'ci', ciWindowFrom: '2026-10-19T09:00:00.000Z' }), { reads: { step: 'ci', head: 'h', checks: [] } })
    expect(missing.kind === 'fail' && missing.failure).toBe('ci-missing')
    const stuck = plan(promotion({ step: 'ci', ciWindowFrom: '2026-10-19T06:00:00.000Z' }), { reads: { step: 'ci', head: 'h', checks: [{ ...pass('lint'), conclusion: 'pending' }] } })
    expect(stuck.kind === 'fail' && stuck.failure).toBe('ci-timeout')
  })

  test('step 5 requests one rerun of a failed Actions run under the move count', () => {
    const p = promotion({ step: 'ci', ciWindowFrom: NOW, moves: 1 })
    const failed = { ...pass('lint'), conclusion: 'failure', source: 'actions' as const, runId: 5 }
    expect(plan(p, { reads: { step: 'ci', head: 'h', checks: [failed] } })).toEqual({ kind: 'effect', effect: { kind: 'rerun', effectKey: 'promo:promo-1:rerun:1', command: { repo: 'o/r', runIds: [5] } } })
  })

  test('step 6: a target the head contains goes to merge; a moved one is a move', () => {
    const p = promotion({ step: 're-read', headSha: 'h' })
    expect(plan(p, { reads: { step: 're-read', targetHead: 't', contains: true } })).toEqual({ kind: 'patch', patch: { step: 'merge' } })
    expect(plan(p, { reads: { step: 're-read', targetHead: 't2', contains: false } })).toEqual({ kind: 'move' })
    expect(plan(p, { reads: { step: 're-read', targetHead: null, contains: null } }).kind).toBe('wait')
  })

  test('step 7 merges with a merge commit pinned to head_sha; a moved base is a move', () => {
    const p = promotion({ step: 'merge', headSha: 'h', prNumber: 9 })
    expect(plan(p)).toEqual({ kind: 'effect', effect: { kind: 'merge', effectKey: 'promo:promo-1:merge:0', command: { repo: 'o/r', pr: 9, head: 'h', cwd: '/main', baseBranch: 'main', method: 'merge' } } })
    expect(plan(p, { effects: [effect(p, 'merge', 'done', { merged: true, mergeCommit: 'm' }, 0)] })).toEqual({ kind: 'patch', patch: { step: 'record' } })
    expect(plan(p, { effects: [effect(p, 'merge', 'done', { merged: false, baseMoved: true }, 0)] })).toEqual({ kind: 'move' })
  })

  test('step 8 records the merge with the tree check', () => {
    const p = promotion({ step: 'record', headSha: 'h' })
    const merged = [effect(p, 'merge', 'done', { merged: true, mergeCommit: 'm' }, 0)]
    expect(plan(p, { effects: merged })).toEqual({ kind: 'read', step: 'record' })
    expect(plan(p, { effects: merged, reads: { step: 'record', mergeTree: 'T', headTree: 'T' } })).toEqual({ kind: 'record', mergeSha: 'm', treeVerified: true, headTree: 'T' })
    expect(plan(p, { effects: merged, reads: { step: 'record', mergeTree: 'X', headTree: 'T' } })).toMatchObject({ treeVerified: false })
  })

  test('step 9 fast-forwards the integration branch to head_sha, and a moved branch is left with a note', () => {
    const p = promotion({ step: 'fast-forward', headSha: 'h', mergeSha: 'm' })
    expect(plan(p)).toEqual({ kind: 'effect', effect: { kind: 'fast-forward', effectKey: 'promo:promo-1:fast-forward', command: { repo: 'o/r', branch: p.branch, sha: 'h', cwd: '/main' } } })
    expect(plan(p, { effects: [effect(p, 'fast-forward', 'done', { fastForwarded: true, head: 'h' })] })).toEqual({ kind: 'fast-forwarded', fastForwarded: true, note: null })
    const moved = plan(p, { effects: [effect(p, 'fast-forward', 'done', { fastForwarded: false, refused: true, head: 'z' })] })
    expect(moved.kind === 'fast-forwarded' && moved.fastForwarded).toBe(false)
    expect(moved.kind === 'fast-forwarded' && moved.note).toContain('moved to z')
  })

  test('step 10 finishes merged; a cancellation after the merge says it came too late', () => {
    expect(plan(promotion({ step: 'finish', mergeSha: 'm' }))).toEqual({ kind: 'finish', outcome: 'merged', detail: null })
    const late = plan(promotion({ step: 'finish', mergeSha: 'm', cancelReason: 'stop' }))
    expect(late.kind === 'finish' && late.detail?.note).toContain('too late')
  })

  test('Cancel before the merge finishes cancelled; a merge in flight settles first', () => {
    const p = promotion({ step: 'ci', cancelReason: 'not now' })
    expect(plan(p)).toEqual({ kind: 'finish', outcome: 'cancelled', detail: { message: 'Cancelled by the owner: not now' } })
    const merging = promotion({ step: 'merge', headSha: 'h', cancelReason: 'not now' })
    expect(plan(merging, { effects: [effect(merging, 'merge', 'running', null, 0)] }).kind).toBe('wait')
    const merged = plan(merging, { effects: [effect(merging, 'merge', 'done', { merged: true, mergeCommit: 'm' }, 0)] })
    expect(merged).toEqual({ kind: 'patch', patch: { step: 'record' } })
  })

  test('a failed effect fails the promotion: an exhausted inspection is effect-unknown, a closed PR pr-closed', () => {
    const p = promotion({ step: 'pull-request' })
    const plain = plan(p, { effects: [effect(p, 'open-pr', 'failed')] })
    expect(plain.kind === 'fail' && plain.failure).toBe('effect-failed')
    const unknown = plan(p, { effects: [effect(p, 'open-pr', 'failed', { unknown: true })] })
    expect(unknown.kind === 'fail' && unknown.failure).toBe('effect-unknown')
    const m = promotion({ step: 'merge', headSha: 'h', prNumber: 9 })
    const closed = plan(m, { effects: [effect(m, 'merge', 'failed', { stop: 'pr-closed' }, 0)] })
    expect(closed.kind === 'fail' && closed.failure).toBe('pr-closed')
  })
})

describe('planPromotionStep under holds (revision-control 3.3)', () => {
  const held = ['api', 'ui']

  test('a hold before the merge: slot through re-read wait at held; branch and pull-request wait in place', () => {
    for (const step of ['slot', 'up-to-date', 'ci', 're-read'] as const) {
      expect(plan(promotion({ step }), { heldChanges: held })).toEqual({ kind: 'held' })
    }
    expect(plan(promotion({ step: 'branch' }), { heldChanges: held })).toEqual({ kind: 'wait', reason: `the hold on ${held.join(', ')} covers this promotion's carried changes` })
    expect(plan(promotion({ step: 'pull-request' }), { heldChanges: held }).kind).toBe('wait')
  })

  test('a hold at merge: a merge not yet created waits at held; a merge in flight settles', () => {
    const p = promotion({ step: 'merge', headSha: 'h', prNumber: 9 })
    expect(plan(p, { heldChanges: held })).toEqual({ kind: 'held' })
    expect(plan(p, { heldChanges: held, effects: [effect(p, 'merge', 'pending', {}, 0)] })).toEqual({ kind: 'wait', reason: 'merging pull request 9' })
  })

  test('steps past the merge are ungated: finish finishes merged under a hold', () => {
    expect(plan(promotion({ step: 'finish', mergeSha: 'm' }), { heldChanges: held })).toEqual({ kind: 'finish', outcome: 'merged', detail: null })
    const p = promotion({ step: 'record', headSha: 'h' })
    const merged = [effect(p, 'merge', 'done', { merged: true, mergeCommit: 'm' }, 0)]
    expect(plan(p, { heldChanges: held, effects: merged, reads: { step: 'record', mergeTree: 'T', headTree: 'T' } })).toEqual({ kind: 'record', mergeSha: 'm', treeVerified: true, headTree: 'T' })
  })

  test('step held: a standing hold waits; release retakes the slot or re-runs up-to-date from its own slot', () => {
    const p = promotion({ step: 'held' })
    expect(plan(p, { heldChanges: held })).toEqual({ kind: 'wait', reason: `the hold on ${held.join(', ')} covers this promotion's carried changes` })
    expect(plan(p)).toEqual({ kind: 'take-slot' })
    expect(plan(p, { slot: { holderKind: 'promotion', holderId: p.id, label: p.promotionBranch } })).toEqual({ kind: 'patch', patch: { step: 'up-to-date' } })
    expect(plan(p, { slot: { holderKind: 'change', holderId: 'x', label: 'exec-1/a' } })).toEqual({ kind: 'wait', reason: 'waits for the landing slot, held by exec-1/a' })
  })

  test('a Cancel wins over the hold: a held slot step finishes cancelled', () => {
    const p = promotion({ step: 'slot', cancelReason: 'stop it' })
    expect(plan(p, { heldChanges: held })).toEqual({ kind: 'finish', outcome: 'cancelled', detail: { message: 'Cancelled by the owner: stop it' } })
  })
})

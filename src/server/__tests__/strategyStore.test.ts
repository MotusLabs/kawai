// Durable product strategies (product-strategy 1.2/2.x): tables beside the
// team tables, revisions hashed and immutable once approved, CAS-guarded
// drafts that survive reopen, lifecycle transitions, evidence rows and the
// validated-observation refusal, and the human decision transaction —
// command-id idempotency, the CAS race, and the single impact-review item.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { StrategyStore } from '../strategy/strategyStore'
import {
  UNKNOWN,
  normalizeStrategyContent,
  type StrategyActor,
  type StrategyContent,
} from '../../shared/productStrategy'
import { hashStrategyContent } from '../strategy/strategyHash'

const TEAM = '/repo/.git'
const OTHER = '/other/.git'
const human: StrategyActor = { kind: 'human', sessionId: null }
const agent = (sessionId: string): StrategyActor => ({ kind: 'agent', sessionId })

const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  purpose: 'Supervised autonomous development',
  primaryUsers: 'Small platform teams',
  needsOutcomes: 'Ship without babysitting agents',
  productApproach: 'One operator directing a team of agents',
  useCases: [{ userOrSituation: 'lead', trigger: 'task', wantedOutcome: 'lands reviewed', currentObstacle: 'queue', desiredExperience: 'agents draft', successSignal: 'latency', constraints: 'no force-push' }],
  principles: [{ principle: 'runtime records', tradeoff: 'slower' }],
  boundaries: ['no cross-repo'],
  successMeasures: [{ outcome: 'stability', measure: 'revisions/month', baseline: UNKNOWN, target: UNKNOWN }],
  claims: [{ text: 'a claim', kind: 'owner_preference' }],
  openQuestions: ['who owns multi-team repos?'],
  decisions: [],
  ...overrides,
})

describe('StrategyStore', () => {
  let dir: string
  let dbPath: string
  let db: SessionDatabase
  let strategies: StrategyStore

  const open = () => {
    db = initDatabase({ path: dbPath })
    strategies = new StrategyStore(db.db)
    draftCounter = 0
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-strategy-'))
    dbPath = path.join(dir, 'strategy.db')
    open()
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const reopen = () => { db.close(); open() }

  const create = (overrides: Partial<Parameters<StrategyStore['create']>[0]> = {}) => strategies.create({
    productId: 'kawai', title: 'Kawai', owner: human, teamId: TEAM, worktrees: ['/repo'], ...overrides,
  })
  let draftCounter = 0
  const submitted = (strategyId: string, body: Record<string, unknown> = content(), author = agent('chat-1')) => {
    const saved = strategies.saveDraft(strategyId, { draftId: `d${++draftCounter}`, author, content: body, expectedDraftHash: null })
    if (!saved.ok) throw new Error(saved.message)
    return strategies.submitRevision(strategyId, { author, content: saved.draft.content, impactProposal: saved.draft.impactProposal })
  }

  test('tables sit beside team tables and migrations keep existing data', () => {
    // Pre-existing team data in the same database survives the new tables.
    const task = new TaskStore(db.db, new MailboxStore(db.db))
      .create({ teamId: TEAM, title: 'Export', direction: 'CSV', creator: agent('chat-lead') })
    reopen()
    expect(new TaskStore(db.db, new MailboxStore(db.db)).get(task.id)).toMatchObject({ title: 'Export' })
    const strategy = create()
    reopen()
    expect(strategies.get(strategy.id)).toMatchObject({ productId: 'kawai', title: 'Kawai' })
    const names = (db.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'strategy%' OR name='product_strategies' ORDER BY name`).all() as Array<{ name: string }>).map(row => row.name)
    expect(names).toContain('product_strategies')
    expect(names).toContain('strategy_revisions')
    expect(names).toContain('strategy_drafts')
    expect(names).toContain('strategy_evidence')
    expect(names).toContain('strategy_decisions')
    expect(names).toContain('strategy_impact_reviews')
    expect(names).toContain('strategy_repo_bindings')
    // Idempotency is a database fact: the unique constraints exist (D1/D4).
    const indexes = (db.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('strategy_decisions','strategy_impact_reviews')`).all() as Array<{ name: string }>).map(row => row.name)
    expect(indexes).toContain('sqlite_autoindex_strategy_decisions_1')
    expect(indexes).toContain('sqlite_autoindex_strategy_impact_reviews_1')
  })

  test('create binds the owning team and its worktrees; one product per team', () => {
    const strategy = create({ worktrees: ['/repo', '/repo-feat'] })
    expect(strategy.owner).toEqual(human)
    expect(strategy.currentApprovedRevision).toBeNull()
    expect(strategy.repoBindings).toEqual([
      { root: TEAM, kind: 'team' },
      { root: '/repo', kind: 'worktree' },
      { root: '/repo-feat', kind: 'worktree' },
    ])
    expect(strategies.listForTeam(TEAM).map(row => row.id)).toEqual([strategy.id])
    expect(strategies.listForTeam(OTHER)).toEqual([])
    expect(strategies.forTeam(TEAM)!.id).toBe(strategy.id)
    // A second product cannot bind the same team's repository.
    expect(() => create({ productId: 'kawai-2', title: 'Again' })).toThrow(/UNIQUE|unique/i)
    // Distinct product ids are required even for other teams.
    expect(() => create({ teamId: OTHER, worktrees: [] })).toThrow(/UNIQUE|unique/i)
    const other = create({ productId: 'other-product', teamId: OTHER, worktrees: [] })
    expect(strategies.forTeam(OTHER)!.id).toBe(other.id)
  })

  test('drafts carry every template section and a stable canonical hash', () => {
    const strategy = create()
    const saved = strategies.saveDraft(strategy.id, { draftId: 'd1', author: agent('chat-1'), content: content(), expectedDraftHash: null })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const sections = Object.keys(saved.draft.content)
    expect(sections.sort()).toEqual(['boundaries', 'claims', 'decisions', 'needsOutcomes', 'openQuestions', 'primaryUsers', 'principles', 'productApproach', 'purpose', 'successMeasures', 'useCases'])
    expect(saved.draft.contentHash).toBe(hashStrategyContent(normalizeStrategyContent(content())))
    // The same content saved as another draft hashes identically.
    const second = strategies.saveDraft(strategy.id, { draftId: 'd2', author: human, content: content(), expectedDraftHash: null })
    expect(second.ok && second.draft.contentHash).toBe(saved.draft.contentHash)
  })

  test('validated observation without a source is refused; other kinds pass', () => {
    const strategy = create()
    const refused = strategies.saveDraft(strategy.id, { draftId: 'bad', author: agent('chat-1'), content: content({ claims: [{ text: 'X', kind: 'validated_observation' }] }), expectedDraftHash: null })
    expect(refused).toMatchObject({ ok: false, reason: 'content' })
    expect(refused.ok === false && refused.message).toContain('names no source')
    for (const kind of ['owner_preference', 'explicit_user_statement', 'agent_interpretation', 'proposed_choice', 'hypothesis']) {
      const ok = strategies.saveDraft(strategy.id, { draftId: `d-${kind}`, author: agent('chat-1'), content: content({ claims: [{ text: 'x', kind }] }), expectedDraftHash: null })
      expect(ok.ok).toBe(true)
    }
  })

  test('Unknown baselines and targets pass through; no metric is invented', () => {
    const strategy = create()
    const saved = strategies.saveDraft(strategy.id, { draftId: 'd', author: agent('chat-1'), content: content({ successMeasures: [{ outcome: 'A', measure: 'm' }] }), expectedDraftHash: null })
    const measure = saved.ok ? saved.draft.content.successMeasures[0] : null
    expect(measure).toMatchObject({ baseline: UNKNOWN, target: UNKNOWN })
    expect(measure!.baseline).not.toMatch(/\d/)
    expect(measure!.target).not.toMatch(/\d/)
  })

  test('draft CAS: first editor wins, the second is refused with the stored draft', () => {
    const strategy = create()
    const first = strategies.saveDraft(strategy.id, { draftId: 'shared', author: human, content: content({ purpose: 'First' }), expectedDraftHash: null })
    expect(first.ok).toBe(true)
    const second = strategies.saveDraft(strategy.id, { draftId: 'shared', author: agent('chat-2'), content: content({ purpose: 'Second' }), expectedDraftHash: null })
    expect(second).toMatchObject({ ok: false, reason: 'conflict' })
    expect(second.ok === false && second.stored).toMatchObject({ contentHash: first.ok ? first.draft.contentHash : '' })
    // The winner's text stands; the loser's was never written.
    expect(strategies.getDraft(strategy.id, 'shared')!.content.purpose).toBe('First')
    // A stale base revision is refused the same way.
    const movedBase = strategies.saveDraft(strategy.id, { draftId: 'shared', author: human, content: content({ purpose: 'Third' }), expectedDraftHash: first.ok ? first.draft.contentHash : null, expectedBaseRevision: 7 })
    expect(movedBase).toMatchObject({ ok: false, reason: 'conflict' })
    // Saving over a withdrawn (deleted) draft with the old hash is refused.
    strategies.deleteDraft(strategy.id, 'shared')
    const unrestorable = strategies.saveDraft(strategy.id, { draftId: 'shared', author: human, content: content(), expectedDraftHash: first.ok ? first.draft.contentHash : null })
    expect(unrestorable).toMatchObject({ ok: false, reason: 'conflict' })
    expect(unrestorable.ok === false && unrestorable.stored).toBeNull()
  })

  test('drafts survive a store reopen with content, hash, and timestamps', () => {
    const strategy = create()
    strategies.saveDraft(strategy.id, { draftId: 'd', author: agent('chat-1'), content: content({ purpose: 'Durable' }), impactProposal: 'revises purpose', expectedDraftHash: null })
    reopen()
    const draft = strategies.getDraft(strategy.id, 'd')!
    expect(draft).toMatchObject({ draftId: 'd', author: agent('chat-1'), impactProposal: 'revises purpose', baseRevision: null })
    expect(draft.content.purpose).toBe('Durable')
    expect(draft.contentHash).toBe(hashStrategyContent(normalizeStrategyContent(content({ purpose: 'Durable' }))))
    // And the CAS still guards it after the reopen.
    const conflict = strategies.saveDraft(strategy.id, { draftId: 'd', author: agent('chat-1'), content: content(), expectedDraftHash: null })
    expect(conflict).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('submit creates revision 1 in review with evidence rows per claim', () => {
    const strategy = create()
    const body = content({ claims: [
      { text: 'owner wants gates', kind: 'owner_preference' },
      { text: 'demand 20%', kind: 'hypothesis', limitations: 'no data' },
      { text: '42% archived', kind: 'validated_observation', source: 'db counts' },
    ] })
    const result = submitted(strategy.id, body)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.revision).toMatchObject({ revision: 1, status: 'in_review', author: agent('chat-1') })
    expect(result.revision.content.claims.map(claim => claim.kind)).toEqual(['owner_preference', 'hypothesis', 'validated_observation'])
    expect(strategies.evidence(strategy.id, 1)).toEqual([
      expect.objectContaining({ claimRef: 'c1', kind: 'owner_preference', sourceRef: null }),
      expect.objectContaining({ claimRef: 'c2', kind: 'hypothesis', limitations: 'no data' }),
      expect.objectContaining({ claimRef: 'c3', kind: 'validated_observation', sourceRef: 'db counts' }),
    ])
  })

  test('approval binds the exact revision and hash, records scope and open questions, supersedes the prior', () => {
    const strategy = create()
    const first = submitted(strategy.id, content({ purpose: 'v1' }))
    const second = submitted(strategy.id, content({ purpose: 'v2' }), agent('chat-2'))
    const rev1 = first.ok ? first.revision : null
    const rev2 = second.ok ? second.revision : null
    // Approving v1 first, then v2: the new approval supersedes the old.
    strategies.approve(strategy.id, { revision: 1, contentHash: rev1!.contentHash, commandId: 'cmd-0', expectedCurrentRevision: null, actor: human })
    const outcome = strategies.approve(strategy.id, {
      revision: 2, contentHash: rev2!.contentHash, commandId: 'cmd-1', expectedCurrentRevision: 1,
      approvalScope: 'Direction only; success measures stay open', openQuestions: 'Baseline unmeasured until Q4', actor: human,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.decision).toMatchObject({
      decision: 'approve', revision: 2, contentHash: rev2!.contentHash, actor: human,
      approvalScope: 'Direction only; success measures stay open', openQuestions: 'Baseline unmeasured until Q4',
    })
    expect(outcome.strategy.currentApprovedRevision).toBe(2)
    // Earlier revisions stay readable with their original content.
    expect(strategies.revision(strategy.id, 1)).toMatchObject({ status: 'superseded' })
    expect(strategies.revision(strategy.id, 1)!.content.purpose).toBe('v1')
    expect(strategies.revision(strategy.id, 2)).toMatchObject({ status: 'approved' })
    // Approved content is immutable: nothing rewrites it (no mutation path),
    // and the hash still verifies.
    expect(strategies.revision(strategy.id, 2)!.contentHash).toBe(hashStrategyContent(normalizeStrategyContent(content({ purpose: 'v2' }))))
    // A draft saved afterwards does not touch the approved revision.
    strategies.saveDraft(strategy.id, { draftId: 'next', author: agent('chat-3'), content: content({ purpose: 'v3 draft' }), expectedDraftHash: null })
    expect(strategies.revision(strategy.id, 2)!.content.purpose).toBe('v2')
    expect(strategies.get(strategy.id)!.currentApprovedRevision).toBe(2)
  })

  test('command-id idempotency: retry replays, different payload is refused, stale is refused', () => {
    const strategy = create()
    const result = submitted(strategy.id)
    const revision = result.ok ? result.revision : null
    const input = { revision: 1, contentHash: revision!.contentHash, commandId: 'cmd-approve', expectedCurrentRevision: null, actor: human } as const
    const first = strategies.approve(strategy.id, input)
    expect(first.ok).toBe(true)
    const retry = strategies.approve(strategy.id, input)
    expect(retry).toMatchObject({ ok: true, replayed: true })
    expect(retry.ok && retry.decision.id).toBe(first.ok ? first.decision.id : '')
    expect(strategies.decisions(strategy.id)).toHaveLength(1)
    // Same command id, different payload: refused, record unchanged.
    const mismatch = strategies.approve(strategy.id, { ...input, contentHash: '0'.repeat(64) })
    expect(mismatch).toMatchObject({ ok: false, reason: 'payload' })
    // A wrong hash under a new command id, on a revision still in review, is stale.
    const fresh = submitted(strategy.id, content({ purpose: 'second' }), agent('chat-2'))
    const wrongHash = strategies.approve(strategy.id, { revision: 2, contentHash: '0'.repeat(64), commandId: 'cmd-2', expectedCurrentRevision: 1, actor: human })
    expect(wrongHash).toMatchObject({ ok: false, reason: 'stale' })
    expect(wrongHash.ok === false && wrongHash.message).toContain('hash')
    expect(fresh.ok).toBe(true)
    // Approving the now-approved revision again is stale, never two actives.
    const again = strategies.approve(strategy.id, { ...input, commandId: 'cmd-3', expectedCurrentRevision: 1 })
    expect(again).toMatchObject({ ok: false, reason: 'stale' })
    expect(strategies.get(strategy.id)!.currentApprovedRevision).toBe(1)
  })

  test('concurrent approvals settle on one: the CAS race refuses the loser', () => {
    const strategy = create()
    const first = submitted(strategy.id, content({ purpose: 'a' }))
    const second = submitted(strategy.id, content({ purpose: 'b' }), agent('chat-2'))
    const rev1 = first.ok ? first.revision : null
    const rev2 = second.ok ? second.revision : null
    const winner = strategies.approve(strategy.id, { revision: 1, contentHash: rev1!.contentHash, commandId: 'w', expectedCurrentRevision: null, actor: human })
    expect(winner.ok).toBe(true)
    // The loser opened its dialog before the winner landed: same expected
    // prior, different revision — refused as stale, exactly one active.
    const loser = strategies.approve(strategy.id, { revision: 2, contentHash: rev2!.contentHash, commandId: 'l', expectedCurrentRevision: null, actor: human })
    expect(loser).toMatchObject({ ok: false, reason: 'stale' })
    expect(strategies.get(strategy.id)!.currentApprovedRevision).toBe(1)
    expect(strategies.revision(strategy.id, 1)).toMatchObject({ status: 'approved' })
    expect(strategies.revision(strategy.id, 2)).toMatchObject({ status: 'in_review' })
  })

  test('publication creates exactly one impact-review item and nothing else', () => {
    const strategy = create()
    const result = submitted(strategy.id)
    const revision = result.ok ? result.revision : null
    const tasks = new TaskStore(db.db, new MailboxStore(db.db))
    const before = tasks.list(TEAM).length
    const outcome = strategies.approve(strategy.id, { revision: 1, contentHash: revision!.contentHash, commandId: 'pub', expectedCurrentRevision: null, actor: human })
    expect(outcome.ok).toBe(true)
    expect(strategies.impactReviews(strategy.id)).toEqual([expect.objectContaining({ revision: 1, commandId: 'pub', state: 'pending' })])
    // A retried publish does not duplicate the item.
    strategies.approve(strategy.id, { revision: 1, contentHash: revision!.contentHash, commandId: 'pub', expectedCurrentRevision: null, actor: human })
    expect(strategies.impactReviews(strategy.id)).toHaveLength(1)
    // No task, mail, or session work appeared; the strategy tables hold
    // exactly the decision and the item.
    expect(tasks.list(TEAM).length).toBe(before)
    expect(strategies.decisions(strategy.id)).toHaveLength(1)
    // A save and a submit never create an item.
    strategies.saveDraft(strategy.id, { draftId: 'after-publish', author: human, content: content({ purpose: 'next' }), expectedDraftHash: null })
    submitted(strategy.id, content({ purpose: 'next' }), agent('chat-9'))
    expect(strategies.impactReviews(strategy.id)).toHaveLength(1)
  })

  test('withdrawal marks the revision, keeps history and decisions, and clears an active pointer', () => {
    const strategy = create()
    const result = submitted(strategy.id)
    const revision = result.ok ? result.revision : null
    strategies.approve(strategy.id, { revision: 1, contentHash: revision!.contentHash, commandId: 'a1', expectedCurrentRevision: null, actor: human })
    const withdrawn = strategies.withdrawRevision(strategy.id, { revision: 1, commandId: 'w1', actor: human })
    expect(withdrawn.ok).toBe(true)
    expect(strategies.revision(strategy.id, 1)).toMatchObject({ status: 'withdrawn' })
    expect(strategies.get(strategy.id)!.currentApprovedRevision).toBeNull()
    // The prior approval record and impact item remain readable.
    expect(strategies.decisions(strategy.id).map(row => row.decision)).toEqual(['approve', 'withdraw'])
    expect(strategies.impactReviews(strategy.id)).toHaveLength(1)
    // A withdrawn revision is no longer approvable.
    const stale = strategies.approve(strategy.id, { revision: 1, contentHash: revision!.contentHash, commandId: 'a2', expectedCurrentRevision: null, actor: human })
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    // Withdraw replays by command id and refuses a different payload.
    const replay = strategies.withdrawRevision(strategy.id, { revision: 1, commandId: 'w1', actor: human })
    expect(replay).toMatchObject({ ok: true, replayed: true })
    expect(strategies.withdrawRevision(strategy.id, { revision: 1, commandId: 'w2', actor: human })).toMatchObject({ ok: false, reason: 'stale' })
  })

  test('withdrawn InReview revisions and drafts stay listed in history order across reopen', () => {
    const strategy = create()
    submitted(strategy.id, content({ purpose: 'r1' }))
    submitted(strategy.id, content({ purpose: 'r2' }), agent('chat-2'))
    strategies.withdrawRevision(strategy.id, { revision: 2, commandId: 'w', actor: human })
    strategies.saveDraft(strategy.id, { draftId: 'kept', author: human, content: content({ purpose: 'draft' }), expectedDraftHash: null })
    reopen()
    expect(strategies.revisions(strategy.id).map(row => [row.revision, row.status, row.content.purpose])).toEqual([
      [1, 'in_review', 'r1'],
      [2, 'withdrawn', 'r2'],
    ])
    expect(strategies.drafts(strategy.id).map(draft => draft.draftId)).toEqual(['d1', 'd2', 'kept'])
    expect(strategies.evidence(strategy.id).map(row => row.revision)).toEqual([1, 2])
  })

  test('detail assembles the whole record', () => {
    const strategy = create()
    const saved = strategies.saveDraft(strategy.id, { draftId: 'd', author: agent('chat-1'), content: content(), expectedDraftHash: null })
    const result = strategies.submitRevision(strategy.id, { author: agent('chat-1'), content: saved.ok ? saved.draft.content : content() })
    const revision = result.ok ? result.revision : null
    strategies.approve(strategy.id, { revision: 1, contentHash: revision!.contentHash, commandId: 'c', expectedCurrentRevision: null, actor: human })
    const detail = strategies.detail(strategy.id)!
    expect(detail.strategy.id).toBe(strategy.id)
    expect(detail.revisions).toHaveLength(1)
    expect(detail.drafts.map(draft => draft.draftId)).toEqual(['d'])
    expect(detail.decisions.map(row => row.decision)).toEqual(['approve'])
    expect(detail.impactReviews).toHaveLength(1)
    expect(detail.evidence).toHaveLength(1)
    expect(strategies.detail('strategy-missing')).toBeNull()
  })
test('a decision insert that loses the command-id race replays the recorded row and rolls back', () => {
  const strategy = create()
  const first = submitted(strategy.id, content({ purpose: 'v1' }))
  const rev1 = first.ok ? first.revision : null
  strategies.approve(strategy.id, { revision: 1, contentHash: rev1!.contentHash, commandId: 'shared', expectedCurrentRevision: null, actor: human })
  const second = submitted(strategy.id, content({ purpose: 'v2' }), agent('chat-2'))
  const rev2 = second.ok ? second.revision : null
  // Simulate the lost race: the pre-check misses the recorded decision, so
  // the INSERT itself meets UNIQUE(strategy_id, command_id).
  class Racing extends StrategyStore {
    decisionByCommand(): null { return null }
  }
  const racing = new Racing(db.db)
  const outcome = racing.approve(strategy.id, { revision: 2, contentHash: rev2!.contentHash, commandId: 'shared', expectedCurrentRevision: 1, actor: human })
  expect(outcome).toMatchObject({ ok: false, reason: 'payload' })
  // The refused insert rolled the whole transaction back: one active, one
  // decision, one impact item, revision 2 still in review.
  expect(strategies.get(strategy.id)!.currentApprovedRevision).toBe(1)
  expect(strategies.revision(strategy.id, 1)).toMatchObject({ status: 'approved' })
  expect(strategies.revision(strategy.id, 2)).toMatchObject({ status: 'in_review' })
  expect(strategies.decisions(strategy.id)).toHaveLength(1)
  expect(strategies.impactReviews(strategy.id)).toHaveLength(1)
  // The same race on a withdraw lands the same way: replayed or refused
  // from the recorded row, never a second decision.
  const withdrawn = racing.withdrawRevision(strategy.id, { revision: 2, commandId: 'shared', actor: human })
  expect(withdrawn).toMatchObject({ ok: false, reason: 'payload' })
  expect(strategies.revision(strategy.id, 2)).toMatchObject({ status: 'in_review' })
  expect(strategies.decisions(strategy.id)).toHaveLength(1)
})

})

describe('StrategyContent round-trip through the store', () => {
  test('a revision content object survives save, submit, reopen, and re-hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-strategy-rt-'))
    const db = new Database(path.join(dir, 'rt.db'))
    const store = new StrategyStore(db)
    const strategy = store.create({ productId: 'p', title: 'P', owner: { kind: 'human', sessionId: null }, teamId: TEAM, worktrees: [] })
    const original: StrategyContent = normalizeStrategyContent(content({ successMeasures: [{ outcome: 'o', measure: 'm', baseline: '1', target: UNKNOWN }] }))
    const saved = store.saveDraft(strategy.id, { draftId: 'd', author: { kind: 'human', sessionId: null }, content: original, expectedDraftHash: null })
    expect(saved.ok).toBe(true)
    const submitted = store.submitRevision(strategy.id, { author: { kind: 'human', sessionId: null }, content: saved.ok ? saved.draft.content : original })
    expect(submitted.ok && submitted.revision.content).toEqual(original)
    const reopened = new StrategyStore(new Database(path.join(dir, 'rt.db')))
    const round = reopened.revision(strategy.id, 1)!
    expect(round.content).toEqual(original)
    expect(round.contentHash).toBe(hashStrategyContent(original))
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

})

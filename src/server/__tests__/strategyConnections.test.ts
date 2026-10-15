// Strategy subscriptions and human actions over the chat connection
// (product-strategy 3.1): team-scoped snapshot/detail pushes, the no-record
// snapshot (capture affordance), every human action — capture-through-save,
// submit, approve with command id, withdraw — and the CAS conflict answer
// that keeps the caller's text client-side (S12).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { initDatabase, type SessionDatabase } from '../db'
import { StrategyService } from '../strategy/StrategyService'
import { StrategyStore } from '../strategy/strategyStore'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { PlanStore } from '../plans/planStore'
import { MailboxStore } from '../team/mailboxStore'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'

let dir: string
let db: SessionDatabase
let strategies: StrategyService
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let teams: Map<string, TeamIdentity>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-strategy-connections-'))
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  // Known team paths (team-workspace-pages D1): this repository and another team's.
  teams = new Map([['/repo', { teamId: 'team', groupsRoot: dir }], ['/other', { teamId: 'other', groupsRoot: dir }]])
  strategies = new StrategyService(new StrategyStore(db.db), { getSession: () => undefined })
  messages = []
  connection = { send: message => messages.push(message) }
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    strategies,
    impact: new ImpactService(new ImpactStore(db.db), {
      strategies: strategies.store, plans: new PlanStore(db.db), mail: new MailboxStore(db.db), getSession: () => undefined,
    }),
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  strategies.store.subscribe(strategy => {
    const teamId = strategy.repoBindings.find(binding => binding.kind === 'team')?.root
    if (teamId) connections.publishStrategies(teamId)
  })
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)

const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  purpose: 'Supervised autonomous development',
  claims: [{ text: 'leads want gates', kind: 'owner_preference' }],
  ...overrides,
})

test('open snapshots the team: null when no record, detail once captured, pushes on change', async () => {
  await send({ type: 'strategy-open', teamPath: '/repo' })
  expect(last('strategy-snapshot')).toMatchObject({ teamPath: '/repo', teamId: 'team', strategy: null })
  // Capture through the first human save creates the record and pushes.
  await send({ type: 'strategy-save-draft', teamPath: '/repo', requestId: 'r1', productId: 'kawai', title: 'Kawai', content: content(), expectedDraftHash: null })
  expect(last('strategy-result')).toMatchObject({ teamPath: '/repo', requestId: 'r1', draft: { draftId: 'human' } })
  expect(last('strategy-snapshot')!.strategy).toMatchObject({ productId: 'kawai', owner: { kind: 'human', sessionId: null } })
  expect(last('strategy-detail')!.detail.strategy.productId).toBe('kawai')
  // A change in another team does not reach this subscriber.
  await send({ type: 'strategy-open', teamPath: '/other' })
  const count = messages.length
  const stored = strategies.store.getDraft(strategies.store.forTeam('team')!.id, 'human')!
  await strategies.saveDraft(human(), { content: content({ purpose: 'second save' }), expected_draft_hash: stored.contentHash })
  expect(last('strategy-detail')!.detail.drafts.find(draft => draft.draftId === 'human')!.content.purpose).toBe('second save')
  expect(messages.length).toBeGreaterThan(count)
  await send({ type: 'strategy-close', teamPath: '/repo' })
  connections.disconnect(connection)
})

test('a CAS conflict answers with the stored draft and keeps the caller out of the write (S12)', async () => {
  await send({ type: 'strategy-open', teamPath: '/repo' })
  await send({ type: 'strategy-save-draft', teamPath: '/repo', requestId: 'r1', productId: 'kawai', title: 'Kawai', content: content({ purpose: 'first' }), expectedDraftHash: null })
  const first = last('strategy-result')!.draft!
  // A second editor saving from the same base (no expectation of the change).
  await send({ type: 'strategy-save-draft', teamPath: '/repo', requestId: 'r2', content: content({ purpose: 'second' }), expectedDraftHash: null })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r2', error: expect.stringContaining('changed while you edited') })
  expect(last('strategy-result')!.conflict).toMatchObject({ draftId: 'human', contentHash: first.contentHash })
  // The stored draft is the first editor's text.
  expect(last('strategy-detail')!.detail.drafts[0]!.content.purpose).toBe('first')
})

test('submit, approve with command id, and withdraw run as the human; approve retry replays', async () => {
  await send({ type: 'strategy-open', teamPath: '/repo' })
  await send({ type: 'strategy-save-draft', teamPath: '/repo', requestId: 'r1', productId: 'kawai', title: 'Kawai', content: content(), expectedDraftHash: null })
  await send({ type: 'strategy-submit', teamPath: '/repo', requestId: 'r2' })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r2', revision: { revision: 1, status: 'in_review' } })
  const revision = last('strategy-result')!.revision!
  await send({
    type: 'strategy-approve', teamPath: '/repo', requestId: 'r3', revision: 1, contentHash: revision.contentHash,
    commandId: 'approve-1', expectedCurrentRevision: null, approvalScope: 'Direction', openQuestions: 'baseline unknown',
  })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r3' })
  expect(last('strategy-snapshot')!.strategy!.currentApprovedRevision).toBe(1)
  expect(last('strategy-detail')!.detail.decisions[0]).toMatchObject({ decision: 'approve', approvalScope: 'Direction', openQuestions: 'baseline unknown' })
  expect(last('strategy-detail')!.detail.impactReviews).toHaveLength(1)
  // Retry with the same command id replays without a second record.
  await send({
    type: 'strategy-approve', teamPath: '/repo', requestId: 'r4', revision: 1, contentHash: revision.contentHash,
    commandId: 'approve-1', expectedCurrentRevision: null,
  })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r4' })
  expect(last('strategy-detail')!.detail.decisions).toHaveLength(1)
  expect(last('strategy-detail')!.detail.impactReviews).toHaveLength(1)
  // Withdraw the revision.
  await send({ type: 'strategy-withdraw', teamPath: '/repo', requestId: 'r5', revision: 1, commandId: 'withdraw-1' })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r5' })
  expect(last('strategy-detail')!.detail.revisions[0]!.status).toBe('withdrawn')
  expect(last('strategy-snapshot')!.strategy!.currentApprovedRevision).toBeNull()
  // History kept: the decision records and impact item remain.
  expect(last('strategy-detail')!.detail.decisions.map(row => row.decision)).toEqual(['approve', 'withdraw'])
  expect(last('strategy-detail')!.detail.impactReviews).toHaveLength(1)
})

test('a stale approval is answered as an error, inline for the client (S17)', async () => {
  await send({ type: 'strategy-open', teamPath: '/repo' })
  await send({ type: 'strategy-save-draft', teamPath: '/repo', requestId: 'r1', productId: 'kawai', title: 'Kawai', content: content(), expectedDraftHash: null })
  await send({ type: 'strategy-submit', teamPath: '/repo', requestId: 'r2' })
  const revision = last('strategy-result')!.revision!
  await send({ type: 'strategy-withdraw', teamPath: '/repo', requestId: 'r3', revision: 1, commandId: 'w' })
  await send({
    type: 'strategy-approve', teamPath: '/repo', requestId: 'r4', revision: 1, contentHash: revision.contentHash,
    commandId: 'late', expectedCurrentRevision: null,
  })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r4', error: expect.stringContaining('withdrawn') })
})

test('refusals answer with the service message and nothing is written', async () => {
  await send({ type: 'strategy-open', teamPath: '/repo' })
  await send({ type: 'strategy-approve', teamPath: '/repo', requestId: 'r1', revision: 1, contentHash: '0'.repeat(64), commandId: 'x', expectedCurrentRevision: null })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r1', error: expect.stringContaining('no strategy record') })
  // A session whose team cannot be resolved is refused, not crashed.
  await send({ type: 'strategy-save-draft', teamPath: '/elsewhere', requestId: 'r2', productId: 'kawai', title: 'K', content: content(), expectedDraftHash: null })
  expect(last('strategy-result')).toMatchObject({ requestId: 'r2', error: 'unknown-team: /elsewhere' })
})

test('opening a team path that names no known team is refused and subscribes nothing', async () => {
  await send({ type: 'strategy-open', teamPath: '/elsewhere' })
  expect(messages).toEqual([{ type: 'error', message: 'unknown-team: /elsewhere' }])
  await strategies.saveDraft(human(), { product_id: 'kawai', title: 'Kawai', content: content(), expected_draft_hash: null })
  expect(messages).toHaveLength(1)
})

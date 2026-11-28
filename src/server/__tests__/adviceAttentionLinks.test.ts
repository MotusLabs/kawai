// Advice on existing attention items (process-quota-history-and-incident-
// advice D6, tasks 4.4/4.6, contract r2 A5): a context-exhaustion or
// plan-stall item that has incident advice links to it — the same item, no
// second alert — and an item without advice links nothing. Pure sources
// first, then the real stores, then a real ChatSessionManager's workspace
// read (exhaustionEpisodes and planAttentionFacts carry the advice store),
// whose Metrics subscription carries a linked target older than the newest 20.
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChangeSupervision } from '../../shared/planSupervision'
import type { AttentionItem } from '../../shared/teamWorkspace'
import type { ServerMessage } from '../../shared/types'
import { ChatConnections } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { RecommendationStore } from '../metrics/recommendations/store'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PlanStore } from '../plans/planStore'
import { SessionRegistry } from '../SessionRegistry'
import { planAttentionFacts, type PlanAttentionFact, type PlanAttentionReads } from '../team/planAttention'
import { attentionItems, type AttentionInput, WorkspaceRead } from '../team/workspaceRead'
import type { ExhaustionFact } from '../team/workspaceExhaustion'
import { schemaDb } from './schemaDb'

const EPISODE = '2026-10-20T10:00:00.000Z'
const STALL_ID = `plan-stall:exec-1:api:${EPISODE}`

const stall = (kind: 'no-progress' | 'convergence'): ChangeSupervision => ({
  change: 'api', outcome: 'stalled', stage: 'implement', alsoApplying: [], holder: null, progress: null, activity: null,
  landing: null, lastRound: null,
  cause: { kind: 'stall', stall: kind === 'convergence' ? 'convergence' : 'no-progress' } as ChangeSupervision['cause'],
  stall: (kind === 'convergence'
    ? { kind, episodeKey: EPISODE, anchorAt: EPISODE, deadlineAt: EPISODE, idle: false, awaitingRevision: 3, cardId: 'card-1' }
    : { kind, episodeKey: EPISODE, anchorAt: EPISODE, deadlineAt: EPISODE, idle: false }) as ChangeSupervision['stall'],
})

const fact = (kind: 'no-progress' | 'convergence', advice?: Record<string, string>): PlanAttentionFact => ({
  teamId: 'team', planId: 'plan-1', planTitle: 'Wave D', leadGroup: 'lead', executionId: 'exec-1',
  changes: [{ taskId: 'task-api', generation: 1, supervision: stall(kind), amendRationale: kind === 'convergence' ? 'split it' : null }],
  openCards: [], fixes: [], failedPromotion: null, correctionOpen: false, ...(advice ? { advice } : {}),
})

const episodeFact = (recommendationId?: string | null): ExhaustionFact => ({
  episode: {
    sessionId: 's1', flaggedAt: EPISODE, teamId: 'team', reason: 'prompt_too_long', taskId: null, droppedId: null,
    recipientSession: null, noteId: null, createdAt: EPISODE, ...(recommendationId !== undefined ? { recommendationId } : {}),
  },
  sessionName: 'dev one', currentFlagAt: EPISODE, droppedState: null, taskStatus: null, newestDispatchAt: null,
})

const items = (input: Partial<AttentionInput>): AttentionItem[] => attentionItems({
  sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: (id: string) => id,
  pendingAcceptance: [], outboundViolations: [], ...input,
} as AttentionInput)

test('a plan-stall item with attached advice links to it, as does its amend form; without advice it links nothing and no item is added', () => {
  const linked = items({ plans: [fact('no-progress', { [STALL_ID]: 'rec-1' })] })
  expect(linked.map(item => [item.id, item.advice])).toEqual([[STALL_ID, { recommendationId: 'rec-1' }]])
  const plain = items({ plans: [fact('no-progress')] })
  expect(plain.map(item => item.id)).toEqual([STALL_ID])
  expect(plain[0]!.advice).toBeUndefined()
  const amend = items({ plans: [fact('convergence', { [STALL_ID]: 'rec-2' })] })
  expect(amend.map(item => [item.id, item.advice])).toEqual([[`${STALL_ID}:amend`, { recommendationId: 'rec-2' }]])
  // Advice for another episode attaches nothing.
  expect(items({ plans: [fact('no-progress', { 'plan-stall:exec-1:api:other': 'rec-3' })] })[0]!.advice).toBeUndefined()
})

test('a context-exhausted item with attached advice links to it; without advice it links nothing; one item either way', () => {
  const linked = items({ exhaustion: [episodeFact('rec-ctx')] })
  expect(linked.map(item => [item.id, item.advice])).toEqual([[`context-exhausted:s1:${EPISODE}`, { recommendationId: 'rec-ctx' }]])
  for (const none of [episodeFact(null), episodeFact()]) {
    const plain = items({ exhaustion: [none] })
    expect(plain).toHaveLength(1)
    expect(plain[0]!.advice).toBeUndefined()
  }
})

test('attached advice is team-bound and the newest recommendation of an attention id wins, over the real stores', () => {
  const db = schemaDb()
  const store = new RecommendationStore(db, (() => { let at = Date.parse(EPISODE); return () => (at += 1000) })())
  const rec = (teamId: string, episodeKey: string, attentionId: string | null) => store.create({
    teamId, kind: 'quota', episodeKey, sessionId: null, taskId: 'task-api', groupId: null, profileId: 'glm', providerId: 'zai',
    attentionId, cutoff: EPISODE, snapshot: {} as never, snapshotBasis: 'incident',
  }).recommendation.id
  const first = rec('team-a', 'e1', STALL_ID)
  const newest = rec('team-a', 'e2', STALL_ID)
  rec('team-b', 'e3', 'plan-stall:exec-9:api:x')
  rec('team-a', 'e4', null)
  expect(first).not.toBe(newest)
  expect([...store.attachedAdvice('team-a')]).toEqual([[STALL_ID, newest]])
  // planAttentionFacts copies the team's map onto every plan fact.
  const plans = new PlanStore(db)
  plans.insertPlan({ teamId: 'team-a', title: 'A wave', creator: { kind: 'human', sessionId: null } })
  const reads: PlanAttentionReads = {
    db, mail: {} as never, runtime: { holder: () => null, blocker: () => null, live: () => false }, conditionsOf: () => [],
    tasks: { get: () => null }, executions: new ExecutionStore(db), plans, decisions: new DecisionStore(db), advice: store,
  }
  expect(planAttentionFacts(reads, 'team-a', new Date(EPISODE)).map(f => f.advice)).toEqual([{ [STALL_ID]: newest }])
  expect(planAttentionFacts({ ...reads, advice: undefined }, 'team-a', new Date(EPISODE))[0]!.advice).toBeUndefined()
})

let root: string | undefined
let db: SessionDatabase | undefined
let manager: ChatSessionManager | null = null
afterEach(() => {
  manager?.shutdown()
  manager = null
  db?.close()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})

test('through a real manager, a flagged session\'s context advice links from its one attention item, and the plan facts carry the advice store', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-advice-links-')))
  const repo = path.join(root, 'repo')
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 2\n---\nBuild features')
  db = initDatabase({ path: path.join(root, 'sessions.db') })
  manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    queryFactory: fixtureQueryFactory,
  })
  await manager.whenRestored()
  const dev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
  if (!dev.ok) throw new Error(dev.error)
  const sessionId = dev.session.id
  const team = await manager.teams.resolvedTeamOf(sessionId)
  if (!team) throw new Error('no team')
  // The session is flagged and its episode recorded (as the runtime does), then advice runs.
  ;(manager as unknown as { applyPatch: (id: string, patch: object) => void }).applyPatch(sessionId, { contextExhausted: { at: EPISODE, reason: 'prompt_too_long' } })
  db.db.prepare(`INSERT INTO team_exhaustion_episodes (session_id, flagged_at, team_id, reason, task_id, dropped_id, recipient_session, note_id, created_at)
    VALUES (?, ?, ?, 'prompt_too_long', NULL, NULL, NULL, NULL, ?)`).run(sessionId, EPISODE, team.teamId, EPISODE)
  manager.advice.contextFlagged(sessionId)
  const [rec] = manager.advice.store.list(team.teamId)
  expect(rec).toMatchObject({ kind: 'context', attentionId: `context-exhausted:${sessionId}:${EPISODE}` })
  const attention = new WorkspaceRead(manager).snapshot(team).attention.filter(item => item.kind === 'context-exhausted')
  expect(attention.map(item => [item.id, item.advice])).toEqual([[`context-exhausted:${sessionId}:${EPISODE}`, { recommendationId: rec!.id }]])
  // A second flag evaluation for the same episode adds no recommendation and no item.
  manager.advice.contextFlagged(sessionId)
  expect(manager.advice.store.list(team.teamId)).toHaveLength(1)
  expect(new WorkspaceRead(manager).snapshot(team).attention.filter(item => item.kind === 'context-exhausted')).toHaveLength(1)
  // The plan facts read the same store: a stall episode's advice reaches its plan fact.
  new PlanStore(db.db).insertPlan({ teamId: team.teamId, title: 'Wave', creator: { kind: 'human', sessionId: null } })
  const stallRec = manager.advice.store.create({
    teamId: team.teamId, kind: 'quota', episodeKey: 'stall-ep', sessionId, taskId: null, groupId: 'devs', profileId: 'default', providerId: null,
    attentionId: STALL_ID, cutoff: EPISODE, snapshot: {} as never, snapshotBasis: 'incident',
  }).recommendation.id
  expect(manager.planAttentionFacts(team.teamId).map(f => f.advice?.[STALL_ID])).toEqual([stallRec])

  // The link's target outside the newest 20: the Metrics subscription that
  // names it (the advice link's open) carries it; one that does not, omits it.
  for (let index = 0; index < 20; index++) {
    manager.advice.store.create({
      teamId: team.teamId, kind: 'quota', episodeKey: `newer-${index}`, sessionId, taskId: null, groupId: 'devs', profileId: 'default',
      providerId: `p${index}`, attentionId: null, cutoff: EPISODE, snapshot: {} as never, snapshotBasis: 'incident',
    })
  }
  const other = manager.advice.store.create({
    teamId: 'team-elsewhere', kind: 'quota', episodeKey: 'x', sessionId: null, taskId: null, groupId: null, profileId: null,
    providerId: null, attentionId: null, cutoff: EPISODE, snapshot: {} as never, snapshotBasis: 'incident',
  }).recommendation.id
  expect([...manager.advice.store.attachedAdvice(team.teamId)].find(([id]) => id === STALL_ID)?.[1]).toBe(stallRec)
  const router = new ChatConnections(manager)
  const snapshotIds = async (advice?: string) => {
    const sent: ServerMessage[] = []
    const connection = { send: (message: ServerMessage) => sent.push(message) }
    await router.handle(connection, { type: 'process-metrics-open', teamPath: repo, window: '7d', slice: null, ...(advice ? { advice } : {}) })
    const snapshot = sent.find((message): message is Extract<ServerMessage, { type: 'process-metrics-snapshot' }> => message.type === 'process-metrics-snapshot')
    return snapshot!.recommendations.map(rec => rec.id)
  }
  const plain = await snapshotIds()
  expect(plain).toHaveLength(20)
  expect(plain).not.toContain(stallRec)
  const linked = await snapshotIds(stallRec)
  expect(linked).toHaveLength(21)
  expect(linked.at(-1)).toBe(stallRec)
  expect(linked.slice(0, 20)).toEqual(plain)
  // Another team's id adds nothing (R7); a listed one is not repeated.
  expect(await snapshotIds(other)).toEqual(plain)
  expect(await snapshotIds(plain[3])).toEqual(plain)
})

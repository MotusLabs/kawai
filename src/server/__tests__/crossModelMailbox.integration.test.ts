// Cross-model review through the production composition (starter-team-setup
// D6, V5): a real SessionMailbox — dispatcher, ProfileRouter, the mailbox's
// cross-model wiring — routes a review handoff of an opus-authored result
// away from the idle opus reviewer: it waits naming the authors' family, and
// goes to the codex-sol reviewer once one is live. The harness is the
// waiting-reasons integration harness, trimmed.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { type ChatSessionRecord, type SessionDatabase } from '../db'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { formatEnvelope } from '../team/envelope'
import type { GroupCatalog } from '../team/groupCatalog'
import type { SessionTeams } from '../team/sessionTeams'
import { SessionMailbox } from '../team/sessionMailbox'
import { loadTeamGroups } from '../team/teamGroups'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import type { SpawnRequest, SpawnResult } from '../team/staffing'
import type { WaitingReason } from '../../shared/team'
import type { ChatPeerMessage } from '../../shared/chat'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
import { freshTestDatabase } from './helpers/testDatabase'

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let repo: string
let featX: string
let featY: string
let team: TeamIdentity

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cross-model-')))
  repo = path.join(root, 'repo')
  featX = path.join(root, 'feat-x')
  featY = path.join(root, 'feat-y')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-y', featY], repo)
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** The spawn knob: `ok`, `hold` (startup held open), or `fail` (once). */
type SpawnMode = 'ok' | 'hold' | 'fail-once'
let spawnMode: SpawnMode
let spawnCalls: SpawnRequest[]
/** Wall time of each spawn call, to compare retries against the backoff's end. */
let spawnAt: number[]
let spawnReleases: Array<(result: SpawnResult) => void> = []
let records: Map<string, ChatSessionRecord>
let catalog: GroupCatalog
let drivers: Map<string, ChatAgentDriver>
let pendingCards: Map<string, unknown[]>
let deliveries: Array<{ sessionId: string; messageId: string }>
let runtime: SessionMailbox
let home: string
let db: SessionDatabase
let transcript: string
/** waitingFor captured at every row-change notify (the snapshot a publish assembles). */
let changeSnapshots: Array<Record<string, WaitingReason>>
/** Teams re-published because their reasons structurally changed. */
let reasonPublishes: string[]
/** Errors reported through the dispatcher/staffing error path. */
let reportedErrors: unknown[]
/** The backoff clock while a test holds it; undefined reads the wall clock. */
let clockOverride: number | undefined
const clock = () => clockOverride ?? Date.now()
/** The failed-spawn backoff, in clock milliseconds. */
const BACKOFF_MS = 80

const writeGroup = (id: string, frontmatter: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `---\n${frontmatter}\n---\nWork.`)
}
const refreshCatalog = async () => { catalog = (await loadTeamGroups(repo, home)).catalog }
const record = (sessionId: string, extra: Partial<ChatSessionRecord>): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'working', createdAt: '', lastActivityAt: '', groupId: 'devs', ...extra,
})
const driverFor = (sessionId: string): ChatAgentDriver => {
  const existing = drivers.get(sessionId)
  if (existing) return existing
  const driver = {
    getPendingRequests: () => pendingCards.get(sessionId) ?? [],
    interrupt: async () => {},
    deliver: (envelope: ChatPeerMessage) => {
      deliveries.push({ sessionId, messageId: envelope.messageId })
      fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { content: formatEnvelope(envelope) } }) + '\n')
      records.get(sessionId)!.status = 'working'
    },
  } as unknown as ChatAgentDriver
  drivers.set(sessionId, driver)
  return driver
}

beforeEach(async () => {
  const dirCase = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(dirCase, 'home')
  transcript = path.join(dirCase, 'transcript.jsonl')
  fs.writeFileSync(transcript, '')
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('devs', 'max: 2\nworkers: { opus: 1, codex-sol: 1 }')
  writeGroup('reviewers', 'max: 2\nworkers: { opus: 1, codex-sol: 1 }\ncrossModelReview: true\nworktreeScoped: false')
  writeGroup('leads', 'label: Team leads')
  db = freshTestDatabase(path.join(dirCase, 'db.sqlite'))
  records = new Map([['lead', record('lead', { groupId: 'leads' })]])
  drivers = new Map()
  pendingCards = new Map()
  deliveries = []
  spawnMode = 'ok'
  spawnCalls = []
  spawnAt = []
  spawnReleases = []
  changeSnapshots = []
  reasonPublishes = []
  reportedErrors = []
  clockOverride = undefined
  await refreshCatalog()
  const teamsStub = {
    teamOf: (id: string) => (records.has(id) ? team : undefined),
    catalogOf: () => catalog,
    groupInfo: () => ({ missing: false }),
  } as unknown as SessionTeams
  runtime = new SessionMailbox(db.db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams: teamsStub,
    records: () => records.values(),
    getRecord: id => records.get(id),
    getDriver: id => (records.has(id) ? driverFor(id) : undefined),
    available: rec => rec.archivedAt == null,
    startBlocker: rec => rec.archivedAt != null ? 'This chat is archived and read-only' : null,
    prepare: async () => {},
    restore: () => {},
    watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    spawn: async (request): Promise<SpawnResult> => {
      spawnCalls.push(request)
      spawnAt.push(clock())
      if (spawnMode === 'hold') return new Promise(resolve => { spawnReleases.push(resolve) })
      if (spawnMode === 'fail-once') {
        spawnMode = 'ok'
        return { ok: false, error: 'profile glm is not defined' }
      }
      const sessionId = `spawned-${spawnCalls.length}`
      records.set(sessionId, record(sessionId, { projectPath: request.projectPath, spawned: true, status: 'waiting', taskId: request.taskId ?? null, ...(request.profileId ? { claudeProfileId: request.profileId } : {}) }))
      return { ok: true, sessionId }
    },
    spawnRetryAfterMs: BACKOFF_MS,
    transcriptFor: () => transcript,
    homeDir: home,
    now: clock,
    onChange: team => { changeSnapshots.push(runtime.waitingFor(team)) },
    onReasonsChange: team => { reasonPublishes.push(team) },
    onError: error => { reportedErrors.push(error) },
  })
  runtime.start()
})
afterEach(async () => {
  for (let i = 0; i < 5; i++) { await runtime.dispatcher.settled(); await Bun.sleep(5) }
  runtime.close(); db.close()
})

/** Notify and drain: chained passes (a notify that arrived mid-pass) complete too. */
const settle = async () => {
  runtime.dispatcher.notify()
  for (let i = 0; i < 5; i++) { await runtime.dispatcher.settled(); await Bun.sleep(5) }
}
const task = (worktree: string | null) => runtime.tasks.store.create({
  teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree,
})


const reviewer = (sessionId: string, profileId: string) =>
  record(sessionId, { groupId: 'reviewers', status: 'waiting', claudeProfileId: profileId })

async function handedReview() {
  records.set('dev', record('dev', { groupId: 'devs', status: 'waiting', claudeProfileId: 'opus' }))
  const t = await task(null)
  const result = await runtime.results.submit({ kind: 'agent', sessionId: 'dev' }, t.id, { summary: 'Export', commit: 'abc123' })
  const handed = await runtime.results.handoff({ kind: 'human', team }, t.id, {
    kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'Review it',
    expectedResponse: null, requestKey: 'review-1',
  })
  return handed.assignment.messageId!
}

// @covers: team-routing-rules › Cross-model review excludes the authors' model families › An Opus result goes to the Sol reviewer
test("V5: a review of an opus result skips the idle opus reviewer, waits naming claude, then goes to codex-sol", async () => {
  records.set('rev-opus', reviewer('rev-opus', 'opus'))
  await refreshCatalog()
  const messageId = await handedReview()
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === messageId)).toEqual([])
  const waiting = runtime.waitingFor(team.teamId)[messageId]!
  expect(waiting.blocker).toEqual({ kind: 'cross-model', detail: "authors' families: claude" })
  records.set('rev-sol', reviewer('rev-sol', 'codex-sol'))
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === messageId)).toEqual([{ sessionId: 'rev-sol', messageId }])
})

test('the same review to an unflagged group goes to the idle opus reviewer', async () => {
  writeGroup('reviewers', 'max: 2\nworkers: { opus: 1, codex-sol: 1 }\nworktreeScoped: false')
  records.set('rev-opus', reviewer('rev-opus', 'opus'))
  await refreshCatalog()
  const messageId = await handedReview()
  await settle()
  expect(deliveries.filter(delivery => delivery.messageId === messageId)).toEqual([{ sessionId: 'rev-opus', messageId }])
})

// Set up team over the workspace connection (starter-team-setup D3, V5): the
// preview and the write go through the real ChatConnections →
// WorkspaceConnections handlers; the write lands in the resolved team's main
// checkout (a worktree path resolves to the same groups root), replies with
// one envelope for refusals and success, and every open view of the team
// gets a push listing the new groups. The manager is the workspace tests'
// stub, with a catalog that re-reads the files.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { AssignmentStore } from '../team/assignmentStore'
import { loadGroupCatalog } from '../team/groupCatalog'
import { TeamApprovalDefaults } from '../team/teamApprovalDefaults'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ChatSessionRecord } from '../db'
import type { PlanAttentionFact, PlanSummaryRows } from '../team/planAttention'
import { freshTestDatabase } from './helpers/testDatabase'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let manager: ChatSessionManager
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let records: Array<ChatSessionRecord & { teamId: string }>
let pendingRequests: Map<string, unknown[]>
let turnEndRows: Array<{ sessionId: string; taskId: string; endedAt: string }>
// The plan-side facts the manager seam exposes (plan-supervision D13).
let planFacts: PlanAttentionFact[]
let planRows: PlanSummaryRows
let approvalDefaults: TeamApprovalDefaults

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-setup-connections-')))
  fs.mkdirSync(path.join(dir, 'home'))
  db = freshTestDatabase(path.join(dir, 'db.sqlite'))
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(taskStore, { getSession: () => undefined })
  // homeDir pins the user-level layer to the temp dir: the operator's real
  // ~/.kawai/groups must never reach a fixture's member list.
  approvalDefaults = new TeamApprovalDefaults(db.db)
  records = []
  pendingRequests = new Map()
  turnEndRows = []
  planFacts = []
  planRows = { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }
  messages = []
  connection = { send: message => messages.push(message) }
  // Known team paths (team-workspace-pages D1): this repository (two paths,
  // one team) and another team's.
  const teams = new Map<string, TeamIdentity>([
    ['/repo', { teamId: 'team', groupsRoot: dir }],
    ['/repo/.worktrees/feat-x', { teamId: 'team', groupsRoot: dir }],
    ['/other', { teamId: 'other', groupsRoot: dir }],
  ])
  manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    mailbox: { store: mail },
    tasks,
    waitingFor: () => ({}),
    teamRecords: (teamId: string) => records.filter(record => record.teamId === teamId),
    directory: { list: () => [] },
    getPendingRequests: (sessionId: string) => pendingRequests.get(sessionId) ?? [],
    groupProfileCounts: () => ({}),
    catalogProfileIds: () => new Set(['opus', 'codex-sol']),
    teamApprovalDefault: (teamId: string) => approvalDefaults.get(teamId),
    setTeamApprovalDefault: (teamId: string, policy: 'manual' | 'auto') => approvalDefaults.set(teamId, policy),
    turnEnds: {
      // Team scoping is the store's SQL join in production; the fake honors it.
      finishedForTeam: (teamId: string) => (teamId === 'team' ? turnEndRows.filter(row => row.sessionId === 'our-dev') : []),
      since: () => turnEndRows,
    },
    recordOf: (sessionId: string) => records.find(record => record.sessionId === sessionId),
    exhaustionEpisodes: () => [],
    planAttentionFacts: (teamId: string) => (teamId === 'team' ? planFacts : []),
    planSummaryRows: (teamId: string) => (teamId === 'team' ? planRows : { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }),
    validationDetail: { invalidate: () => {} },
    outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
    teams: {
      // Re-read on every call, as the stamp-keyed production catalog does after a write.
      catalogForTeam: () => loadGroupCatalog({ groupsRoot: dir, homeDir: path.join(dir, 'home') }),
      teamOf: (sessionId: string) => {
        const record = records.find(candidate => candidate.sessionId === sessionId)
        return record ? { teamId: record.teamId } : undefined
      },
    },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  taskStore.subscribe(task => connections.publishTasks(task.teamId))
  mail.subscribe(team => connections.publishMailbox(team))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })


const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)

describe('Set up team over the workspace connection', () => {
  test('the preview lists the starter groups and the target directory, writing nothing', async () => {
    await send({ type: 'team-workspace-setup-preview', teamPath: '/repo' })
    const reply = all('team-workspace-setup-preview-result').at(-1)!
    expect(reply).toMatchObject({ teamPath: '/repo', ok: true, preview: { available: true, targetDir: path.join(dir, '.kawai', 'groups'), warnings: [] } })
    if (reply.ok) expect(reply.preview.groups.map(group => group.id)).toEqual(['lead', 'devs', 'reviewers'])
    expect(fs.existsSync(path.join(dir, '.kawai'))).toBe(false)
  })

  // @covers: team-setup › Confirming writes the starter group files › Setup from a linked worktree writes to the main checkout
  // @covers: team-setup › Confirming writes the starter group files › Other views follow
  test('a run from a worktree path writes into the main checkout and every open view follows', async () => {
    const watched: ServerMessage[] = []
    const other = { send: (message: ServerMessage) => watched.push(message) }
    await connections.handle(other, { type: 'team-workspace-open', teamPath: '/repo' })
    expect((watched.find(message => message.type === 'team-workspace-snapshot') as Extract<ServerMessage, { type: 'team-workspace-snapshot' }>).members).toEqual([])
    await send({ type: 'team-workspace-setup-run', teamPath: '/repo/.worktrees/feat-x' })
    await connections.flushWorkspace()
    expect(all('team-workspace-setup-result').at(-1)).toEqual({
      type: 'team-workspace-setup-result', teamPath: '/repo/.worktrees/feat-x', ok: true, created: ['lead.md', 'devs.md', 'reviewers.md'], skipped: [],
    })
    expect(fs.readdirSync(path.join(dir, '.kawai', 'groups')).sort()).toEqual(['devs.md', 'lead.md', 'reviewers.md'])
    const push = watched.filter((message): message is Extract<ServerMessage, { type: 'team-workspace' }> => message.type === 'team-workspace').at(-1)!
    expect(push.members.map(member => member.id).sort()).toEqual(['devs', 'lead', 'reviewers'])
  })

  // @covers: team-setup › Set-up groups are editable files the Members tab names › An edit is picked up like any group edit
  test('an edit to a written file is picked up like any group edit, and the offer stays withdrawn', async () => {
    await send({ type: 'team-workspace-setup-run', teamPath: '/repo' })
    await connections.flushWorkspace()
    const file = path.join(dir, '.kawai', 'groups', 'devs.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^workers: .*$/m, 'workers: { opus: 2, codex-sol: 1 }'))
    const watched: ServerMessage[] = []
    await connections.handle({ send: (message: ServerMessage) => watched.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    const snapshot = watched.find(message => message.type === 'team-workspace-snapshot') as Extract<ServerMessage, { type: 'team-workspace-snapshot' }>
    expect(snapshot.setupAvailable).toBe(false)
    const devs = snapshot.members.find(member => member.id === 'devs')!
    expect(devs.profiles.map(profile => [profile.profileId, profile.cap])).toEqual([['opus', 2], ['codex-sol', 1]])
    expect(devs.sources.map(source => source.file)).toEqual([file])
  })

  test('a second run is refused with the same envelope and pushes nothing', async () => {
    await send({ type: 'team-workspace-setup-run', teamPath: '/repo' })
    await connections.flushWorkspace()
    await send({ type: 'team-workspace-setup-run', teamPath: '/repo' })
    expect(all('team-workspace-setup-result').at(-1)).toMatchObject({
      teamPath: '/repo', ok: false, reason: 'already-set-up', created: [], skipped: [],
    })
  })

  test('S8: an unknown team is refused with the same envelope', async () => {
    await send({ type: 'team-workspace-setup-run', teamPath: '/nope' })
    expect(all('team-workspace-setup-result').at(-1)).toMatchObject({ teamPath: '/nope', ok: false, reason: 'unknown-team', created: [], skipped: [] })
    await send({ type: 'team-workspace-setup-preview', teamPath: '/nope' })
    expect(all('team-workspace-setup-preview-result').at(-1)).toMatchObject({ teamPath: '/nope', ok: false })
  })
})

// I4 / S9: only the human's Team page reaches the write. The server modules
// that import the setup are exactly the workspace connection (preview and
// run), the groups route and the workspace read model (the offer flag only); no agent tool module
// imports it, so no team tool can write group files.
describe('Set up team is not agent-reachable', () => {
  const serverRoot = path.join(import.meta.dir, '..')
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
  const importsSetup = (file: string) => /from '(\.\.?\/)+(team\/)?teamSetup'/.test(fs.readFileSync(file, 'utf8'))

  // @covers: team-setup › The setup action is offered to a team without project groups › Agents cannot run the setup
  test('only the workspace connection, the groups route, and the workspace read import the setup, and only the connection runs it', () => {
    const importers = sources(serverRoot).filter(importsSetup).map(file => path.relative(serverRoot, file)).sort()
    expect(importers).toEqual(['routes/teamGroups.ts', 'team/workspaceConnections.ts', 'team/workspaceRead.ts'])
    for (const reader of ['routes/teamGroups.ts', 'team/workspaceRead.ts']) {
      expect(fs.readFileSync(path.join(serverRoot, reader), 'utf8')).not.toContain('runTeamSetup')
    }
    const toolModules = sources(serverRoot).filter(file => file.endsWith('Tools.ts'))
    expect(toolModules.length).toBeGreaterThan(5)
    for (const file of toolModules) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/teamSetup|setup-run/)
  })
})

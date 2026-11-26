// Set up team over the workspace connection (starter-team-setup D3, V5): the
// preview and the write go through the real ChatConnections →
// WorkspaceConnections handlers; the write lands in the resolved team's main
// checkout (a worktree path resolves to the same groups root), replies with
// one envelope for refusals and success, and every open view of the team
// gets a push listing the new groups. The manager is the workspace tests'
// stub, with a catalog that re-reads the files.
//
// The preview's replacement warnings (starter-setup-with-user-level-groups)
// are held here as well: Table W and the seeded P1/P2 over the preview
// function, then W1 and W2 composed through the workspace dispatch and a
// real ChatSessionManager, whose catalog home differs from the ambient HOME.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { setupAvailable, setupPreview, starterGroups } from '../team/teamSetup'
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
    groupCatalogHome: () => path.join(dir, 'home'),
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
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  for (const root of previewRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})


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

  // Review F2 (findings ff0fa041): one looping groups entry — creatable by
  // any repo-writing agent — must not break the team snapshot; the offer
  // just reads as withdrawn.
  test('a looping groups entry leaves the snapshot readable with the offer withdrawn', async () => {
    fs.mkdirSync(path.join(dir, '.kawai'), { recursive: true })
    fs.symlinkSync('groups', path.join(dir, '.kawai', 'groups'))
    const watched: ServerMessage[] = []
    await connections.handle({ send: message => watched.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    const snapshot = watched.find(message => message.type === 'team-workspace-snapshot') as Extract<ServerMessage, { type: 'team-workspace-snapshot' }>
    expect(snapshot.setupAvailable).toBe(false)
    expect(snapshot.members).toEqual([])
  })

  test('S8: an unknown team is refused with the same envelope', async () => {
    await send({ type: 'team-workspace-setup-run', teamPath: '/nope' })
    expect(all('team-workspace-setup-result').at(-1)).toMatchObject({ teamPath: '/nope', ok: false, reason: 'unknown-team', created: [], skipped: [] })
    await send({ type: 'team-workspace-setup-preview', teamPath: '/nope' })
    expect(all('team-workspace-setup-preview-result').at(-1)).toMatchObject({ teamPath: '/nope', ok: false })
  })
})

// The preview's replacement warnings. Each case gets its own root holding a
// `home` and a `project`; a layer gets no groups directory until a case
// names a file for it.
const VALID_GROUP = '---\nlabel: Named\n---\nPlan the work.'
const MALFORMED_GROUP = '---\nlabel: x\n'
/** Every starter worker defined: a preview's warnings are then replacements only. */
const FULL_CATALOG = new Set(['opus', 'codex-sol'])
const previewRoots: string[] = []

interface PreviewRoot { root: string; home: string; project: string }

/** A `home` and a `project`; each layer's group files by name (`null` makes a directory). */
function previewRoot(user: Record<string, string | null> = {}, project: Record<string, string | null> = {}): PreviewRoot {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-setup-preview-')))
  previewRoots.push(root)
  const fixture = { root, home: path.join(root, 'home'), project: path.join(root, 'project') }
  for (const [base, files] of [[fixture.home, user], [fixture.project, project]] as const) {
    fs.mkdirSync(base)
    if (Object.keys(files).length === 0) continue
    const groups = path.join(base, '.kawai', 'groups')
    fs.mkdirSync(groups, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      if (content === null) fs.mkdirSync(path.join(groups, name))
      else fs.writeFileSync(path.join(groups, name), content)
    }
  }
  return fixture
}

/** One expected warning: the starter file `name` replaces the user-level file of that name under `home`. */
const warningFor = (home: string, name: string) => `${name} replaces ${path.join(home, '.kawai', 'groups', name)} for this project.`
/** The expected warnings for starter `ids`, in the given order. */
const replacementWarnings = (home: string, ...ids: string[]) => ids.map(id => warningFor(home, `${id}.md`))

/** A seeded shuffle (Fisher–Yates over a local congruential stream): a fixed, mixed case order. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const order = [...items]
  for (let i = order.length - 1; i > 0; i--) {
    const pick = Math.floor(next() * (i + 1))
    const held = order[i]!
    order[i] = order[pick]!
    order[pick] = held
  }
  return order
}

/** Every entry under `root` — each directory, and each file's bytes — as a read must leave it. */
function stateOf(root: string): Record<string, string> {
  const state: Record<string, string> = {}
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name)
      if (fs.statSync(full).isDirectory()) {
        state[path.relative(root, full)] = 'directory'
        walk(full)
      } else {
        state[path.relative(root, full)] = fs.readFileSync(full).toString('hex')
      }
    }
  }
  walk(root)
  return state
}

describe('Table W — the preview names the user-level groups it would replace', () => {
  // @covers: team-setup › The setup preview names the user-level groups it would replace › A starter group that replaces a user-level group is warned
  test('W1: a same-named valid user-level file is named once, with the project file that replaces it', () => {
    const { project, home } = previewRoot({ 'lead.md': VALID_GROUP })
    const preview = setupPreview(project, FULL_CATALOG, home)
    expect(preview.warnings).toEqual(replacementWarnings(home, 'lead'))
    // The replacement: the starter group of that id, written to the named target.
    expect(preview.targetDir).toBe(path.join(project, '.kawai', 'groups'))
    expect(preview.groups.map(group => group.id)).toEqual(['lead', 'devs', 'reviewers'])
  })

  test('W2: a same-named malformed user-level file is named once, with the same wording', () => {
    const { project, home } = previewRoot({ 'lead.md': MALFORMED_GROUP })
    expect(setupPreview(project, FULL_CATALOG, home).warnings).toEqual(replacementWarnings(home, 'lead'))
  })

  // @covers: team-setup › The setup preview names the user-level groups it would replace › No warning without a same-named user-level file
  test('W3: no user-level file at a starter id is named: no groups directory, an empty one, or only other ids', () => {
    const absent = previewRoot()
    expect(setupPreview(absent.project, FULL_CATALOG, absent.home).warnings).toEqual([])
    fs.mkdirSync(path.join(absent.home, '.kawai', 'groups'), { recursive: true })
    expect(setupPreview(absent.project, FULL_CATALOG, absent.home).warnings).toEqual([])
    const others = previewRoot({ 'reviewers-sol.md': VALID_GROUP, 'spec-verifiers.md': MALFORMED_GROUP })
    expect(setupPreview(others.project, FULL_CATALOG, others.home).warnings).toEqual([])
  })

  test('W4: a directory at the matching path is named by no warning', () => {
    const { project, home } = previewRoot({ 'lead.md': null, 'devs.md': null, 'reviewers.md': null })
    expect(setupPreview(project, FULL_CATALOG, home).warnings).toEqual([])
  })

  test('every matching starter is named once, in starter order, after the missing-worker warnings', () => {
    const { project, home } = previewRoot({ 'reviewers.md': VALID_GROUP, 'lead.md': MALFORMED_GROUP, 'devs.md': VALID_GROUP })
    expect(setupPreview(project, new Set(['opus']), home).warnings).toEqual([
      "Profile codex-sol is not defined in this team's catalog; its slots will not staff until it is.",
      ...replacementWarnings(home, 'lead', 'devs', 'reviewers'),
    ])
  })

  test('an unreadable user-level file is named by no warning, and the preview still answers', () => {
    const { project, home } = previewRoot({ 'lead.md': VALID_GROUP })
    if (process.getuid?.() === 0) return // root reads through any mode
    fs.chmodSync(path.join(home, '.kawai', 'groups'), 0o000)
    try {
      expect(setupPreview(project, FULL_CATALOG, home)).toMatchObject({ available: true, warnings: [] })
    } finally {
      fs.chmodSync(path.join(home, '.kawai', 'groups'), 0o755)
    }
  })

  test('without an injected home the ambient HOME is read; a home that cannot resolve names nothing', () => {
    const { project, home } = previewRoot({ 'lead.md': VALID_GROUP })
    const savedHome = process.env.HOME
    try {
      process.env.HOME = home
      expect(setupPreview(project, FULL_CATALOG).warnings).toEqual(replacementWarnings(home, 'lead'))
      delete process.env.HOME
      const homedir = spyOn(os, 'homedir').mockImplementation(() => { throw new Error('ENOENT: no such file or directory, uv_os_homedir') })
      try {
        expect(setupPreview(project, FULL_CATALOG)).toMatchObject({ available: true, warnings: [] })
      } finally {
        homedir.mockRestore()
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })
})

describe('P1 — observing the preview keeps the project-derived answer and every file', () => {
  test('P1: project groups present or absent × a valid, malformed, unrelated or absent user-level file (seed 0x57A27, 8 cases)', () => {
    const USER: Array<[string, Record<string, string | null>, string[]]> = [
      ['valid', { 'lead.md': VALID_GROUP }, ['lead']],
      ['malformed', { 'lead.md': MALFORMED_GROUP }, ['lead']],
      ['unrelated', { 'spec-verifiers.md': VALID_GROUP }, []],
      ['absent', {}, []],
    ]
    const cases = USER.flatMap(([name, user, ids]) => [false, true].map(present =>
      ({ label: `a ${name} user-level file, project groups ${present ? 'present' : 'absent'}`, user, ids, present })))
    expect(cases).toHaveLength(8)
    for (const { label, user, ids, present } of shuffled(cases, 0x57A27)) {
      const { root, project, home } = previewRoot(user, present ? { 'devs.md': '---\nlabel: Devs\n---\nBuild.' } : {})
      const before = stateOf(root)
      const preview = setupPreview(project, FULL_CATALOG, home)
      expect(stateOf(root), label).toEqual(before)
      // The offer, the target and the starter manifest stay the project's and the templates'.
      expect(preview, label).toEqual({
        available: !present, targetDir: path.join(project, '.kawai', 'groups'), groups: starterGroups(),
        warnings: replacementWarnings(home, ...ids),
      })
      expect(setupAvailable(project), label).toBe(!present)
    }
  })
})

describe('P2 — each matching user-level file is named exactly once, in starter order', () => {
  test('P2: every subset of the starter names × valid or malformed contents, beside an unrelated name (seed 0x57A28, 16 cases)', () => {
    // Each subset of starter ids with the user-level files it must warn about, in starter order.
    const SUBSETS: Array<[string[], string[]]> = [
      [[], []],
      [['lead'], ['lead.md']], [['devs'], ['devs.md']], [['reviewers'], ['reviewers.md']],
      [['lead', 'devs'], ['lead.md', 'devs.md']], [['lead', 'reviewers'], ['lead.md', 'reviewers.md']],
      [['devs', 'reviewers'], ['devs.md', 'reviewers.md']],
      [['lead', 'devs', 'reviewers'], ['lead.md', 'devs.md', 'reviewers.md']],
    ]
    const cases = SUBSETS.flatMap(([ids, warned]) => [['valid', VALID_GROUP], ['malformed', MALFORMED_GROUP]]
      .map(([kind, content]) => ({ label: `${kind} ${warned.join(' ') || 'no starter file'}`, ids, warned, content })))
    expect(cases).toHaveLength(16)
    for (const { label, ids, warned, content } of shuffled(cases, 0x57A28)) {
      const { root, project, home } = previewRoot(
        { ...Object.fromEntries(ids.map(id => [`${id}.md`, content])), 'spec-verifiers.md': VALID_GROUP },
        { 'notes.txt': 'not a group' })
      const before = stateOf(root)
      const preview = setupPreview(project, FULL_CATALOG, home)
      expect(stateOf(root), label).toEqual(before)
      expect(preview.warnings, label).toEqual(warned.map(name => warningFor(home, name)))
      // The names the warnings cite: each matching one exactly once, in starter order.
      expect(preview.warnings.map(warning => warning.slice(0, warning.indexOf(' '))), label).toEqual(warned)
    }
  })
})

// W1 and W2 composed. The real ChatSessionManager is built with its catalog
// home (the injected `profileCatalogHome`) while the ambient HOME is a
// different, empty fixture home: a warning that appears here followed the
// manager's home through the workspace dispatch, not the environment.
describe('the preview through a real manager home', () => {
  let real: ChatSessionManager
  let realDb: SessionDatabase
  let dispatch: ChatConnections
  let project: string
  let home: string
  let ambient: string
  const savedHome = process.env.HOME

  const userFile = (base: string, name: string, content: string) => {
    fs.mkdirSync(path.join(base, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(base, '.kawai', 'groups', name), content)
  }
  // The fixture directory is the one repository the team views may address.
  const startManager = (catalogHome: string) => {
    real = new ChatSessionManager({
      db: realDb, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: catalogHome,
      availabilityProbe: async () => {}, workspaceRepositories: () => [project],
    })
    dispatch = new ChatConnections(real)
  }
  const previewOf = async () => {
    messages = []
    await dispatch.handle(connection, { type: 'team-workspace-setup-preview', teamPath: project })
    const reply = all('team-workspace-setup-preview-result').at(-1)
    expect(reply).toMatchObject({ type: 'team-workspace-setup-preview-result', teamPath: project, ok: true })
    return reply?.ok ? reply.preview : undefined
  }

  beforeEach(() => {
    home = path.join(dir, 'catalog-home')
    ambient = path.join(dir, 'ambient-home')
    project = path.join(dir, 'project')
    for (const base of [home, ambient, project]) fs.mkdirSync(base)
    process.env.HOME = ambient
    realDb = freshTestDatabase(path.join(dir, 'real.sqlite'))
    startManager(home)
  })
  afterEach(() => {
    real.shutdown()
    realDb.close()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  })

  // @covers: team-setup › The setup preview names the user-level groups it would replace › A starter group that replaces a user-level group is warned
  test('W1 composed: a user-level lead.md under the manager home is named, beside the offer, target and groups as before', async () => {
    userFile(home, 'lead.md', VALID_GROUP)
    expect(await previewOf()).toEqual({
      available: true, targetDir: path.join(project, '.kawai', 'groups'), groups: starterGroups(),
      warnings: replacementWarnings(home, 'lead'),
    })
  })

  test('W2 composed: a malformed lead.md under the manager home is named through the workspace dispatch', async () => {
    userFile(home, 'lead.md', MALFORMED_GROUP)
    expect((await previewOf())?.warnings).toEqual(replacementWarnings(home, 'lead'))
  })

  test('the ambient HOME is not read while the manager has a home of its own', async () => {
    userFile(home, 'lead.md', VALID_GROUP)
    userFile(ambient, 'devs.md', VALID_GROUP)
    expect((await previewOf())?.warnings).toEqual(replacementWarnings(home, 'lead'))
  })

  test('an empty manager home is no override: the ambient HOME is named', async () => {
    real.shutdown()
    startManager('')
    userFile(ambient, 'lead.md', VALID_GROUP)
    expect((await previewOf())?.warnings).toEqual(replacementWarnings(ambient, 'lead'))
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

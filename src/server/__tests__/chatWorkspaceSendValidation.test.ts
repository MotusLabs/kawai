// The workspace-context send validation (plan-workspace §4.1): CP1's table
// V2–V8 as test.each rows over faked structural deps, plus V1 — the
// manager's today refusals that precede any mint. Every refusal stores no
// row and opens no turn (invariant I1); every ok returns the immutable
// snapshot the send records, with the validation-only hash fields left off.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PlanDraft, PlanRevision } from '../../shared/plans'
import type { WorkspaceMessageEnvelope, WorkspaceRefView } from '../../shared/planWorkspace'
import type { TeamIdentity } from '../team/teamIdentity'
import { validateWorkspaceSend, type WorkspaceSendValidationDeps } from '../chat/workspaceSendValidation'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

const TEAM = '/repo/example/main'
const HASH2 = 'a'.repeat(64)

const contentOf = (changes: string[]) => ({
  goal: 'Ship plan-workspace',
  successCriteria: ['contexts ride messages'],
  nonGoals: [],
  approach: '',
  alignment: { statement: '', refs: [] },
  changes: changes.map(change => ({
    change, dependsOn: [], group: null, reviewGroup: null, acceptance: [], extraChecks: [], guidance: '',
  })),
  acceptanceRules: [],
  extraChecks: [],
  landing: { mode: 'direct' as const },
  roles: [],
  reviewGroup: null,
})

const revisionOf = (revision: number, contentHash: string, changes: string[]): PlanRevision => ({
  revision, status: 'approved', content: contentOf(changes), contentHash,
  pin: null, author: { kind: 'human', sessionId: null }, createdAt: '2026-10-23T00:00:00Z',
})

const draftOf = (draftId: string, contentHash: string): PlanDraft => ({
  draftId, baseRevision: null, author: { kind: 'human', sessionId: null },
  content: contentOf(['plan-workspace']), contentHash, updatedAt: '2026-10-23T00:00:00Z',
})

/** The validation reads, faked whole — the deps are structural by design. */
interface DepsState {
  teamId: string
  plan: { id: string; title: string } | null
  revisions: PlanRevision[]
  drafts: PlanDraft[]
  execution: { id: string; teamId: string; planId: string; revision: number } | null
  refs: WorkspaceRefView[]
}

const baseState = (): DepsState => ({
  teamId: TEAM,
  plan: { id: 'plan-1', title: 'Workspace roadmap' },
  revisions: [revisionOf(2, HASH2, ['plan-workspace'])],
  drafts: [],
  execution: null,
  refs: [],
})

const depsFor = (state: DepsState): WorkspaceSendValidationDeps => ({
  resolveTeam: async () => ({ teamId: state.teamId, groupsRoot: '/repo/example/groups' } as TeamIdentity),
  planForTeam: (teamId, planId) => (teamId === state.teamId && state.plan?.id === planId ? state.plan : null),
  versionInputs: () => ({
    approved: state.revisions.find(revision => revision.status === 'approved') ?? null,
    revisions: state.revisions,
    drafts: state.drafts,
  }),
  execution: () => state.execution,
  refsOf: () => state.refs,
})

const envelopeOf = (over: Partial<WorkspaceMessageEnvelope> = {}): WorkspaceMessageEnvelope => ({
  teamId: TEAM,
  planId: 'plan-1',
  version: { kind: 'revision', revision: 2, contentHash: HASH2 },
  ...over,
})

describe('validateWorkspaceSend', () => {
  const refusals: Array<{
    name: string
    envelope?: Partial<WorkspaceMessageEnvelope>
    state?: Partial<DepsState>
    error: string
  }> = [
    {
      name: 'V2 an envelope naming another repository is refused',
      envelope: { teamId: '/repo/example/other' },
      error: "Message is attached to another repository's plan; not sent.",
    },
    {
      name: 'V3 an unknown plan is refused',
      state: { plan: null },
      error: 'Plan not found in this repository: plan-1',
    },
    {
      name: 'V4 a revision the plan no longer has is refused',
      envelope: { version: { kind: 'revision', revision: 9, contentHash: HASH2 } },
      error: 'Plan revision 9 not found: Workspace roadmap',
    },
    {
      name: 'V4 a revision whose hash moved is refused',
      envelope: { version: { kind: 'revision', revision: 2, contentHash: 'b'.repeat(64) } },
      error: 'Plan "Workspace roadmap" revision 2 changed since this message was attached.',
    },
    {
      name: 'V5 an unknown draft is refused',
      envelope: { version: { kind: 'draft', draftId: 'draft-gone', contentHash: HASH2 } },
      error: 'Plan draft draft-gone not found: Workspace roadmap',
    },
    {
      name: 'V5 a draft whose hash moved is refused',
      envelope: { version: { kind: 'draft', draftId: 'draft-1', contentHash: 'b'.repeat(64) } },
      state: { drafts: [draftOf('draft-1', HASH2)] },
      error: 'Plan draft "draft-1" of "Workspace roadmap" changed since this message was attached.',
    },
    {
      name: 'V6 an unknown execution is refused',
      envelope: { executionId: 'exec-1' },
      error: 'Execution not found in this plan: exec-1',
    },
    {
      name: 'V6 an execution of another team reads as not found',
      envelope: { executionId: 'exec-1' },
      state: { execution: { id: 'exec-1', teamId: '/repo/example/other', planId: 'plan-1', revision: 5 } },
      error: 'Execution not found in this plan: exec-1',
    },
    {
      name: 'V6 an execution of another plan reads as not found',
      envelope: { executionId: 'exec-1' },
      state: { execution: { id: 'exec-1', teamId: TEAM, planId: 'plan-2', revision: 5 } },
      error: 'Execution not found in this plan: exec-1',
    },
    {
      name: 'V6 an execution that moved to another revision is refused',
      envelope: { executionId: 'exec-1', executionRevision: 2 },
      state: { execution: { id: 'exec-1', teamId: TEAM, planId: 'plan-1', revision: 5 } },
      error: 'Execution exec-1 moved to revision 5 since this message was attached.',
    },
    {
      name: 'V7 a change outside the named version is refused',
      envelope: { changeName: 'other-change' },
      error: 'Change "other-change" is not part of this plan version.',
    },
  ]

  test.each(refusals)('$name', async ({ envelope: over, state: over2, error }) => {
    const outcome = await validateWorkspaceSend('/repo/example/session', envelopeOf(over), depsFor({ ...baseState(), ...over2 }))
    expect(outcome).toEqual({ ok: false, error })
  })

  test('V6 an envelope without executionRevision accepts the row and stores executionId only', async () => {
    const state = baseState()
    state.execution = { id: 'exec-1', teamId: TEAM, planId: 'plan-1', revision: 5 }
    const outcome = await validateWorkspaceSend(
      '/repo/example/session',
      envelopeOf({ executionId: 'exec-1', changeName: 'plan-workspace' }),
      depsFor(state),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The stored snapshot (V6 accepted reading): executionId is the
    // revision snapshot — plan_executions.revision is INSERT-only — and the
    // validation-only fields stay off it.
    expect(outcome.context.executionId).toBe('exec-1')
    expect(outcome.context.changeName).toBe('plan-workspace')
    expect('executionRevision' in outcome.context).toBe(false)
    expect('documentHash' in outcome.context).toBe(false)
    expect(outcome.context.planTitle).toBe('Workspace roadmap')
  })

  test('V6 an envelope naming a matching revision is accepted', async () => {
    const state = baseState()
    state.execution = { id: 'exec-1', teamId: TEAM, planId: 'plan-1', revision: 2 }
    const outcome = await validateWorkspaceSend(
      '/repo/example/session',
      envelopeOf({ executionId: 'exec-1', executionRevision: 2 }),
      depsFor(state),
    )
    expect(outcome).toEqual({
      ok: true,
      context: {
        teamId: TEAM, planId: 'plan-1', planTitle: 'Workspace roadmap',
        version: { kind: 'revision', revision: 2, contentHash: HASH2 },
        executionId: 'exec-1', changeName: null, documentRefId: null,
      },
    })
  })

  // V8 reads the real document: a local ref needs the hash the sender read,
  // fail-closed, by a fresh read at validation time.
  describe('V8 the document ref', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-send-v8-'))
    const root = path.join(base, 'wt')
    const docDir = path.join(root, 'docs')
    const docPath = path.join(docDir, 'note.md')
    fs.mkdirSync(docDir, { recursive: true })
    fs.writeFileSync(docPath, '# Note\n')
    const docHash = () => createHash('sha256').update(fs.readFileSync(docPath)).digest('hex')
    afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

    const localRef = (): WorkspaceRefView => ({
      id: 'ref-1', planId: 'plan-1', changeName: null, label: 'Note', kind: 'local',
      worktreeId: root, relativePath: 'docs/note.md', url: null, createdAt: '2026-10-23T00:00:00Z',
    })
    const externalRef = (): WorkspaceRefView => ({
      id: 'ref-2', planId: 'plan-1', changeName: null, label: 'Spec', kind: 'external',
      worktreeId: null, relativePath: null, url: 'https://example.internal/spec', createdAt: '2026-10-23T00:00:00Z',
    })
    const send = async (state: DepsState, envelope: WorkspaceMessageEnvelope) =>
      validateWorkspaceSend('/repo/example/session', envelope, depsFor(state))

    test('V8 a local ref whose fresh read matches the sender hash is accepted', async () => {
      const state = baseState()
      state.refs = [localRef()]
      const outcome = await send(state, envelopeOf({ documentRefId: 'ref-1', documentHash: docHash() }))
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.context.documentRefId).toBe('ref-1')
    })

    test('V8 a local ref whose file changed since the send is refused', async () => {
      fs.writeFileSync(docPath, '# Note, changed\n')
      const state = baseState()
      state.refs = [localRef()]
      const outcome = await send(state, envelopeOf({ documentRefId: 'ref-1', documentHash: createHash('sha256').update('# Note\n').digest('hex') }))
      expect(outcome).toEqual({ ok: false, error: 'The referenced document changed since this message was attached.' })
    })

    test('V8 a local ref whose file is gone is refused', async () => {
      const hashBefore = docHash()
      fs.rmSync(docPath)
      try {
        const state = baseState()
        state.refs = [localRef()]
        const outcome = await send(state, envelopeOf({ documentRefId: 'ref-1', documentHash: hashBefore }))
        expect(outcome).toEqual({ ok: false, error: 'The referenced document is gone; no current hash could be read.' })
      } finally {
        fs.writeFileSync(docPath, '# Note\n')
      }
    })

    test('V8 a local ref without the sender hash is refused fail-closed', async () => {
      const state = baseState()
      state.refs = [localRef()]
      const outcome = await send(state, envelopeOf({ documentRefId: 'ref-1' }))
      expect(outcome).toEqual({ ok: false, error: 'A local document ref needs the hash the sender read.' })
    })

    test('V8 an external ref carrying a hash is refused', async () => {
      const state = baseState()
      state.refs = [externalRef()]
      const outcome = await send(state, envelopeOf({ documentRefId: 'ref-2', documentHash: docHash() }))
      expect(outcome).toEqual({ ok: false, error: 'An external document ref carries no hash.' })
    })

    test('V8 an unknown ref is refused', async () => {
      const outcome = await send(baseState(), envelopeOf({ documentRefId: 'ref-x', documentHash: docHash() }))
      expect(outcome).toEqual({ ok: false, error: 'Document ref not found in this plan: ref-x' })
    })

    test('V8 a ref of another change is refused', async () => {
      const state = baseState()
      // Both changes in the version, so V7 passes and V8's ref check runs.
      state.revisions = [revisionOf(2, HASH2, ['plan-workspace', 'other-change'])]
      state.refs = [{ ...localRef(), changeName: 'plan-workspace' }]
      const outcome = await send(state, envelopeOf({ changeName: 'other-change', documentRefId: 'ref-1', documentHash: docHash() }))
      expect(outcome).toEqual({ ok: false, error: 'Document ref "Note" belongs to change "plan-workspace", not this message\'s change.' })
    })
  })
})

// V1 stays manager-owned: the same refusals an unscoped send gets today,
// before any mint or validation read.
describe('V1 the manager refuses before the mint', () => {
  let tempDir: string
  let project: string
  let home: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-pwd-v1-')))
    project = path.join(tempDir, 'project')
    home = path.join(tempDir, 'home')
    fs.mkdirSync(project, { recursive: true })
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  })

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const manager = () => new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: home,
    availabilityProbe: async () => {},
  })

  test('V1 an unknown session keeps today refusal', async () => {
    const outcome = await manager().send('no-such-session', 'Hello there', envelopeOf())
    expect(outcome).toEqual({ ok: false, error: 'Unknown chat session no-such-session' })
  })

  test('V1 an archived session keeps today refusal', async () => {
    const sessions = manager()
    const created = await sessions.createAvailableSession({ projectPath: project })
    if (!created.ok) throw new Error('session creation failed')
    await sessions.archive(created.session.id)
    const outcome = await sessions.send(created.session.id, 'Hello there', envelopeOf())
    expect(outcome).toEqual({
      ok: false,
      error: 'This chat session is archived. Restore it to continue the conversation.',
    })
  })
})

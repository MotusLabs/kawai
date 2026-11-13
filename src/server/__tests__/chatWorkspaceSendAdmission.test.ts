// The caller admission invariant (task 6.1, plan-workspace §4 I1) through the
// real manager and the default package composition: a contextual send
// settles with its admission. A refused record (conflict, invalid) or a
// throwing store settles the send with Kawai's text and leaves nothing: no
// event, no turn, no prompt, no row and no owned failure. An accepted send
// settles only after the record, under the one UUID the record, the live
// user event and the CLI prompt share, and the record precedes the turn.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { resolveTeam } from '../team/teamIdentity'
import type { ChatEvent } from '../../shared/chat'
import type { WorkspaceMessageEnvelope } from '../../shared/planWorkspace'
import type { PlanWorkspaceContext, WorkspaceContextOutcome } from '../plans/workspace/workspaceContext'

type Record = PlanWorkspaceContext['record']

describe('caller admission of a contextual send (task 6.1)', () => {
  let tempDir: string
  let project: string
  let db: SessionDatabase
  let manager: ChatSessionManager | null = null
  const events: Array<{ sessionId: string; event: ChatEvent }> = []
  const prompts: SDKUserMessage[] = []
  /** The record, the turn's opening and the send's settlement, in arrival order. */
  const trace: string[] = []

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-admission-')))
    project = path.join(tempDir, 'project')
    fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    events.length = 0
    prompts.length = 0
    trace.length = 0
  })
  afterEach(async () => {
    // Release and join the retired drivers before the database closes.
    if (manager) {
      manager.shutdown()
      await manager.retiredSettled()
      manager = null
    }
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** The fixture CLI, with every prompt it reads captured. */
  const capturing: ChatQueryFactory = (params) => fixtureQueryFactory({
    ...params,
    prompt: (async function* () {
      for await (const message of params.prompt) {
        prompts.push(message)
        yield message
      }
    })(),
  })

  async function setup(record?: (real: Record) => Record) {
    manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), profileCatalogHome: tempDir, authCheck: () => true,
      onEvent: (sessionId, event) => {
        events.push({ sessionId, event })
        if (event.type === 'turn_started') trace.push('turn_started')
      },
      queryFactory: capturing,
    })
    const store = manager.planWorkspaceContext
    if (record) store.record = record(store.record.bind(store))
    const team = await resolveTeam(project)
    const planCreated = await manager.plans.create({ kind: 'human', team }, { title: 'Roadmap' })
    const created = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    if (!created.ok) throw new Error(created.error)
    const envelope: WorkspaceMessageEnvelope = {
      teamId: team.teamId,
      planId: planCreated.plan.id,
      version: { kind: 'draft', draftId: planCreated.draft.draftId, contentHash: planCreated.draft.contentHash },
    }
    return { manager, sessionId: created.session.id, envelope }
  }

  const rows = (sessionId: string) =>
    (db.db.prepare('SELECT COUNT(*) AS n FROM chat_workspace_turn_context WHERE session_id = ?').get(sessionId) as { n: number }).n
  const driverOf = (m: ChatSessionManager, sessionId: string) =>
    (m as unknown as { drivers: Map<string, { settled(): Promise<void> }> }).drivers.get(sessionId)!
  const shown = (sessionId: string) => events.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.event)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  const refusals: Array<[string, Extract<WorkspaceContextOutcome, { ok: false }>]> = [
    ['conflict', { ok: false, reason: 'conflict', message: 'Message x already carries a different context; the first record stands.' }],
    ['invalid', { ok: false, reason: 'invalid', message: 'A context record needs the session id and the message UUID it belongs to.' }],
  ]
  for (const [name, refused] of refusals) {
    test(`a ${name} record settles the send refused with its text; no event, turn, prompt, row or owned failure`, async () => {
      const { manager, sessionId, envelope } = await setup(() => () => refused)
      expect(await manager.send(sessionId, 'with context', envelope)).toEqual({ ok: false, error: `${refused.message} The message was not sent.` })
      await settle()
      expect(shown(sessionId).filter((event) => ['turn_started', 'user_message', 'error'].includes(event.type))).toEqual([])
      expect(prompts).toEqual([])
      expect(rows(sessionId)).toBe(0)
      expect(await driverOf(manager, sessionId).settled()).toBeUndefined()
    })
  }

  test('a throwing context store settles the send refused with its text; nothing observable, no owned failure', async () => {
    const { manager, sessionId, envelope } = await setup(() => () => { throw new Error('disk gone') })
    expect(await manager.send(sessionId, 'with context', envelope)).toEqual({
      ok: false, error: 'The plan context could not be recorded (disk gone); the message was not sent.',
    })
    await settle()
    expect(shown(sessionId).filter((event) => ['turn_started', 'user_message', 'error'].includes(event.type))).toEqual([])
    expect(prompts).toEqual([])
    expect(rows(sessionId)).toBe(0)
    expect(await driverOf(manager, sessionId).settled()).toBeUndefined()
  })

  test('an accepted send settles after its record, under one UUID shared by the record, the user event and the prompt; the record precedes the turn', async () => {
    const recorded: Array<Parameters<Record>[0]> = []
    const { manager, sessionId, envelope } = await setup((real) => (input) => {
      recorded.push(input)
      trace.push('record')
      return real(input)
    })
    const sent = manager.send(sessionId, 'with context', envelope).then((outcome) => {
      trace.push('settled')
      return outcome
    })
    expect(await sent).toEqual({ ok: true })
    // No early success: the record, then the turn it names, then the settlement.
    expect(trace).toEqual(['record', 'turn_started', 'settled'])
    expect(recorded).toHaveLength(1)
    expect(rows(sessionId)).toBe(1)
    await settle()
    const uuid = recorded[0]!.messageUuid
    const own = shown(sessionId)
    const started = own.find((event) => event.type === 'turn_started') as Extract<ChatEvent, { type: 'turn_started' }>
    const user = own.find((event) => event.type === 'user_message') as Extract<ChatEvent, { type: 'user_message' }>
    expect(recorded[0]!.turnId).toBe(started.turnId)
    expect(user.messageUuid).toBe(uuid)
    expect(user.workspaceContext).toEqual(recorded[0]!.context)
    expect(own.indexOf(started)).toBeLessThan(own.indexOf(user))
    expect(prompts.map((prompt) => String(prompt.uuid))).toEqual([uuid])
    expect(prompts[0]!.message.content).toBe('with context')
  })
})

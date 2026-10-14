// Mailbox subscriptions enforce team scope and publish authoritative state.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { MailboxStore } from '../team/mailboxStore'
import type { ServerMessage } from '../../shared/types'

let db: Database
let store: MailboxStore
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let reloads: number
let handOffs: Array<{ messageId: string; target: { kind: string; id: string } }>
let roster: import('../../shared/team').TeamWorktreeOccupancy[]
let waiting: Record<string, import('../../shared/team').WaitingReason>
const REPORT = { loadedAt: '2026-10-12T12:00:00.000Z', dir: '/home/.kawai/routing', rules: [{ groupId: 'devs', file: '/home/.kawai/routing/devs.ts', ok: false, error: 'boom', change: 'changed' as const }] }
beforeEach(() => {
  reloads = 0
  handOffs = []
  roster = [{ worktree: '/repo/feat-x', sessions: [{ sessionId: 'dev', group: 'devs', profile: 'glm', status: 'waiting', spawned: true, taskId: 'task-1' }], pendingSpawns: [{ group: 'qa', profile: 'default' }] }]
  waiting = { m1: { blocker: { kind: 'group-cap', counts: { live: 2, cap: 2 } }, others: [] } }
  db = new Database(':memory:'); store = new MailboxStore(db); messages = []
  connection = { send: message => messages.push(message) }
  const manager = {
    has: (id: string) => id === 'dev',
    whenRestored: () => Promise.resolve(),
    loadHistory: async () => {},
    teams: {
      teamOf: () => ({ teamId: 'team' }),
      catalogForTeam: () => ({ groups: new Map([['architects', {}]]) }),
    },
    // `/repo` is the only known team path (team-workspace-pages D1).
    teamScopes: { resolve: async (teamPath: string) => teamPath === '/repo' ? { teamId: 'team', groupsRoot: '/repo' } : undefined },
    mailbox: { store }, dispatcher: { notify: () => {} },
    routingState: (teamId: string) => ({ rules: reloads > 0 ? REPORT : null, decisions: [{ at: 'now', teamId, groupId: 'devs', messageId: 'm', source: 'builtin', decision: 'none' }] }),
    teamRoster: () => roster,
    waitingFor: () => waiting,
    reloadRoutingRules: async () => { reloads++; return REPORT },
    handOff: (messageId: string, target: { kind: string; id: string }) => {
      handOffs.push({ messageId, target })
      if (store.get(messageId)?.state !== 'parked') throw new Error('Only parked work can be handed off')
      return { id: 'forwarded-1' }
    },
    getSnapshot: () => ({ type: 'chat-snapshot', sessionId: 'dev', events: [], pendingRequests: [] }),
    isArchived: () => true,
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  store.subscribe((team, message) => connections.publishMailbox(team, message))
})
afterEach(() => db.close())
const enqueue = (teamId = 'team', hopLimit?: number) => store.enqueue({ teamId, fromSession: 'lead', fromGroup: null,
  toKind: 'group', toId: 'devs', originPath: '/repo', body: 'Work', hopLimit })
const open = () => connections.handle(connection, { type: 'team-mailbox-open', teamPath: '/repo' })

test('open snapshots, enqueue pushes, close and disconnect unsubscribe', async () => {
  await open(); expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', messages: [] })
  const mail = enqueue(); expect(messages.at(-1)).toMatchObject({ messages: [{ id: mail.id, state: 'queued' }] })
  await connections.handle(connection, { type: 'team-mailbox-close', teamPath: '/repo' })
  const count = messages.length; enqueue(); expect(messages).toHaveLength(count)
  await open(); connections.disconnect(connection)
  const disconnected = messages.length; enqueue(); expect(messages).toHaveLength(disconnected)
})

test('every snapshot carries the waiting reasons beside the roster', async () => {
  await open()
  expect(messages.at(-1)).toMatchObject({
    type: 'team-mailbox-snapshot',
    waiting: { m1: { blocker: { kind: 'group-cap' } } },
  })
  // A reason-only change re-publishes with the new reasons.
  waiting = { m1: { blocker: { kind: 'no-eligible-member', detail: 'a working' }, others: [] } }
  connections.publishMailbox('team')
  expect(messages.at(-1)).toMatchObject({ waiting: { m1: { blocker: { kind: 'no-eligible-member' } } } })
  // A team with no reasons carries an empty map, not a missing field.
  waiting = {}
  connections.publishMailbox('team')
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', waiting: {} })
})

test('every snapshot carries the worktree occupancy roster, empty without sessions', async () => {
  await open()
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', worktrees: [{ worktree: '/repo/feat-x' }] })
  // A row-state change re-publishes the roster alongside the rows.
  enqueue()
  expect(messages.at(-1)).toMatchObject({ worktrees: [{ worktree: '/repo/feat-x', pendingSpawns: [{ group: 'qa', profile: 'default' }] }] })
  // A reconnect snapshot carries it too.
  await connections.handle(connection, { type: 'team-mailbox-close', teamPath: '/repo' })
  await open()
  expect(messages.at(-1)).toMatchObject({ worktrees: [{ worktree: '/repo/feat-x' }] })
  // A team with no live sessions serializes an empty list, not a missing field.
  roster = []
  connections.publishMailbox('team')
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', worktrees: [] })
})
test('cancel, retry, discard push updated snapshots; cross-team actions are refused', async () => {
  await open()
  const mail = enqueue()
  await connections.handle(connection, { type: 'team-mailbox-cancel', teamPath: '/repo', messageId: mail.id })
  expect(store.get(mail.id)?.state).toBe('cancelled')
  const dead = enqueue(); store.deadLetter(dead.id, 'killed-recipient')
  await connections.handle(connection, { type: 'team-mailbox-retry', teamPath: '/repo', messageId: dead.id })
  expect(store.get(dead.id)?.state).toBe('queued')
  store.deadLetter(dead.id, 'killed-recipient')
  await connections.handle(connection, { type: 'team-mailbox-discard', teamPath: '/repo', messageId: dead.id })
  expect(store.get(dead.id)?.state).toBe('discarded')
  const foreign = enqueue('other')
  await connections.handle(connection, { type: 'team-mailbox-cancel', teamPath: '/repo', messageId: foreign.id })
  expect(store.get(foreign.id)?.state).toBe('queued')
  expect(messages.at(-1)).toMatchObject({ type: 'error', message: 'Message does not belong to this team' })
})
test('uncertain retry stays direct to the original recipient with duplicate notice', async () => {
  await open(); const mail = enqueue(); store.claim(mail.id, 'dev'); store.markPushed(mail.id); store.holdUncertain(mail.id, 'torn')
  await connections.handle(connection, { type: 'team-mailbox-retry', teamPath: '/repo', messageId: mail.id })
  expect(store.get(mail.id)).toMatchObject({ state: 'queued', toKind: 'session', toId: 'dev', possibleDuplicate: true })
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot' })
})
test('hop-limit dead letter notifies attached team client once', async () => {
  await connections.handle(connection, { type: 'chat-attach', sessionId: 'dev' })
  const first = enqueue(); store.claim(first.id, 'dev'); store.markDelivered(first.id)
  store.enqueue({ teamId: 'team', fromSession: 'dev', fromGroup: null, toKind: 'group', toId: 'devs', originPath: '/repo',
    body: 'Loop', inReplyTo: first, hopLimit: 1 })
  expect(messages.filter(message => message.type === 'team-mailbox-dead-letter')).toHaveLength(1)
})

test('global hop-limit notifier works without a selected chat', () => {
  const broadcast: ServerMessage[] = []
  const manager = { mailbox: { store } } as unknown as ChatSessionManager
  const globalConnections = new ChatConnections(manager, undefined, message => broadcast.push(message))
  const first = enqueue()
  const dead = store.enqueue({ teamId: 'team', fromSession: 'dev', fromGroup: null, toKind: 'group', toId: 'devs', originPath: '/repo',
    body: 'Loop', inReplyTo: first, hopLimit: 1 })
  globalConnections.publishMailbox('team', dead)
  expect(broadcast).toEqual([{ type: 'team-mailbox-dead-letter', teamId: 'team', messageId: dead.id, senderSession: 'dev' }])
})

test('a reply delivered to the human notifies the attached team client', async () => {
  await connections.handle(connection, { type: 'chat-attach', sessionId: 'dev' })
  const reply = store.enqueue({ teamId: 'team', fromSession: 'dev', fromGroup: 'devs',
    toKind: 'human', toId: null, originPath: '/repo', body: 'Done' })
  store.deliverOnSend(reply.id)
  expect(messages.filter(message => message.type === 'team-mailbox-delivered-to-human')).toEqual([{
    type: 'team-mailbox-delivered-to-human', teamId: 'team', messageId: reply.id,
    senderSession: 'dev', senderKind: 'agent',
  }])
})

test('global delivered-to-human notifier carries the sender kind', () => {
  const broadcast: ServerMessage[] = []
  const manager = { mailbox: { store } } as unknown as ChatSessionManager
  const globalConnections = new ChatConnections(manager, undefined, message => broadcast.push(message))
  const reply = store.enqueue({ teamId: 'team', fromSession: null, fromKind: 'human', fromGroup: null,
    toKind: 'human', toId: null, originPath: '/repo', body: 'Noted' })
  store.deliverOnSend(reply.id)
  globalConnections.publishMailbox('team', store.get(reply.id)!)
  expect(broadcast.at(-1)).toEqual({
    type: 'team-mailbox-delivered-to-human', teamId: 'team', messageId: reply.id,
    senderSession: null, senderKind: 'human',
  })
})

test('close during asynchronous team resolution cannot resurrect a subscription', async () => {
  let resolve!: (team: { teamId: string }) => void
  const manager = {
    has: () => true, whenRestored: () => Promise.resolve(), teamScopes: { resolve: () => new Promise<{ teamId: string }>(done => { resolve = done }) },
    mailbox: { store },
  } as unknown as ChatSessionManager
  const pendingConnections = new ChatConnections(manager)
  const opening = pendingConnections.handle(connection, { type: 'team-mailbox-open', teamPath: '/repo' })
  await pendingConnections.handle(connection, { type: 'team-mailbox-close', teamPath: '/repo' })
  resolve({ teamId: 'team' }); await opening
  pendingConnections.publishMailbox('team')
  expect(messages).toEqual([])
})

test('snapshots carry the team routing state; reload answers with the report and refreshes every view', async () => {
  await open()
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', routing: { rules: null, decisions: [{ teamId: 'team', decision: 'none' }] } })
  await connections.handle(connection, { type: 'team-mailbox-reload-rules', teamPath: '/repo' })
  expect(reloads).toBe(1)
  expect(messages.at(-1)).toEqual({ type: 'team-mailbox-rules-result', teamPath: '/repo', ok: true, report: REPORT })
  connections.publishRoutingRules()
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', routing: { rules: REPORT } })
})

test('the human cancels parked work with its resume mail; a row unparked meanwhile is refused', async () => {
  await open()
  const parkedWork = () => {
    const work = enqueue(); store.claim(work.id, 'dev'); store.markPushed(work.id); store.markDelivered(work.id)
    const resume = store.enqueue({ teamId: 'team', toKind: 'session', toId: 'dev', fromSession: 'dev', fromGroup: null, originPath: '/repo', body: 'resume', deliverAt: '2099-01-01T00:00:00.000Z' })
    store.park(work.id, '2099-01-01T00:00:00.000Z', resume.id)
    return { work, resume }
  }
  const { work, resume } = parkedWork()
  await connections.handle(connection, { type: 'team-mailbox-cancel', teamPath: '/repo', messageId: work.id })
  expect(store.get(work.id)?.state).toBe('cancelled')
  expect(store.get(resume.id)?.state).toBe('cancelled')
  expect(store.eventsFor(work.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'human', actorSession: null, prevState: 'parked' })
  expect(store.eventsFor(resume.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'human' })
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', messages: [] })
  // Unparked a moment earlier: the cancel finds delivered work and says so.
  const second = parkedWork()
  store.unpark(second.work.id)
  await connections.handle(connection, { type: 'team-mailbox-cancel', teamPath: '/repo', messageId: second.work.id })
  expect(store.get(second.work.id)?.state).toBe('delivered')
  expect(messages.filter(m => m.type === 'error').at(-1)).toEqual({ type: 'error', message: 'Message state changed; this action is no longer available' })
})
test('hand off forwards parked work to a team group or session; bad targets and states are refused', async () => {
  await open()
  const mail = enqueue(); store.claim(mail.id, 'dev'); store.markPushed(mail.id); store.markDelivered(mail.id)
  await connections.handle(connection, { type: 'team-mailbox-hand-off', teamPath: '/repo', messageId: mail.id, target: { kind: 'group', id: 'architects' } })
  expect(messages.filter(m => m.type === 'team-mailbox-hand-off-result').at(-1)).toMatchObject({ ok: false, error: 'Only parked work can be handed off' })
  const resume = enqueue(); store.park(mail.id, '2026-10-12T13:00:00.000Z', resume.id)
  await connections.handle(connection, { type: 'team-mailbox-hand-off', teamPath: '/repo', messageId: mail.id, target: { kind: 'group', id: 'architects' } })
  expect(messages.filter(m => m.type === 'team-mailbox-hand-off-result').at(-1)).toEqual({
    type: 'team-mailbox-hand-off-result', teamPath: '/repo', messageId: mail.id, ok: true, forwardedId: 'forwarded-1',
  })
  await connections.handle(connection, { type: 'team-mailbox-hand-off', teamPath: '/repo', messageId: mail.id, target: { kind: 'group', id: 'nope' } })
  expect(messages.filter(m => m.type === 'team-mailbox-hand-off-result').at(-1)).toMatchObject({ ok: false, error: 'Unknown group in this team: nope' })
  await connections.handle(connection, { type: 'team-mailbox-hand-off', teamPath: '/repo', messageId: mail.id, target: { kind: 'session', id: 'stranger' } })
  expect(messages.filter(m => m.type === 'team-mailbox-hand-off-result').at(-1)).toMatchObject({ ok: false, error: 'Unknown session in this team: stranger' })
  expect(handOffs).toHaveLength(2)
})

test('a team path that names no known team is refused with no data and no subscription', async () => {
  await connections.handle(connection, { type: 'team-mailbox-open', teamPath: '/elsewhere' })
  expect(messages).toEqual([{ type: 'error', message: 'unknown-team: /elsewhere' }])
  const mail = enqueue()
  expect(messages).toHaveLength(1)
  await connections.handle(connection, { type: 'team-mailbox-cancel', teamPath: '/elsewhere', messageId: mail.id })
  expect(store.get(mail.id)?.state).toBe('queued')
  expect(messages.at(-1)).toEqual({ type: 'error', message: 'unknown-team: /elsewhere' })
})

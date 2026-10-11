// Dispatcher tests exercise durable claims and recipient state transitions,
// independent of SDK transport and timing of the manager's subscriptions.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'

let db: Database
let store: MailboxStore
let dispatcher: MailDispatcher
let recipients: MailRecipient[]
let delivered: Array<{ recipient: string; id: string }>
let actions: string[]
beforeEach(() => {
  db = new Database(':memory:'); store = new MailboxStore(db)
  recipients = [{ sessionId: 'dev', teamId: 'team', groupId: 'devs', idle: false, pendingRequest: false, available: true }]
  delivered = []; actions = []
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async () => {},
    interrupt: async id => { actions.push('interrupt'); recipients.find(row => row.sessionId === id)!.idle = true },
    deliver: (id, peer) => { actions.push('deliver'); delivered.push({ recipient: id, id: peer.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {},
  })
})
afterEach(() => { dispatcher.close(); db.close() })
const send = (extra: Partial<EnqueueInput> = {}) => store.enqueue({
  teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null,
  originPath: '/repo', body: 'Work', ...extra,
})
const dispatch = async () => { dispatcher.notify(); await dispatcher.settled() }

test('busy member keeps mail queued; idle notification delivers it', async () => {
  const mail = send(); await dispatch()
  expect(store.get(mail.id)?.state).toBe('queued')
  recipients[0]!.idle = true; await dispatch()
  expect(delivered).toEqual([{ recipient: 'dev', id: mail.id }])
  expect(store.get(mail.id)).toMatchObject({ state: 'claimed', claimedBy: 'dev', deliveredAt: null })
})
test('urgent group precedes normal direct; direct precedes older group at equal priority', async () => {
  for (const urgent of [true, false]) {
    const group = send({ priority: urgent ? 'urgent' : 'normal' })
    const direct = send({ toKind: 'session', toId: 'dev' })
    recipients[0]!.idle = true; await dispatch()
    expect(delivered.at(-1)?.id).toBe(urgent ? group.id : direct.id)
    store.cancel(urgent ? direct.id : group.id)
  }
})
test('longest idle member wins once despite simultaneous notifications', async () => {
  recipients[0]!.idle = true; await dispatch()
  recipients.unshift({ sessionId: 'new', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true })
  const mail = send(); dispatcher.notify(); dispatcher.notify(); await dispatcher.settled()
  expect(delivered).toEqual([{ recipient: 'dev', id: mail.id }])
})
test('archived or missing-directory members cannot claim', async () => {
  recipients[0]!.idle = true; recipients[0]!.available = false
  const mail = send(); await dispatch()
  expect(store.get(mail.id)?.state).toBe('queued')
})
test('urgent direct mail awaits interrupt completion before delivery', async () => {
  const mail = send({ toKind: 'session', toId: 'dev', priority: 'urgent' }); await dispatch()
  expect(actions).toEqual(['interrupt', 'deliver'])
  expect(delivered[0]?.id).toBe(mail.id)
})
test('urgent direct mail preserves a pending card until request resolution', async () => {
  recipients[0]!.pendingRequest = true
  const mail = send({ toKind: 'session', toId: 'dev', priority: 'urgent' }); await dispatch()
  expect(store.get(mail.id)?.state).toBe('awaiting-request')
  expect(actions).toEqual([])
  recipients[0]!.pendingRequest = false; await dispatch()
  expect(actions).toEqual(['interrupt', 'deliver'])
})
test('urgent group mail waits for idle without interrupting', async () => {
  const mail = send({ priority: 'urgent' }); await dispatch()
  expect(actions).toEqual([])
  recipients[0]!.idle = true; await dispatch()
  expect(actions).toEqual(['deliver'])
  expect(delivered[0]?.id).toBe(mail.id)
})
test('scheduled self reminder becomes eligible once due and stays queued while busy', async () => {
  const mail = send({ toKind: 'session', toId: 'dev', deliverAt: new Date(Date.now() + 30).toISOString() })
  await dispatch(); expect(delivered).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 50)); await dispatcher.settled()
  expect(store.get(mail.id)?.state).toBe('queued')
  recipients[0]!.idle = true; await dispatch()
  expect(delivered[0]?.id).toBe(mail.id)
})
test('recipient becoming busy while startup is pending loses the claim', async () => {
  dispatcher.close()
  recipients[0]!.idle = true
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async () => { recipients[0]!.idle = false },
    interrupt: async () => {}, deliver: () => { throw new Error('must not deliver') }, watchReceipt: () => {},
  })
  const mail = send(); await dispatch()
  expect(store.get(mail.id)?.state).toBe('queued')
})

test('a new approval during interrupt acknowledgment keeps urgent mail unpushed', async () => {
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {},
    interrupt: async () => { recipients[0]!.pendingRequest = true },
    deliver: () => { throw new Error('approval must stay open') }, watchReceipt: () => {},
  })
  const mail = send({ toKind: 'session', toId: 'dev', priority: 'urgent' })
  await dispatch()
  expect(store.get(mail.id)).toMatchObject({ state: 'awaiting-request', pushedAt: null, claimedBy: null })
})


test('persistently broken earliest recipient does not starve healthy group or direct mail', async () => {
  dispatcher.close()
  recipients[0]!.idle = true
  recipients.push({ ...recipients[0]!, sessionId: 'healthy' })
  const errors: unknown[] = []
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async id => { if (id === 'dev') throw new Error('lost auth') },
    interrupt: async () => {},
    deliver: (id, mail) => { delivered.push({ recipient: id, id: mail.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {}, onError: error => errors.push(error),
  })
  const group = send(); await dispatch()
  expect(delivered).toEqual([{ recipient: 'healthy', id: group.id }])
  recipients[1]!.idle = true
  const sick = send({ toKind: 'session', toId: 'dev' })
  const direct = send({ toKind: 'session', toId: 'healthy' }); await dispatch()
  expect(delivered.at(-1)).toEqual({ recipient: 'healthy', id: direct.id })
  expect(store.get(sick.id)?.state).toBe('queued')
  expect(errors).toHaveLength(2)
})
test('failed push holds the claim immediately and keeps its recipient for human resolution', async () => {
  dispatcher.close(); recipients[0]!.idle = true
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('queue submission failed') }, watchReceipt: () => {},
  })
  const mail = send(); await dispatch()
  expect(store.get(mail.id)).toMatchObject({ state: 'uncertain', claimedBy: 'dev', reason: 'delivery-submit-failed' })
})
test('a recipient lost after push holds a visible claim instead of waiting for restart', async () => {
  dispatcher.close(); recipients[0]!.idle = true
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { recipients[0]!.available = false }, watchReceipt: () => {},
  })
  const mail = send(); await dispatch()
  expect(store.get(mail.id)).toMatchObject({ state: 'uncertain', claimedBy: 'dev' })
})
test('a claim requeued while its interrupt runs is not delivered, then delivered once', async () => {
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {},
    // The awaited interrupt lets the recipient's turn end naturally, which
    // settles it and requeues the unpushed claim mid-flight.
    interrupt: async () => {
      recipients[0]!.idle = true
      for (const mail of store.claimsFor('dev')) store.requeue(mail.id)
    },
    deliver: (id, peer) => {
      delivered.push({ recipient: id, id: peer.messageId })
      recipients.find(row => row.sessionId === id)!.idle = false
    },
    watchReceipt: () => {},
  })
  const mail = send({ toKind: 'session', toId: 'dev', priority: 'urgent' })
  await dispatch()
  expect(delivered).toEqual([])
  expect(store.get(mail.id)).toMatchObject({ state: 'queued', claimedBy: null })
  // Now idle: the requeued mail is delivered exactly once, as a normal turn.
  await dispatch()
  expect(delivered).toEqual([{ recipient: 'dev', id: mail.id }])
  expect(store.get(mail.id)).toMatchObject({ state: 'claimed', claimedBy: 'dev' })
})

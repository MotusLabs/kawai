// Dispatcher tests exercise durable claims and recipient state transitions,
// independent of SDK transport and timing of the manager's subscriptions.
// The legacy delivery-order, claim, and interrupt tests below pin the exact
// boolean shapes of `eligibleFor` and the claim predicate (team-waiting-
// reasons D2); the cause-reporter tests cover every reported exclusion.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { MailDispatcher, type GroupRouter, type MailRecipient, type PassOutcome, type RouteView } from '../team/dispatcher'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'

let db: Database
let store: MailboxStore
let dispatcher: MailDispatcher
let recipients: MailRecipient[]
let delivered: Array<{ recipient: string; id: string }>
let actions: string[]
beforeEach(() => {
  db = schemaDb(':memory:'); store = new MailboxStore(db)
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
    store.cancel(urgent ? direct.id : group.id, { kind: 'human' })
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
test('a held dispatcher records requests and dispatches only once released', async () => {
  dispatcher.close()
  recipients[0]!.idle = true
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: (id, peer) => { delivered.push({ recipient: id, id: peer.messageId }) }, watchReceipt: () => {},
    held: true,
  })
  const mail = send(); await dispatch(); await dispatch()
  expect(store.get(mail.id)?.state).toBe('queued')
  dispatcher.release(); await dispatcher.settled()
  expect(delivered).toEqual([{ recipient: 'dev', id: mail.id }])
  dispatcher.release(); await dispatcher.settled()
  expect(delivered).toHaveLength(1)
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

// Routing (profile-routing D5): the dispatcher asks a router per group message.
const withRouter = (route: GroupRouter['route'], now?: () => number) => {
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async () => {},
    interrupt: async id => { recipients.find(row => row.sessionId === id)!.idle = true },
    deliver: (id, peer) => { delivered.push({ recipient: id, id: peer.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {},
    router: { route },
    ...(now ? { now } : {}),
  })
}

test('the router chooses among eligible members; parked members are not offered', async () => {
  recipients = [
    { sessionId: 'a', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true },
    { sessionId: 'b', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true },
    { sessionId: 'p', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, parked: true },
  ]
  const views: RouteView[] = []
  withRouter(async (_message, view) => { views.push(view); return { kind: 'member', sessionId: 'b' } })
  const m = send(); await dispatch()
  expect(delivered).toEqual([{ recipient: 'b', id: m.id }])
  expect(views[0]!.eligible.map(row => row.sessionId)).toEqual(['a', 'b'])
  expect(views[0]!.attempt).toBe(0)
})

test('a flagged longest-idle member is skipped; the next idle member takes the mail (chat-context-exhaustion D7)', async () => {
  recipients = [
    { sessionId: 'dead', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, contextExhausted: true },
    { sessionId: 'live', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true },
  ]
  const m = send(); await dispatch()
  expect(delivered).toEqual([{ recipient: 'live', id: m.id }])
})

test('a flagged member reports its cause and never claims, group or direct', async () => {
  recipients = [{ sessionId: 'dead', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, contextExhausted: true }]
  let view: RouteView | undefined
  const group = send(); const direct = send({ toKind: 'session', toId: 'dead' })
  let outcome: PassOutcome | undefined
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('must not deliver') }, watchReceipt: () => {},
    router: { route: async (_message, routed) => { view = routed; return { kind: 'member', sessionId: 'dead' } } },
    afterPass: pass => { outcome = pass },
  })
  await dispatch()
  expect(view!.eligible).toEqual([])
  expect(view!.exclusions).toEqual([{ sessionId: 'dead', kind: 'context-exhausted' }])
  expect(store.get(group.id)?.state).toBe('queued')
  expect(store.get(direct.id)?.state).toBe('queued')
  expect(outcome?.reasons.get(direct.id)).toEqual([
    { kind: 'recipient-unavailable', sessionIds: ['dead'], detail: 'the recipient\'s context is exhausted' },
  ])
})

test('a stale pick is routed again, then by attempt 2', async () => {
  recipients = [
    { sessionId: 'busy', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true },
    { sessionId: 'free', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true },
  ]
  const attempts: number[] = []
  withRouter(async (_message, view) => {
    attempts.push(view.attempt)
    if (view.attempt < 2) {
      // The member started a turn while the rule ran.
      recipients[0]!.idle = false
      return { kind: 'member', sessionId: 'busy' }
    }
    return { kind: 'member', sessionId: 'free' }
  })
  const m = send(); await dispatch()
  expect(attempts).toEqual([0, 1, 2])
  expect(delivered).toEqual([{ recipient: 'free', id: m.id }])
})

test('a hold keeps the message queued and re-arms the timer for its retry time', async () => {
  recipients = [{ sessionId: 'a', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true }]
  let hold = true
  withRouter(async (_message, view) => (hold ? { kind: 'hold', retryAt: Date.now() + 30 } : { kind: 'member', sessionId: view.eligible[0]!.sessionId }))
  const m = send(); await dispatch()
  expect(store.get(m.id)?.state).toBe('queued')
  hold = false
  await Bun.sleep(80)
  await dispatcher.settled()
  expect(delivered).toEqual([{ recipient: 'a', id: m.id }])
})

test('direct mail, urgent or not, never consults the router', async () => {
  recipients[0]!.idle = true
  let calls = 0
  withRouter(async () => { calls++; return { kind: 'none' } })
  send({ toKind: 'session', toId: 'dev', priority: 'urgent' })
  send({ toKind: 'session', toId: 'dev' })
  await dispatch()
  expect(calls).toBe(0)
  expect(delivered).toHaveLength(1)
})

test('direct mail stays queued during cooldown and wakes automatically at recovery', async () => {
  dispatcher.close()
  recipients[0]!.idle = true
  recipients[0]!.cooldownUntil = new Date(Date.now() + 50).toISOString()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: (id, peer) => delivered.push({ recipient: id, id: peer.messageId }), watchReceipt: () => {},
  })
  const mail = send({ toKind: 'session', toId: 'dev' })
  await dispatch()
  expect(store.get(mail.id)?.state).toBe('queued')
  expect(delivered).toEqual([])
  const deadline = Date.now() + 1000
  while (delivered.length === 0 && Date.now() < deadline) await Bun.sleep(10)
  expect(delivered).toEqual([{ recipient: 'dev', id: mail.id }])
})

test('urgent direct mail already queued before a limit cannot interrupt during cooldown', async () => {
  recipients[0]!.cooldownUntil = new Date(Date.now() + 60_000).toISOString()
  const mail = send({ toKind: 'session', toId: 'dev', priority: 'urgent' })
  await dispatch()
  expect(actions).toEqual([])
  expect(store.get(mail.id)?.state).toBe('queued')
})

test('a profile entering cooldown during prepare cannot win a direct claim', async () => {
  dispatcher.close()
  recipients[0]!.idle = true
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async () => { recipients[0]!.cooldownUntil = new Date(Date.now() + 60_000).toISOString() },
    interrupt: async () => {}, deliver: () => { throw new Error('must not deliver') }, watchReceipt: () => {},
  })
  const mail = send({ toKind: 'session', toId: 'dev' })
  await dispatch()
  expect(store.get(mail.id)?.state).toBe('queued')
})

test('direct claims enforce the handoff profile exclusion', async () => {
  recipients[0]!.idle = true
  recipients[0]!.profileId = 'glm'
  const mail = send({ toKind: 'session', toId: 'dev', excludedProfile: 'glm' })
  await dispatch()
  expect(delivered).toEqual([])
  expect(store.get(mail.id)?.state).toBe('queued')
})

// Cause reporter (team-waiting-reasons D2): every exclusion kind surfaces in
// the routing view, beneath the predicates whose shapes the tests above pin.
test('the routing view reports each member exclusion cause', async () => {
  recipients = [
    { sessionId: 'working', teamId: 'team', groupId: 'devs', idle: false, pendingRequest: false, available: true },
    { sessionId: 'card', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: true, available: true },
    { sessionId: 'parked', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, parked: true },
    { sessionId: 'elsewhere', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, worktree: '/other' },
    { sessionId: 'sick', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: false },
    { sessionId: 'eligible', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, worktree: '/wt' },
  ]
  let view: RouteView | undefined
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    targetWorktree: () => '/wt',
    router: { route: async (_message, routed) => { view = routed; return { kind: 'none' } } },
    now: () => 1_000,
  })
  send(); await dispatch()
  const byId = new Map((view!.exclusions ?? []).map(entry => [entry.sessionId, entry]))
  expect(byId.get('working')?.kind).toBe('busy')
  expect(byId.get('card')?.kind).toBe('pending-card')
  expect(byId.get('parked')?.kind).toBe('parked')
  expect(byId.get('elsewhere')).toMatchObject({ kind: 'other-worktree', detail: '/other' })
  expect(byId.get('sick')?.kind).toBe('unavailable')
  expect(byId.has('eligible')).toBe(false)
})

test('a member on the excluded profile reports excluded-profile though eligibleFor keeps it', async () => {
  recipients = [
    { sessionId: 'glm-member', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, profileId: 'glm' },
  ]
  let view: RouteView | undefined
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    router: { route: async (_message, routed) => { view = routed; return { kind: 'none' } } },
  })
  send({ excludedProfile: 'glm' }); await dispatch()
  // eligibleFor itself does not reject the profile (the candidate builder
  // does); the breakdown still names it.
  expect(view!.eligible.map(row => row.sessionId)).toEqual(['glm-member'])
  expect(view!.exclusions).toEqual([{ sessionId: 'glm-member', kind: 'excluded-profile' }])
})

test('a start failure is reported with its error text', async () => {
  recipients = [
    { sessionId: 'sick', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true },
  ]
  let view: RouteView | undefined
  const errors: unknown[] = []
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async id => { if (id === 'sick') throw new Error('lost auth') },
    interrupt: async () => {},
    deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    router: { route: async (_message, routed) => { view = routed; return { kind: 'member', sessionId: 'sick' } } },
    onError: error => errors.push(error),
  })
  send(); await dispatch()
  expect(view!.exclusions).toEqual([{ sessionId: 'sick', kind: 'startup-failed', detail: 'lost auth' }])
  // One per routing attempt: the stale pick re-routes (attempts 1 and 2).
  expect(errors).toHaveLength(3)
})

// Direct-mail waiting reasons (D2) and the pass outcome (D3).
test('afterPass reports each direct-mail reason from the recipient view', async () => {
  recipients = [
    { sessionId: 'working', teamId: 'team', groupId: 'devs', idle: false, pendingRequest: false, available: true },
    { sessionId: 'card', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: false, blockedBy: 'Cannot start: directory gone' },
    { sessionId: 'cooling', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, cooldownUntil: new Date(2_000).toISOString() },
  ]
  const outcomes: PassOutcome[] = []
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    afterPass: outcome => outcomes.push(outcome),
    now: () => 1_000,
  })
  const busy = send({ toKind: 'session', toId: 'working' })
  const blocked = send({ toKind: 'session', toId: 'card' })
  const cooling = send({ toKind: 'session', toId: 'cooling' })
  await dispatch()
  const reasons = outcomes.at(-1)!.reasons
  expect(reasons.get(busy.id)).toEqual([{ kind: 'recipient-busy' }])
  expect(reasons.get(blocked.id)).toEqual([{ kind: 'recipient-unavailable', detail: 'Cannot start: directory gone' }])
  expect(reasons.get(cooling.id)).toEqual([{ kind: 'profile-cooling', retryAt: new Date(2_000).toISOString() }])
  expect(outcomes.at(-1)!.waiting.has(busy.id)).toBe(true)
})

test('a recipient cooled by its provider reports the provider in the constraint detail (4.6)', async () => {
  recipients = [
    { sessionId: 'flash', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true,
      cooldownUntil: new Date(2_000).toISOString(), cooldownProvider: 'zai', cooldownProviderLabel: 'Z.AI' },
  ]
  const outcomes: PassOutcome[] = []
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    afterPass: outcome => outcomes.push(outcome),
    now: () => 1_000,
  })
  const cooling = send({ toKind: 'session', toId: 'flash' })
  await dispatch()
  // The label rides beside the raw id (providers-and-workers O1); without one
  // the constraint keeps today's shape.
  expect(outcomes.at(-1)!.reasons.get(cooling.id))
    .toEqual([{ kind: 'profile-cooling', retryAt: new Date(2_000).toISOString(), detail: 'zai', providerLabel: 'Z.AI' }])
})

test('a cooling constraint without a provider label keeps its shape', async () => {
  recipients = [
    { sessionId: 'flash', teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true,
      cooldownUntil: new Date(2_000).toISOString(), cooldownProvider: 'zai' },
  ]
  const outcomes: PassOutcome[] = []
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    afterPass: outcome => outcomes.push(outcome),
    now: () => 1_000,
  })
  const cooling = send({ toKind: 'session', toId: 'flash' })
  await dispatch()
  expect(outcomes.at(-1)!.reasons.get(cooling.id))
    .toEqual([{ kind: 'profile-cooling', retryAt: new Date(2_000).toISOString(), detail: 'zai' }])
})

test('an awaiting-request row reports its pending card and clears when delivered', async () => {
  recipients[0]!.pendingRequest = true
  const outcomes: PassOutcome[] = []
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
    deliver: (id, peer) => { delivered.push({ recipient: id, id: peer.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {}, afterPass: outcome => outcomes.push(outcome),
  })
  const mail = send({ toKind: 'session', toId: 'dev', priority: 'urgent' })
  await dispatch()
  expect(store.get(mail.id)?.state).toBe('awaiting-request')
  expect(outcomes.at(-1)!.reasons.get(mail.id)).toEqual([{ kind: 'recipient-pending-request' }])
  recipients[0]!.pendingRequest = false; recipients[0]!.idle = true
  await dispatch()
  expect(delivered).toEqual([{ recipient: 'dev', id: mail.id }])
  expect(outcomes.at(-1)!.reasons.has(mail.id)).toBe(false)
  expect(outcomes.at(-1)!.waiting.has(mail.id)).toBe(false)
})

test('a start failure persists across passes with its error until the message leaves the queue', async () => {
  recipients[0]!.idle = true
  const outcomes: PassOutcome[] = []
  const errors: unknown[] = []
  dispatcher.close()
  dispatcher = new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async () => { throw new Error('lost auth') },
    interrupt: async () => {}, deliver: () => { throw new Error('no delivery') }, watchReceipt: () => {},
    afterPass: outcome => outcomes.push(outcome), onError: error => errors.push(error),
  })
  const mail = send({ toKind: 'session', toId: 'dev' })
  await dispatch(); await dispatch()
  for (const outcome of outcomes) expect(outcome.reasons.get(mail.id)).toEqual([{ kind: 'startup-failed', detail: 'lost auth' }])
  // Cancelled: the failure leaves with the message.
  store.cancel(mail.id, { kind: 'human' }); await dispatch()
  expect(outcomes.at(-1)!.reasons.has(mail.id)).toBe(false)
  expect(outcomes.at(-1)!.waiting.has(mail.id)).toBe(false)
})

test('armTimer fires no earlier than the earliest armed time', async () => {
  dispatcher.close()
  const base = Date.now()
  const armed: number[] = []
  const realSetTimeout = globalThis.setTimeout
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
    armed.push(ms ?? 0)
    return realSetTimeout(handler, ms)
  }) as typeof globalThis.setTimeout)
  try {
    dispatcher = new MailDispatcher(store, {
      recipients: () => [], prepare: async () => {}, interrupt: async () => {}, deliver: () => {}, watchReceipt: () => {},
      // Armed sources: a scheduled row at +400, a hold at +300, wakeAt at +250.
      wakeAt: () => base + 250,
      router: { route: async () => ({ kind: 'hold', retryAt: base + 300 }) },
    })
    send({ deliverAt: new Date(base + 400).toISOString() })
    const held = send()
    dispatcher.notify(); await dispatcher.settled()
    expect(store.get(held.id)?.state).toBe('queued')
    // One arming so far; its delay is the minimum of every armed time.
    expect(armed).toHaveLength(1)
    expect(armed[0]).toBeGreaterThanOrEqual(240)
    expect(armed[0]).toBeLessThanOrEqual(250)
  } finally { spy.mockRestore() }
})

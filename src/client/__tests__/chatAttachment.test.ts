// The per-connection chat attachment registry (plan-workspace §6.1): host
// tokens hold a session with exactly one wire attach per connection, a
// same-commit host transfer cancels the coalesced detach, a held
// subscription's reconnect re-attaches once with historyFrom while a real
// close/reopen never resumes, registries are independent per connection
// identity, and the reveal designation follows the latest claimant with a
// survivor takeover. These pin the state machine the ChatSurface wiring
// (chatSurfaceHost.test.tsx) drives through real mounts.
import { describe, expect, test } from 'bun:test'
import type { ClientMessage } from '@shared/types'
import {
  claimReveal, createHostToken, isRevealDesignated, registryFor, releaseReveal,
  subscribeRevealDesignation,
} from '../stores/chatAttachment'

/** One microtask tick: a scheduled detach fires ahead of the await resume. */
const flushDetach = () => new Promise<void>(resolve => queueMicrotask(resolve))

function connection() {
  const sent: ClientMessage[] = []
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const attaches = () => sent.filter((message): message is Extract<ClientMessage, { type: 'chat-attach' }> => message.type === 'chat-attach')
  const detaches = () => sent.filter(message => message.type === 'chat-detach')
  return { sent, sendMessage, registry: registryFor(sendMessage), attaches, detaches }
}

describe('chat attachment registry', () => {
  test('the first acquire and sync send one plain attach; a re-acquire is idempotent', () => {
    const { registry, attaches, detaches } = connection()
    const token = createHostToken()
    registry.acquire('s', token)
    registry.sync('s', 1, {})
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 's' }])
    registry.acquire('s', token)
    registry.sync('s', 1, {})
    expect(attaches()).toHaveLength(1)
    expect(detaches()).toHaveLength(0)
  })

  test('a second host adds a hold without wire traffic; a non-last release detaches nothing', () => {
    const { registry, attaches, detaches } = connection()
    const first = createHostToken()
    const second = createHostToken()
    registry.acquire('s', first)
    registry.sync('s', 1, {})
    registry.acquire('s', second)
    registry.sync('s', 1, {})
    expect(attaches()).toHaveLength(1)
    registry.release('s', first)
    expect(detaches()).toHaveLength(0)
    registry.sync('s', 1, {})
    expect(attaches()).toHaveLength(1)
  })

  test('the last release detaches one microtask later, not synchronously', async () => {
    const { registry, detaches } = connection()
    const token = createHostToken()
    registry.acquire('s', token)
    registry.sync('s', 1, {})
    registry.release('s', token)
    expect(detaches()).toHaveLength(0)
    await flushDetach()
    expect(detaches()).toEqual([{ type: 'chat-detach', sessionId: 's' }])
  })

  test('a same-commit host transfer cancels the detach and keeps the subscription', async () => {
    const { registry, attaches, detaches } = connection()
    const fullScreen = createHostToken()
    const embedded = createHostToken()
    registry.acquire('s', fullScreen)
    registry.sync('s', 1, {})
    registry.release('s', fullScreen) // schedules the detach…
    registry.acquire('s', embedded) // …cancelled before the microtask fires
    await flushDetach()
    expect(detaches()).toHaveLength(0)
    expect(attaches()).toHaveLength(1)
    // Still attached at the same epoch: the arriving host syncs to nothing.
    registry.sync('s', 1, {})
    expect(attaches()).toHaveLength(1)
  })

  test('a transfer keeps the session releasable: the arriving host\'s later release detaches', async () => {
    const { registry, detaches } = connection()
    const fullScreen = createHostToken()
    const embedded = createHostToken()
    registry.acquire('s', fullScreen)
    registry.sync('s', 1, {})
    registry.release('s', fullScreen)
    registry.acquire('s', embedded)
    await flushDetach()
    // The surviving host closes later: its release must still detach, not
    // inherit the cancelled transfer's stale scheduled flag.
    registry.release('s', embedded)
    await flushDetach()
    expect(detaches()).toEqual([{ type: 'chat-detach', sessionId: 's' }])
  })

  test('a real detach followed by a higher-epoch reopen is a plain attach', async () => {
    const { registry, attaches } = connection()
    const first = createHostToken()
    registry.acquire('s', first)
    registry.sync('s', 1, { historyStartId: 'hist-a' })
    registry.release('s', first)
    await flushDetach()
    const second = createHostToken()
    registry.acquire('s', second)
    registry.sync('s', 5, { historyExpanded: false, historyStartId: 'hist-a' })
    expect(attaches()[1]).toEqual({ type: 'chat-attach', sessionId: 's' })
  })

  test('a held session reconnects exactly once with historyFrom and no detach', () => {
    const { registry, attaches, detaches } = connection()
    const token = createHostToken()
    registry.acquire('s', token)
    registry.sync('s', 1, {})
    // The socket dropped and returned (epoch bumped); the hold never left.
    registry.sync('s', 2, { historyStartId: 'hist-a' })
    expect(attaches()).toEqual([
      { type: 'chat-attach', sessionId: 's' },
      { type: 'chat-attach', sessionId: 's', historyFrom: 'hist-a' },
    ])
    expect(detaches()).toHaveLength(0)
  })

  test('expanded history resumes even on the first attach; without a window start it does not', () => {
    const { registry, attaches } = connection()
    const token = createHostToken()
    registry.acquire('a', token)
    registry.sync('a', 1, { historyExpanded: true, historyStartId: 'hist-a' })
    registry.acquire('b', token)
    registry.sync('b', 1, { historyExpanded: true })
    expect(attaches()).toEqual([
      { type: 'chat-attach', sessionId: 'a', historyFrom: 'hist-a' },
      { type: 'chat-attach', sessionId: 'b' },
    ])
  })

  test('held sessions resume independently across one reconnect', () => {
    const { registry, attaches } = connection()
    const one = createHostToken()
    const two = createHostToken()
    registry.acquire('a', one)
    registry.acquire('b', two)
    registry.sync('a', 1, {})
    registry.sync('b', 1, {})
    registry.sync('a', 2, { historyStartId: 'h-a' })
    registry.sync('b', 2, { historyStartId: 'h-b' })
    expect(attaches().map(message => message.historyFrom)).toEqual([undefined, undefined, 'h-a', 'h-b'])
  })

  test('registries are independent per connection: a hold on one never suppresses the other', () => {
    const one = connection()
    const two = connection()
    const tokenOne = createHostToken()
    const tokenTwo = createHostToken()
    // Same session, same epoch, two connections (two pages / registries).
    one.registry.acquire('s', tokenOne)
    one.registry.sync('s', 1, {})
    two.registry.acquire('s', tokenTwo)
    two.registry.sync('s', 1, {})
    expect(one.attaches()).toEqual([{ type: 'chat-attach', sessionId: 's' }])
    expect(two.attaches()).toEqual([{ type: 'chat-attach', sessionId: 's' }])
  })

  test('a release of an absent token is a no-op; sync without holds never attaches', () => {
    const { registry, attaches, detaches } = connection()
    const token = createHostToken()
    registry.release('s', token)
    registry.sync('s', 1, {})
    expect(attaches()).toHaveLength(0)
    expect(detaches()).toHaveLength(0)
  })

  test('a sync after the last release and its detach never re-attaches without a host', async () => {
    const { registry, attaches } = connection()
    const token = createHostToken()
    registry.acquire('s', token)
    registry.sync('s', 1, {})
    registry.release('s', token)
    await flushDetach()
    registry.sync('s', 2, { historyStartId: 'hist-a' })
    expect(attaches()).toHaveLength(1)
  })

  test('an acquire before the first sync stays silent while offline; the sync attaches once', () => {
    const { registry, attaches } = connection()
    const token = createHostToken()
    registry.acquire('s', token)
    expect(attaches()).toHaveLength(0)
    registry.sync('s', 1, {})
    expect(attaches()).toHaveLength(1)
  })
})

describe('reveal designation', () => {
  test('the latest claimant is designated and the survivor takes over', () => {
    const first = createHostToken()
    const second = createHostToken()
    claimReveal('reveal-s', first)
    expect(isRevealDesignated('reveal-s', first)).toBe(true)
    claimReveal('reveal-s', second)
    expect(isRevealDesignated('reveal-s', second)).toBe(true)
    expect(isRevealDesignated('reveal-s', first)).toBe(false)
    // Removing the designated promotes the still-mounted survivor.
    releaseReveal('reveal-s', second)
    expect(isRevealDesignated('reveal-s', first)).toBe(true)
    releaseReveal('reveal-s', first)
    expect(isRevealDesignated('reveal-s', first)).toBe(false)
  })

  test('claims are idempotent and a repeated claim keeps one entry', () => {
    const token = createHostToken()
    const other = createHostToken()
    claimReveal('reveal-idem', token)
    claimReveal('reveal-idem', token)
    claimReveal('reveal-idem', other)
    claimReveal('reveal-idem', token)
    expect(isRevealDesignated('reveal-idem', token)).toBe(true)
    expect(isRevealDesignated('reveal-idem', other)).toBe(false)
    // Removing the non-designated claimant changes nothing.
    releaseReveal('reveal-idem', other)
    expect(isRevealDesignated('reveal-idem', token)).toBe(true)
    releaseReveal('reveal-idem', token)
    releaseReveal('reveal-idem', token)
    expect(isRevealDesignated('reveal-idem', token)).toBe(false)
  })

  test('a designation change notifies the session subscribers, takeover included', () => {
    const seen: number[] = []
    const unsubscribe = subscribeRevealDesignation('reveal-sub', () => { seen.push(seen.length + 1) })
    expect(seen).toEqual([]) // subscribing alone notifies nobody
    const owner = createHostToken()
    const survivor = createHostToken()
    claimReveal('reveal-sub', owner)
    expect(seen).toEqual([1])
    // A survivor subscribing after the owner is not told retroactively…
    unsubscribe()
    claimReveal('reveal-sub', survivor)
    expect(seen).toEqual([1])
    // …but a live subscriber hears the takeover when the designated
    // claimant releases: the previous claimant is promoted.
    const takeover: string[] = []
    const stop = subscribeRevealDesignation('reveal-sub', () => {
      takeover.push(isRevealDesignated('reveal-sub', owner) ? 'owner' : 'other')
    })
    releaseReveal('reveal-sub', survivor) // the designated release promotes the owner
    expect(takeover).toEqual(['owner'])
    releaseReveal('reveal-sub', owner) // the last claim leaves: nobody is designated
    expect(takeover).toEqual(['owner', 'other'])
    stop()
    releaseReveal('reveal-sub', owner)
    expect(takeover).toEqual(['owner', 'other']) // unsubscribed: no more calls
  })

  test('subscribers of other sessions are never notified; unsubscribe is idempotent', () => {
    const hits: string[] = []
    const stopA = subscribeRevealDesignation('reveal-a', () => { hits.push('a') })
    subscribeRevealDesignation('reveal-b', () => { hits.push('b') })
    claimReveal('reveal-a', createHostToken())
    expect(hits).toEqual(['a'])
    stopA()
    stopA() // a second unsubscribe is a no-op, not a crash
    releaseReveal('reveal-a', createHostToken())
    expect(hits).toEqual(['a'])
  })
})

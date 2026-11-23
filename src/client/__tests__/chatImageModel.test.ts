import { afterEach, expect, test } from 'bun:test'
import { propertyCases } from '../../server/__tests__/helpers/propertyCases'
import type { ClientMessage } from '@shared/types'
import { LIFECYCLE_ORACLES, oracleRows } from '../../../tests/fixtures/chatImageOracles'
import { useChatStore } from '../stores/chatStore'
import { useChatImageDrafts } from '../stores/chatImageDrafts'
import { consumeSendAnswer } from '../stores/pendingSendRecovery'
import { markImageSendsUnconfirmed, restoreImageAttempt, submitImageDraft } from '../stores/chatImageSends'

const file = (name = 'image') => new File(['image'], name + '.png', { type: 'image/png' })
const uploaded = { id: `${'a'.repeat(64)}.png`, mediaType: 'image/png', byteSize: 5 }
const fetchImage = (async () => Response.json({ image: uploaded })) as unknown as typeof fetch
const clean = () => {
  for (const id of ['a', 'b']) useChatImageDrafts.getState().removeSession(id)
  useChatStore.setState({ drafts: {} })
}
afterEach(clean)

for (const [id, condition, result] of oracleRows(LIFECYCLE_ORACLES)) {
  test(`${id}: ${condition} -> ${result}`, async () => {
    clean()
    useChatImageDrafts.getState().add('a', [file()])
    useChatStore.getState().setDraft('a', 'original')
    const sent: ClientMessage[] = []
    let release!: (response: Response) => void
    const delayed = new Promise<Response>(resolve => { release = resolve })
    const run = submitImageDraft({ sessionId: 'a', text: 'original', scope: null,
      send: message => sent.push(message), connected: () => true,
      fetch: id === 'L1' ? (() => delayed) as unknown as typeof fetch
        : id === 'L3' ? (async () => Response.json({ error: 'failed' }, { status: 500 })) as unknown as typeof fetch : fetchImage,
    })
    if (id === 'L1') {
      expect(Object.values(useChatImageDrafts.getState().attempts)[0].state).toBe('uploading')
      expect(sent).toHaveLength(0); release(await fetchImage('')); await run; return
    }
    await run
    const pending = Object.values(useChatImageDrafts.getState().attempts)[0]
    if (id === 'L3') {
      expect(sent).toHaveLength(0)
      expect(pending.state).toBe('refused')
      expect(useChatStore.getState().drafts.a).toBe('original'); return
    }
    expect(sent).toHaveLength(1)
    if (id === 'L2') { expect(pending.state).toBe('awaiting-result'); return }
    if (id === 'L4') {
      consumeSendAnswer({ type: 'error', sessionId: 'a', requestId: pending.requestId, message: 'refused' })
      expect(useChatImageDrafts.getState().attempts[pending.requestId].state).toBe('refused')
      expect(useChatStore.getState().drafts.a).toBe('original'); return
    }
    if (id === 'L6' || id === 'L7') {
      markImageSendsUnconfirmed()
      if (id === 'L7') markImageSendsUnconfirmed()
      expect(useChatImageDrafts.getState().attempts[pending.requestId].state).toBe('unconfirmed')
      expect(sent).toHaveLength(1); return
    }
    consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: pending.requestId, accepted: true })
    expect(useChatStore.getState().drafts.a).toBeUndefined()
    expect(useChatImageDrafts.getState().drafts.a).toEqual([])
    if (id === 'L8') {
      useChatStore.getState().setDraft('a', 'newer')
      consumeSendAnswer({ type: 'error', sessionId: 'a', message: 'Runtime ended' })
      expect(useChatStore.getState().drafts.a).toBe('newer')
    }
    if (id === 'L9') consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: pending.requestId, accepted: true })
    expect(Object.keys(useChatImageDrafts.getState().attempts)).toHaveLength(0)
    expect(sent).toHaveLength(1)
  })
}

test('Q1/Q3: seeded draft and submission model preserves isolation and never replays (seed 1a6e2026, 200x40)', async () => {
  let seed = 0x1a6e2026
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  for (let sample = 0; sample < propertyCases(200); sample++) {
    clean()
    useChatImageDrafts.getState().add('b', [file('other')])
    const other = useChatImageDrafts.getState().drafts.b
    const sent: ClientMessage[] = []
    let text = '', images: string[] = [], revision = 0, sendCount = 0
    const model = new Map<string, { state: 'awaiting-result' | 'unconfirmed' | 'refused'; revision: number; text: string; images: string[] }>()
    for (let step = 0; step < 40; step++) {
      const command = next() % 10
      const state = useChatImageDrafts.getState()
      if (command === 0) {
        text = `edited-${sample}-${step}`; revision++
        useChatStore.getState().setDraft('a', text)
      } else if (command === 1 && images.length < 4) {
        const name = `image-${sample}-${step}`; images.push(name + '.png'); revision++
        state.add('a', [file(name)])
      } else if (command === 2 && images.length) {
        state.removeImage('a', state.drafts.a[0].clientId); images.shift(); revision++
      } else if (command === 3) {
        const allowed = images.length && ![...model.values()].some(p => p.revision === revision && p.state === 'awaiting-result')
        await submitImageDraft({ sessionId: 'a', text, scope: null, send: message => sent.push(message), connected: () => true, fetch: fetchImage })
        if (allowed) {
          sendCount++
          const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat-send' }>
          model.set(message.requestId!, { state: 'awaiting-result', revision, text, images: [...images] })
        }
      } else if (command === 4 || command === 5) {
        markImageSendsUnconfirmed()
        for (const p of model.values()) if (p.state === 'awaiting-result') p.state = 'unconfirmed'
      } else if (command === 6 || command === 7) {
        const entry = [...model.entries()].find(([, p]) => p.state !== 'refused')
        if (entry) {
          const [id, p] = entry
          if (command === 6) {
            consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: id, accepted: true })
            if (revision === p.revision) { revision += 1 + (text ? 1 : 0); text = ''; images = [] }
            model.delete(id)
          } else {
            consumeSendAnswer({ type: 'error', sessionId: 'a', requestId: id, message: 'refused' }); p.state = 'refused'
          }
        }
      } else if (command === 8) {
        const entry = [...model.entries()].find(([, p]) => p.state === 'refused' || p.state === 'unconfirmed')
        if (entry) {
          const [id, p] = entry
          restoreImageAttempt(id); revision += 1 + (text !== p.text ? 1 : 0); text = p.text; images = [...p.images]
          if (p.state === 'refused') model.delete(id)
        }
      } else if (command === 9) {
        useChatStore.getState().remove('a'); text = ''; images = []; revision = 0; model.clear()
      }
      const actual = useChatImageDrafts.getState()
      expect(sent.length).toBe(sendCount)
      expect(actual.drafts.b).toBe(other)
      expect(useChatStore.getState().drafts.a ?? '').toBe(text)
      expect((actual.drafts.a ?? []).map(i => i.file.name)).toEqual(images)
      expect(actual.revisions.a ?? 0).toBe(revision)
      expect(Object.keys(actual.attempts)).toHaveLength(model.size)
      for (const [id, p] of model) expect(actual.attempts[id]).toMatchObject({ state: p.state, revision: p.revision, text: p.text })
    }
  }
})

for (const boundary of ['uploading', 'awaiting-result', 'unconfirmed', 'refused', 'accepted'] as const) {
  test(`reload at ${boundary} boundary discards local snapshots without replay or late resurrection`, async () => {
    clean()
    useChatImageDrafts.getState().add('a', [file()])
    const sent: ClientMessage[] = []
    let release!: (response: Response) => void
    const upload = new Promise<Response>(resolve => { release = resolve })
    const run = submitImageDraft({ sessionId: 'a', text: '', scope: null, send: m => sent.push(m), connected: () => true,
      fetch: boundary === 'uploading' ? (() => upload) as unknown as typeof fetch : fetchImage,
    })
    if (boundary !== 'uploading') await run
    const pending = Object.values(useChatImageDrafts.getState().attempts)[0]
    if (boundary === 'unconfirmed') markImageSendsUnconfirmed()
    if (boundary === 'refused') consumeSendAnswer({ type: 'error', sessionId: 'a', requestId: pending.requestId, message: 'refused' })
    if (boundary === 'accepted') consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: pending.requestId, accepted: true })
    const count = sent.length
    // Local stores are intentionally not persisted. Releasing their owners
    // models page teardown; the browser suite also checks an actual reload.
    clean()
    release(Response.json({ image: uploaded })); await run
    consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: pending.requestId, accepted: true })
    markImageSendsUnconfirmed()
    expect(sent).toHaveLength(count)
    expect(useChatImageDrafts.getState().drafts.a).toBeUndefined()
    expect(Object.values(useChatImageDrafts.getState().attempts)).toHaveLength(0)
  })
}

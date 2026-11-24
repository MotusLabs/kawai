import { expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import TestRenderer, { act } from 'react-test-renderer'
import { Hono } from 'hono'
import type { ClientMessage, Session } from '@shared/types'
import { HISTORY_ORACLES, oracleRows } from '../../../tests/fixtures/chatImageOracles'
import { CHAT_IMAGE_RED_BASE64 } from '../../../tests/fixtures/chatImage'
import { ChatImageStore } from '../../server/chat/images/ChatImageStore'
import { createChatImageRoutes } from '../../server/routes/chatImages'
import { parseTranscriptContent } from '../../server/chat/transcriptReplay'
import { parseCodexRollout } from '../../server/chat/codex/codexRollout'
import { createHarness } from '../../server/__tests__/fixtures/chatDriverHarness'
import ChatComposer from '../components/chat/ChatComposer'
import ChatSurface from '../components/chat/ChatSurface'
import ChatMessageImages from '../components/chat/ChatMessageImages'
import { useChatImageDrafts } from '../stores/chatImageDrafts'
import { useChatStore } from '../stores/chatStore'
import { submitImageDraft } from '../stores/chatImageSends'

const bytes = Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64')
for (const [id, condition, result] of oracleRows(HISTORY_ORACLES)) {
// @covers: chat-image-attachments › Image attachments coexist with existing composer controls › Slash menu and reset
  test(`${id}: ${condition} -> ${result}`, async () => {
    const dir = await fs.mkdtemp('/tmp/kawai-image-history-')
    const store = new ChatImageStore(dir)
    const image = await store.put('a', bytes, 'image/png')
    const app = new Hono().route('/api/chat', createChatImageRoutes(store, { has: () => true, isArchived: () => true }))
    const sent: ClientMessage[] = []
    let view: TestRenderer.ReactTestRenderer | undefined
    const draft = useChatImageDrafts.getState()
    draft.removeSession('a'); draft.removeSession('b')
    try {
      if (id === 'H1' || id === 'H2') {
        draft.add('a', [new File([bytes], 'a.png', { type: 'image/png' })])
        draft.add('b', [new File([bytes], 'b.png', { type: 'image/png' })])
        const other = useChatImageDrafts.getState().drafts.b
        const original = useChatImageDrafts.getState().drafts.a[0]
        let release!: (response: Response) => void
        const pending = submitImageDraft({ sessionId: 'a', text: '', scope: null, send: m => sent.push(m), connected: () => true,
          fetch: (() => new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch })
        const revoked = spyOn(URL, 'revokeObjectURL')
        try {
          if (id === 'H2') useChatStore.getState().remove('a')
          release(Response.json({ image })); await pending
          expect(useChatImageDrafts.getState().drafts.b).toBe(other)
          expect(sent).toHaveLength(id === 'H2' ? 0 : 1)
          if (id === 'H2') { expect(revoked).toHaveBeenCalledWith(original.url); expect(useChatImageDrafts.getState().drafts.a).toBeUndefined() }
          else expect(sent[0]).toMatchObject({ sessionId: 'a' })
        } finally { revoked.mockRestore() }
      } else if (['H4', 'H5', 'H11'].includes(id)) {
        // Replay from independently reopened durable assets, without a live driver.
        expect((await new ChatImageStore(dir).read('a', image.id)).bytes).toEqual(bytes)
        const blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: CHAT_IMAGE_RED_BASE64 } }]
        for (const text of ['', 'look']) {
          const claude = JSON.stringify({ type: 'user', uuid: 'stable', timestamp: '2026-11-19T10:00:00Z', message: { role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...blocks, ...blocks] } })
          const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-11-19T10:00:00Z', payload: { type: 'message', role: 'user', content: [...(text ? [{ type: 'input_text', text }] : []), ...[1, 2].map(() => ({ type: 'input_image', image_url: `data:image/png;base64,${CHAT_IMAGE_RED_BASE64}` }))] } })
          for (const events of [parseTranscriptContent(claude).events, parseCodexRollout(codex)]) {
            const users = events.filter(e => e.type === 'user_message')
            expect(users).toHaveLength(1); expect(users[0].text).toBe(text)
            expect(users[0].images?.map(i => i.id)).toEqual([image.id, image.id])
          }
          expect(parseTranscriptContent(claude).events).toEqual(parseTranscriptContent(claude).events)
        }
      } else if (id === 'H3' || id === 'H7') {
        draft.add('a', [new File([bytes], 'draft.png', { type: 'image/png' })])
        const original = useChatImageDrafts.getState().drafts.a
        const response = await app.request(`/api/chat/a/images/${image.id}`)
        expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
        expect(useChatImageDrafts.getState().drafts.a).toBe(original)
      } else if (id === 'H6') {
        await fs.mkdir(dir + '/b')
        await fs.symlink(dir + '/a/' + image.id, dir + '/b/' + image.id)
        for (const url of [`b/images/${image.id}`, `a/images/${'f'.repeat(64)}.png`, 'a/images/unsafe']) expect((await app.request('/api/chat/' + url)).status).toBe(404)
        act(() => { view = TestRenderer.create(<ChatMessageImages sessionId="a" images={[image]} />) })
        act(() => view!.root.findByType('img').props.onError())
        expect(view!.root.findByProps({ 'aria-label': 'Image 1 unavailable' })).toBeDefined()
      } else if (id === 'H8') {
        const h = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
        try {
          const context = { teamId: 't', planId: 'p', planTitle: 'Plan', version: { kind: 'revision' as const, revision: 1, contentHash: 'a'.repeat(64) }, executionId: null, changeName: null, documentRefId: null }
          expect(await h.driver.sendWorkspaceContext('', context, [await store.read('a', image.id)])).toEqual({ ok: true })
          expect((await h.nextWrite(), h.prompts.at(-1))?.pasted_content).toHaveLength(1)
          expect(h.events.find(e => e.type === 'user_message')).toMatchObject({ images: [image], workspaceContext: context })
        } finally { await h.cleanup() }
      } else {
        draft.add('a', [new File([bytes], 'draft.png', { type: 'image/png' })])
        if (id === 'H9') {
          useChatStore.getState().setDraft('a', '/clear')
          const session = { id: 'a', name: 'a', kind: 'chat', projectPath: '/tmp', status: 'waiting' } as Session
          act(() => { view = TestRenderer.create(<ChatSurface session={session} sendMessage={m => sent.push(m)} connectionStatus="connected" connectionEpoch={1} />) })
          act(() => view!.root.findByType('form').props.onSubmit({ preventDefault() {} }))
          expect(useChatImageDrafts.getState().errors.a).toContain('Remove the attached images')
          expect(sent.some(m => m.type === 'chat-send' || m.type === 'session-create')).toBe(false)
        } else {
          act(() => { view = TestRenderer.create(<ChatComposer sessionId="a" status="waiting" connected commandState={{ status: 'ready', commands: [{ name: 'clear', description: 'Clear', aliases: [], source: 'builtin' }] }} onSubmit={() => { throw Error('must not send') }} onInterrupt={() => {}} />) })
          act(() => view!.root.findByType('textarea').props.onChange({ target: { value: '/cl' } }))
          act(() => view!.root.findByProps({ role: 'option' }).props.onClick())
          expect(useChatStore.getState().drafts.a).toBe('/clear ')
        }
        expect(useChatImageDrafts.getState().drafts.a).toHaveLength(1)
      }
    } finally {
      if (view) act(() => view!.unmount())
      useChatImageDrafts.getState().removeSession('a'); useChatImageDrafts.getState().removeSession('b')
      useChatStore.setState({ drafts: {} })
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
}

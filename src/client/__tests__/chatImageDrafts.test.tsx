import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import ChatComposer from '../components/chat/ChatComposer'
import ChatMessages from '../components/chat/ChatMessages'
import { useChatStore } from '../stores/chatStore'
import { pastedImages, useChatImageDrafts } from '../stores/chatImageDrafts'
import { consumeSendAnswer } from '../stores/pendingSendRecovery'
import { markImageSendsUnconfirmed, restoreImageAttempt, submitImageDraft } from '../stores/chatImageSends'
import { usePlanWorkspaceScopeStore, type CapturedWorkspaceScope } from '../stores/planWorkspaceScopeStore'

const file = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'paste.png', { type: 'image/png' })
const reference = { id: `${'a'.repeat(64)}.png`, mediaType: 'image/png', byteSize: 8 }
let renderer: TestRenderer.ReactTestRenderer | undefined
beforeEach(() => {
  for (const id of Object.keys(useChatImageDrafts.getState().drafts)) useChatImageDrafts.getState().removeSession(id)
  useChatImageDrafts.setState({ drafts: {}, revisions: {}, attempts: {}, errors: {} })
  useChatStore.setState({ drafts: {}, sessions: {} })
  usePlanWorkspaceScopeStore.setState({ scopes: {} })
})
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined })
const upload = async () => Response.json({ image: reference })

// @covers: chat-image-attachments › Clipboard images become removable draft previews › Paste a screenshot
// @covers: chat-image-attachments › Clipboard images become removable draft previews › Paste multiple images and remove one
// @covers: chat-image-attachments › Clipboard images become removable draft previews › Image and text in one paste
// @covers: chat-image-attachments › Clipboard images become removable draft previews › Ordinary text paste
// @covers: chat-image-attachments › Clipboard images become removable draft previews › Browser withholds image bytes
test('P1-P5/H10: composer paste is local, ordered, removable, and preserves text-only paste', () => {
  const sent: string[] = []
  act(() => { renderer = TestRenderer.create(<ChatComposer sessionId="a" status="waiting" connected commandState={{ status: 'unavailable', commands: [] }} onSubmit={text => { sent.push(text) }} onInterrupt={() => {}} />) })
  const textarea = () => renderer!.root.findByType('textarea')
  let prevented = 0
  const paste = (clipboardData: unknown) => act(() => textarea().props.onPaste({ clipboardData, preventDefault: () => prevented++ }))
  paste({ items: [], files: [], getData: () => 'normal text' })
  expect(prevented).toBe(0)
  const first = file(), second = file()
  const clipboard = { items: [first, second].map(f => ({ kind: 'file', type: f.type, getAsFile: () => f })), files: [first, second] }
  paste(clipboard)
  expect(prevented).toBe(1)
  expect(pastedImages(clipboard as unknown as DataTransfer).files).toEqual([first, second])
  expect(useChatImageDrafts.getState().drafts.a.map(i => i.file)).toEqual([first, second])
  expect(renderer!.root.findAllByType('img')).toHaveLength(2)
  act(() => renderer!.root.findByProps({ 'aria-label': 'Remove image 1' }).props.onClick())
  expect(useChatImageDrafts.getState().drafts.a.map(i => i.file)).toEqual([second])
  expect(sent).toEqual([])
  paste({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }], files: [] })
  expect(useChatImageDrafts.getState().errors.a).toContain('did not provide image data')
  const before = useChatImageDrafts.getState().drafts.a
  paste({ items: [], files: [file(), file(), file(), file()] })
  expect(useChatImageDrafts.getState().drafts.a).toBe(before)
  paste({ items: [], files: [new File(['bad'], 'bad.svg', { type: 'image/svg+xml' })] })
  expect(useChatImageDrafts.getState().drafts.a).toBe(before)
})

// @covers: chat-image-attachments › Refused or uncertain sends preserve recoverable input › Reply is lost
// @covers: chat-image-attachments › Refused or uncertain sends preserve recoverable input › User has newer edits
// @covers: chat-image-attachments › Both agent runtimes accept images with optional text › Pending upload
test('L1/L2/L5/L6/L7/L9: a lost image-send answer never resends or clears newer edits', async () => {
  useChatImageDrafts.getState().add('a', [file()])
  const sent: ClientMessage[] = []
  const start = () => submitImageDraft({ sessionId: 'a', text: '', scope: null, send: m => sent.push(m), connected: () => true, fetch: upload as unknown as typeof fetch })
  const first = start(), duplicate = start()
  await Promise.all([first, duplicate])
  expect(sent).toHaveLength(1)
  const message = sent[0] as Extract<ClientMessage, { type: 'chat-send' }>
  expect(message.images).toEqual([{ id: reference.id }])
  markImageSendsUnconfirmed()
  expect(useChatImageDrafts.getState().attempts[message.requestId!].state).toBe('unconfirmed')
  useChatStore.getState().setDraft('a', 'newer text')
  consumeSendAnswer({ type: 'chat-send-result', sessionId: 'b', requestId: message.requestId!, accepted: true })
  expect(Object.keys(useChatImageDrafts.getState().attempts)).toHaveLength(1)
  consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: message.requestId!, accepted: true })
  expect(useChatStore.getState().drafts.a).toBe('newer text')
  expect(useChatImageDrafts.getState().drafts.a).toHaveLength(1)
  expect(Object.keys(useChatImageDrafts.getState().attempts)).toHaveLength(0)
  markImageSendsUnconfirmed()
  expect(sent).toHaveLength(1)
})

// @covers: chat-image-attachments › Refused or uncertain sends preserve recoverable input › Upload fails
// @covers: chat-image-attachments › Refused or uncertain sends preserve recoverable input › Send is refused
test('L3/L4: upload and admission failures keep image drafts recoverable', async () => {
  useChatImageDrafts.getState().add('a', [file()])
  const sent: ClientMessage[] = []
  await submitImageDraft({ sessionId: 'a', text: 'original', scope: null, send: m => sent.push(m), connected: () => true,
    fetch: (async () => Response.json({ error: 'too large' }, { status: 413 })) as unknown as typeof fetch })
  expect(sent).toHaveLength(0)
  const failed = Object.values(useChatImageDrafts.getState().attempts)[0]
  expect(failed.state).toBe('refused')
  expect(failed.error).toBe('too large')
  useChatStore.getState().setDraft('a', 'newer')
  restoreImageAttempt(failed.requestId)
  expect(useChatStore.getState().drafts.a).toBe('original')
  await submitImageDraft({ sessionId: 'a', text: 'original', scope: null, send: m => sent.push(m), connected: () => true, fetch: upload as unknown as typeof fetch })
  const pending = Object.values(useChatImageDrafts.getState().attempts)[0]
  consumeSendAnswer({ type: 'error', sessionId: 'a', requestId: pending.requestId, message: 'Chat archived' })
  expect(useChatImageDrafts.getState().attempts[pending.requestId].state).toBe('refused')
  expect(useChatStore.getState().drafts.a).toBe('original')
})

// @covers: chat-image-attachments › Image drafts belong to their chat session › Switch sessions during preparation
// @covers: chat-image-attachments › Image drafts belong to their chat session › Reload or kill
test('H1/H2/Q1: a killed session cannot be resurrected by a late upload', async () => {
  useChatImageDrafts.getState().add('a', [file()])
  useChatImageDrafts.getState().add('b', [file()])
  const b = useChatImageDrafts.getState().drafts.b
  let finish!: (response: Response) => void
  const delayed = new Promise<Response>(resolve => { finish = resolve })
  const sent: ClientMessage[] = []
  const pending = submitImageDraft({ sessionId: 'a', text: '', scope: null, send: m => sent.push(m), connected: () => true, fetch: (() => delayed) as unknown as typeof fetch })
  useChatStore.getState().remove('a')
  finish(await upload()); await pending
  expect(sent).toHaveLength(0)
  expect(useChatImageDrafts.getState().drafts.a).toBeUndefined()
  expect(useChatImageDrafts.getState().drafts.b).toBe(b)
})

// @covers: chat-image-attachments › Sent images remain part of conversation history › Image file is unavailable
// @covers: chat-image-attachments › Image attachments coexist with existing composer controls › Archived view
test('H3/H5/H6/H7: archived image-only rows use scoped HTTP assets and show read failures', () => {
  act(() => { renderer = TestRenderer.create(<ChatMessages sessionId="a" archived events={[{
    type: 'user_message', text: '', images: [{ ...reference, mediaType: 'image/png' }], id: 'u', sequence: 0, turnId: 't', at: '',
  }]} />) })
  const image = renderer!.root.findByType('img')
  expect(image.props.src).toBe(`/api/chat/a/images/${reference.id}`)
  expect(image.props.loading).toBe('lazy')
  act(() => image.props.onError())
  expect(renderer!.root.findByProps({ 'aria-label': 'Image 1 unavailable' }).children).toEqual(['Image unavailable'])
})

// @covers: chat-image-attachments › Image drafts belong to their chat session › Reconnect and restore
test('H1-H4: two hosts share previews and unmounting either does not dispose the session draft', () => {
  const revoked = spyOn(URL, 'revokeObjectURL')
  try {
    const composer = (key: string) => <ChatComposer key={key} sessionId="a" status="waiting" connected commandState={{ status: 'unavailable', commands: [] }} onSubmit={() => false} onInterrupt={() => {}} />
    act(() => { renderer = TestRenderer.create(<>{composer('left')}{composer('right')}</>) })
    act(() => useChatImageDrafts.getState().add('a', [file()]))
    expect(renderer!.root.findAllByType('img')).toHaveLength(2)
    const original = useChatImageDrafts.getState().drafts.a[0]
    act(() => renderer!.update(<>{composer('right')}</>))
    expect(renderer!.root.findAllByType('img')).toHaveLength(1)
    expect(useChatImageDrafts.getState().drafts.a[0]).toBe(original)
    expect(revoked).not.toHaveBeenCalled()
    act(() => useChatStore.getState().remove('a'))
    expect(revoked).toHaveBeenCalledWith(original.url)
  } finally { revoked.mockRestore() }
})

test('L5/H8: a replaced plan context is a newer draft even when text and images are unchanged', async () => {
  const scope: CapturedWorkspaceScope = { envelope: { teamId: 't', planId: 'p', version: { kind: 'revision', revision: 1, contentHash: 'a'.repeat(64) } }, planTitle: 'Plan', capturedAt: '2026-11-19T10:00:00Z' }
  useChatImageDrafts.getState().add('a', [file()])
  usePlanWorkspaceScopeStore.getState().setScope('a', scope)
  const sent: ClientMessage[] = []
  await submitImageDraft({ sessionId: 'a', text: '', scope, send: message => sent.push(message), connected: () => true, fetch: upload as unknown as typeof fetch })
  const next = { ...scope, envelope: { ...scope.envelope, planId: 'new-plan' } }
  usePlanWorkspaceScopeStore.getState().setScope('a', next)
  const message = sent[0] as Extract<ClientMessage, { type: 'chat-send' }>
  consumeSendAnswer({ type: 'chat-send-result', sessionId: 'a', requestId: message.requestId!, accepted: true })
  expect(usePlanWorkspaceScopeStore.getState().scopes.a).toBe(next)
  expect(useChatImageDrafts.getState().drafts.a).toHaveLength(1)
})

test('U7: clipboard filenames cannot change the uploaded image media type', async () => {
  useChatImageDrafts.getState().add('a', [new File(['webp bytes'], 'misleading.png', { type: 'image/webp' })])
  let filename = ''
  await submitImageDraft({ sessionId: 'a', text: '', scope: null, send: () => {}, connected: () => true,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      // Observe the actual multipart wire representation. Bun retains the
      // original File.name in FormData.get even when serialization uses
      // the explicit third-argument filename.
      const form = await new Response(init!.body as FormData).formData()
      filename = (form.get('image') as File).name
      return Response.json({ image: { ...reference, id: `${'a'.repeat(64)}.webp`, mediaType: 'image/webp' } })
    }) as unknown as typeof fetch,
  })
  expect(filename).toBe('paste.webp')
})

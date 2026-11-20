import { CHAT_IMAGE_RED_BASE64 } from '../../../tests/fixtures/chatImage'
import { expect, test } from 'bun:test'
import { createHarness, flush } from './fixtures/chatDriverHarness'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { Script, sentRequest, startHarness, until } from './codexDriverHarness'
import { imageDescriptor, type TrustedChatImage } from '../chat/images/ChatImageStore'
import { parseTranscriptContent } from '../chat/transcriptReplay'
import { parseCodexRollout } from '../chat/codex/codexRollout'
import type { WorkspaceMessageContext } from '../../shared/planWorkspace'

// Small generated red PNG used by the successful native CLI smoke. These
// fixtures reproduce the observed image blocks, excluding private context.
const bytes = Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64')
const image: TrustedChatImage = { ...imageDescriptor(bytes, 'image/png'), bytes, path: '/data/chat-images/session/red.png' }
const source = { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } as const

// @covers: chat-image-attachments › Both agent runtimes accept images with optional text › Claude receives text and images
// @covers: chat-image-attachments › Both agent runtimes accept images with optional text › Image-only Claude and mixed Codex messages
test('S5/Q2: Claude receives native ordered image occurrences with optional text', async () => {
  for (const text of ['', 'look']) {
    const h = createHarness()
    try {
      h.driver.send(text, [image, image])
      await h.nextWrite()
      const prompt = h.prompts.at(-1)!
      expect(prompt?.message.content).toEqual([
        ...(text ? [{ type: 'text' as const, text }] : []),
        { type: 'image', source }, { type: 'image', source },
      ])
      const event = h.events.find(e => e.type === 'user_message')!
      expect(event).toMatchObject({ text, images: [imageDescriptor(bytes, 'image/png'), imageDescriptor(bytes, 'image/png')] })
      expect(JSON.stringify(event)).not.toContain('base64')
      expect(JSON.stringify(event)).not.toContain('/data/')
    } finally { await h.cleanup() }
  }
})

// @covers: chat-image-attachments › Both agent runtimes accept images with optional text › Codex receives an image-only message
test('S6/Q2: Codex receives native localImage inputs with no fabricated text', async () => {
  const h = startHarness(new Script().boot().turn('ct-image'))
  try {
    h.driver.send('', [image, image])
    await until(() => !!sentRequest(h, 'turn/start'))
    expect(sentRequest(h, 'turn/start')?.input).toEqual([
      { type: 'localImage', path: image.path }, { type: 'localImage', path: image.path },
    ])
    expect(h.events.filter(e => e.type === 'user_message')).toHaveLength(1)
  } finally { await h.cleanup() }
})

// @covers: chat-image-attachments › Image attachments coexist with existing composer controls › Plan context with images
test('H8: Claude carries native images and the captured plan context together', async () => {
  const context: WorkspaceMessageContext = { teamId: 'team', planId: 'plan', planTitle: 'Plan',
    version: { kind: 'revision', revision: 1, contentHash: 'a'.repeat(64) }, executionId: null, changeName: null, documentRefId: null }
  const h = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
  try {
    expect(await h.driver.sendWorkspaceContext('', context, [image])).toEqual({ ok: true })
    await h.nextWrite()
      const prompt = h.prompts.at(-1)!
    expect(prompt?.message.content).toEqual([{ type: 'image', source }])
    expect(prompt?.pasted_content).toHaveLength(1)
    expect(h.events.find(e => e.type === 'user_message')).toMatchObject({ workspaceContext: context })
  } finally { await h.cleanup() }
})

test('S5: a UUID-preserving image echo cannot add generated path text to the conversation', async () => {
  const h = createHarness()
  try {
    h.driver.send('', [image])
    await h.nextWrite()
      const prompt = h.prompts.at(-1)!
    h.fakes[0].push({ type: 'user', uuid: prompt!.uuid, session_id: 'sdk', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'image', source }, { type: 'text', text: '[Image: source: /private/runtime/image.png]' }] },
    } as unknown as SDKMessage)
    await flush()
    expect(h.events.filter(e => e.type === 'user_message')).toHaveLength(1)
    expect(JSON.stringify(h.events)).not.toContain('/private/runtime/')
  } finally { await h.cleanup() }
})

// @covers: chat-image-attachments › Sent images remain part of conversation history › Reload and restart
// @covers: chat-image-attachments › Sent images remain part of conversation history › Interrupt retains sent images
test('H5/H11/Q5: native replay retains image-only and mixed messages once without wrappers or bytes', () => {
  for (const text of ['', 'look']) {
    const claude = JSON.stringify({ type: 'user', uuid: 'image-message', timestamp: '2026-11-19T10:00:00Z', message: { role: 'user', content: [
      ...(text ? [{ type: 'text', text }] : []), { type: 'image', source }, { type: 'image', source },
    ] } })
    const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-11-19T10:00:00Z', payload: {
      type: 'message', role: 'user', content: [
        ...(text ? [{ type: 'input_text', text }] : []),
        { type: 'input_text', text: '<image name=[Image #1] path="/private/image.png">' },
        { type: 'input_image', image_url: `data:image/png;base64,${source.data}`, detail: 'original' },
        { type: 'input_image', image_url: `data:image/png;base64,${source.data}`, detail: 'original' },
        { type: 'input_text', text: '</image>' },
      ],
    } })
    const events = [parseTranscriptContent(claude).events, parseCodexRollout(codex)]
    for (const all of events) {
      const users = all.filter(e => e.type === 'user_message')
      expect(users).toHaveLength(1)
      expect(users[0]).toMatchObject({ text, images: [imageDescriptor(bytes, 'image/png'), imageDescriptor(bytes, 'image/png')] })
      expect(JSON.stringify(users)).not.toContain('/private/')
      expect(JSON.stringify(users)).not.toContain('base64')
    }
  }
})

test('H5: a native Codex wrapper retains original asset identity after pixel normalization', () => {
  const id = `${'b'.repeat(64)}.png`
  const input = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: `<image name=[Image #1] path="/assets/${id}">` },
    { type: 'input_image', image_url: `data:image/png;base64,${source.data}` },
    { type: 'input_text', text: '</image>' },
  ] } })
  const user = parseCodexRollout(input).find(event => event.type === 'user_message')!
  expect(user.images?.map(image => image.id)).toEqual([id])
  expect(user.text).toBe('')
  expect(JSON.stringify(user)).not.toContain('/assets/')
})

// @covers: chat-image-attachments › Image attachments coexist with existing composer controls › Plan context with images
test('S5/H8: queued image-only sends retain their image occurrences and captured context', async () => {
  const h = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
  const context: WorkspaceMessageContext = { teamId: 'team', planId: 'plan', planTitle: 'Plan',
    version: { kind: 'revision', revision: 1, contentHash: 'a'.repeat(64) }, executionId: null, changeName: null, documentRefId: null }
  try {
    await h.driver.send('opening', [image])
    await h.nextWrite()
    const queued = h.driver.sendWorkspaceContext('', context, [image, image])
    await h.nextWrite()
    expect(await queued).toEqual({ ok: true })
    expect(h.prompts[1].message.content).toEqual([{ type: 'image', source }, { type: 'image', source }])
    expect(h.prompts[1].pasted_content).toHaveLength(1)
    const users = h.events.filter(event => event.type === 'user_message')
    expect(users).toHaveLength(2)
    expect(users[1]).toMatchObject({ text: '', messageUuid: h.prompts[1].uuid, workspaceContext: context,
      images: [imageDescriptor(bytes, 'image/png'), imageDescriptor(bytes, 'image/png')] })
    expect(users[1].turnId).toBe(users[0].turnId)
    expect(JSON.stringify(users)).not.toContain('base64')
  } finally { await h.cleanup() }
})

test('Q2: Claude snapshots native image bytes before asynchronous startup', async () => {
  const h = createHarness()
  try {
    const changed = { ...image }
    const supplied = [changed, image]
    const sent = h.driver.send('', supplied)
    changed.mediaType = 'image/jpeg'; changed.bytes = Buffer.from('changed'); supplied.pop()
    await h.nextWrite(); await sent
    expect(h.prompts[0].message.content).toEqual([{ type: 'image', source }, { type: 'image', source }])
    expect(h.events.find(e => e.type === 'user_message')?.images).toHaveLength(2)
  } finally { await h.cleanup() }
})

test('Q2: Codex snapshots native image paths before asynchronous startup', async () => {
  const h = startHarness(new Script().boot().turn('image-snapshot'))
  try {
    const changed = { ...image }
    const supplied = [changed, image]
    const sent = h.driver.send('', supplied)
    changed.path = '/changed/image.png'; supplied.pop()
    await sent
    expect(sentRequest(h, 'turn/start')?.input).toEqual([{ type: 'localImage', path: image.path }, { type: 'localImage', path: image.path }])
    expect(h.events.find(e => e.type === 'user_message')?.images).toHaveLength(2)
  } finally { await h.cleanup() }
})

// @covers: chat-image-attachments › Sent images remain part of conversation history › Reload and restart
test('H5: mixed native image and tool-result blocks replay both without duplicate IDs', () => {
  const result = { type: 'tool_result', tool_use_id: 'read-1', content: 'read complete' }
  const input = [{ type: 'text', text: 'compare this' }, { type: 'image', source }]
  for (const content of [[result, ...input], [...input, result]]) {
    const transcript = [
      { type: 'assistant', uuid: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }] } },
      { type: 'user', uuid: 'mixed', message: { role: 'user', content } },
    ].map(row => JSON.stringify(row)).join('\n')
    const replay = parseTranscriptContent(transcript)
    expect(replay.events.filter(event => event.type === 'tool_result')).toMatchObject([{ toolCallId: 'read-1', output: 'read complete' }])
    const users = replay.events.filter(event => event.type === 'user_message')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ text: 'compare this', images: [imageDescriptor(bytes, 'image/png')] })
    expect(new Set(replay.events.map(event => event.id)).size).toBe(replay.events.length)
    expect(replay.unmatchedToolCallIds).toEqual([])
  }
})

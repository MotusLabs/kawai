import { expect, test } from 'bun:test'
import { captureImages, codexImageInput } from '../src/images.js'
import { promptMessage } from '../src/claude/turns.js'

// Native payloads stay transport-only; Kawai supplies its own safe event descriptors.
test('Claude captures ordered repeated images before admission without fabricating text', () => {
  const image = { type: 'base64' as const, mediaType: 'image/png' as const, data: 'original' }
  const supplied = [image, image]
  const captured = captureImages('claude', supplied)
  image.data = 'edited'; supplied.pop()
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'original' } } as const
  expect(promptMessage('', 'u', null, captured).message.content).toEqual([block, block])
  expect(promptMessage('look', 'u', null, captured).message.content).toEqual([{ type: 'text', text: 'look' }, block, block])
  expect(promptMessage('legacy', 'u').message.content).toBe('legacy')
})

test('Codex captures native image paths and preserves optional text and duplicate occurrences', () => {
  const image = { type: 'localImage' as const, path: '/assets/original.png' }
  const captured = captureImages('codex', [image, image])
  image.path = '/assets/edited.png'
  expect(codexImageInput('', captured)).toEqual([{ type: 'localImage', path: '/assets/original.png' }, { type: 'localImage', path: '/assets/original.png' }])
  expect(codexImageInput('look', captured)[0]).toEqual({ type: 'text', text: 'look', text_elements: [] })
  expect(codexImageInput('', [])).toEqual([{ type: 'text', text: '', text_elements: [] }])
})

test('Native image transport refuses unsupported runtime shapes before submission', () => {
  expect(() => captureImages('claude', [{ type: 'localImage', path: '/image.png' }])).toThrow('unsupported native image')
  expect(() => captureImages('codex', [{ type: 'base64', mediaType: 'image/png', data: 'bytes' }])).toThrow('unsupported native image')
  expect(() => captureImages('claude', [{ type: 'base64', mediaType: 'image/png', data: '' }])).toThrow('unsupported native image')
  expect(captureImages('claude', undefined)).toEqual([])
})

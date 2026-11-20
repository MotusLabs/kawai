import { expect, test } from 'bun:test'
import { CHAT_IMAGE_MAX_BYTES, chatImageSendError, parseChatImages } from '../../shared/chatImages'

const image = { id: `${'a'.repeat(64)}.png` }

// @covers: chat-image-attachments › Both agent runtimes accept images with optional text › No message content
test('S0/S2/S3/S7: image wire bounds preserve optional old text frames', () => {
  expect(chatImageSendError('old client', undefined)).toBeNull()
  expect(chatImageSendError('', undefined)).toBeString()
  expect(chatImageSendError('', [image])).toBeString()
  expect(chatImageSendError('', [image], 'request')).toBeNull()
  expect(chatImageSendError(' ', [], 'request')).toBeString()
  expect(parseChatImages(Array(4).fill(image))).toHaveLength(4)
  expect(parseChatImages(Array(5).fill(image))).toBeNull()
  for (const id of ['/etc/hosts', '../image.png', 'https://example.com/x.png', 'a.png']) {
    expect(parseChatImages([{ id }])).toBeNull()
  }
  expect(parseChatImages([image, image])).toEqual([image, image])
  expect(CHAT_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
})

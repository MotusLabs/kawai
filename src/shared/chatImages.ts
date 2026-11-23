// Public chat image contract. Bytes and filesystem paths stay server-side;
// drafts upload only on Send and conversation events carry these small refs.
export const CHAT_IMAGE_MAX_COUNT = 4
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ChatImageMediaType = typeof CHAT_IMAGE_TYPES[number]
export interface ChatImageReference { id: string }
export interface ChatImage extends ChatImageReference {
  mediaType: ChatImageMediaType
  byteSize: number
  unavailable?: boolean
}

export function isChatImageId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(value)
}

/** Wire validation only: ownership and actual bytes are checked by the store. */
export function parseChatImages(value: unknown): ChatImageReference[] | null {
  if (!Array.isArray(value) || value.length > CHAT_IMAGE_MAX_COUNT) return null
  const images: ChatImageReference[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('id' in item) || !isChatImageId(item.id)) return null
    images.push({ id: item.id })
  }
  return images
}

export function chatImageSendError(text: unknown, images: unknown, requestId?: unknown): string | null {
  if (typeof text !== 'string') return 'Message text must be a string.'
  if (images !== undefined) {
    if (typeof requestId !== 'string' || !requestId.trim()) return 'Image messages need a request id.'
    const parsed = parseChatImages(images)
    if (!parsed) return 'Invalid image references (at most four images).'
    if (text.trim() || parsed.length) return null
  } else if (text.trim()) return null
  return 'Write a message or paste an image before sending.'
}

export function chatImageUrl(sessionId: string, imageId: string): string {
  return `/api/chat/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`
}

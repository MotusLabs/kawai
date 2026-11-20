// Project native transcript image blocks into small safe browser references.
// This never fetches a URL or reads a native path. Assets are served only
// through the addressed session's image route, which verifies ownership.
import { CHAT_IMAGE_MAX_BYTES, isChatImageId, type ChatImage } from '../../../shared/chatImages'
import { imageDescriptor, imageMediaType } from './ChatImageStore'

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

export function nativeImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return []
  const images: ChatImage[] = []
  let original: Pick<ChatImage, 'id' | 'mediaType'> | null = null
  for (const value of content) {
    const block = record(value)
    if (block?.type === 'input_text' && typeof block.text === 'string') {
      const wrapper = /^<image name=\[Image #\d+\] path="([^\n]*)">$/.exec(block.text)
      const id = wrapper?.[1].split('/').pop()
      if (isChatImageId(id)) original = { id, mediaType: mediaTypeForId(id) }
      if (block.text === '</image>') original = null
    }
    if (!block || !['image', 'input_image', 'localImage'].includes(String(block.type))) continue
    // Native wrappers identify the original asset even when the model's
    // inline pixels were resized or re-encoded. No decoding is needed.
    if (original) { images.push({ ...original, byteSize: 0 }); continue }
    const source = record(block.source)
    const url = block.image_url ?? block.url
    const data = source?.type === 'base64' ? source.data
      : typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(url) ? url.slice(url.indexOf(',') + 1) : null
    if (typeof data === 'string' && data.length <= Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4) {
      const bytes = Buffer.from(data, 'base64')
      const mediaType = imageMediaType(bytes)
      if (mediaType && bytes.length <= CHAT_IMAGE_MAX_BYTES) {
        images.push(imageDescriptor(bytes, mediaType))
        continue
      }
    }
    // Legacy/local native shapes may retain only the path. Use its safe
    // basename as a reference, never as a path to read.
    const name = typeof block.path === 'string' ? block.path.split('/').pop() : null
    if (isChatImageId(name)) {
      const mediaType = mediaTypeForId(name)
      images.push({ id: name, mediaType, byteSize: 0 })
    } else images.push({ id: `${'0'.repeat(64)}.png`, mediaType: 'image/png', byteSize: 0, unavailable: true })
  }
  return images
}

function mediaTypeForId(name: string): ChatImage['mediaType'] {
  return name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.gif') ? 'image/gif' : name.endsWith('.webp') ? 'image/webp' : 'image/png'
}

/** Only image-bearing native messages contain these generated wrappers. */
export const isNativeImageWrapper = (text: string): boolean =>
  /^<image name=\[Image #\d+\] path="[^\n]*">$/.test(text) || text === '</image>'

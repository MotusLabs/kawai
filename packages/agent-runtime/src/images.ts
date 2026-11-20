// Native image inputs are copied before asynchronous admission. They are
// transport-only: public runtime events never contain image bytes or paths.
import type { AgentRuntimeKind, ImageInput } from './contract.js'
import { AgentRuntimeError } from './errors.js'
export function captureImages(runtime: AgentRuntimeKind, values: readonly ImageInput[] | undefined): readonly ImageInput[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new AgentRuntimeError({ category: 'unsupported', message: 'images must be an array' })
  return Object.freeze(values.map(image => {
    if (runtime === 'claude' && image?.type === 'base64' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType) && typeof image.data === 'string' && image.data.length) return Object.freeze({ ...image })
    if (runtime === 'codex' && image?.type === 'localImage' && typeof image.path === 'string' && image.path.length) return Object.freeze({ ...image })
    throw new AgentRuntimeError({ category: 'unsupported', message: 'unsupported native image input for this runtime' })
  }))
}
export function codexImageInput(text: string, images: readonly ImageInput[]): unknown[] {
  return [...(text || !images.length ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => { if (image.type !== 'localImage') throw Error('Expected a Codex image'); return { type: 'localImage', path: image.path } })]
}

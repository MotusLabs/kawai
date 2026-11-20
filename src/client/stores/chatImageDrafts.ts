// Client-only image drafts and captured submission snapshots. The connection
// recovery owner settles attempts even when no composer is mounted.
import { create } from 'zustand'
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_COUNT, CHAT_IMAGE_TYPES, type ChatImage } from '@shared/chatImages'
import type { CapturedWorkspaceScope } from './planWorkspaceScopeStore'

export interface DraftImage { clientId: string; file: File; url: string; uploaded?: ChatImage }
export interface ImageSendAttempt {
  requestId: string; sessionId: string; revision: number; text: string
  images: DraftImage[]; scope: CapturedWorkspaceScope | null
  state: 'uploading' | 'awaiting-result' | 'unconfirmed' | 'refused'
  error?: string
}
interface ImageDraftState {
  drafts: Record<string, DraftImage[]>
  revisions: Record<string, number>
  attempts: Record<string, ImageSendAttempt>
  errors: Record<string, string | undefined>
  touch(id: string): void
  add(id: string, files: File[]): void
  replace(id: string, images: DraftImage[]): void
  removeImage(id: string, clientId: string): void
  removeSession(id: string): void
  error(id: string, message?: string): void
  attempt(value: ImageSendAttempt): void
  forget(requestId: string): void
}
export const EMPTY_DRAFT_IMAGES: DraftImage[] = []

// Reference sharing between the editable draft and pending/recoverable
// snapshots is intentional. Revoke only after the last owner releases it.
const urls = new Set<string>()
function releaseUnused() {
  const state = useChatImageDrafts.getState()
  const used = new Set([
    ...Object.values(state.drafts).flat(), ...Object.values(state.attempts).flatMap(p => p.images),
  ].map(image => image.url))
  for (const url of urls) if (!used.has(url)) { URL.revokeObjectURL(url); urls.delete(url) }
}

export const useChatImageDrafts = create<ImageDraftState>((set, get) => ({
  drafts: {}, revisions: {}, attempts: {}, errors: {},
  touch: id => set(state => ({ revisions: { ...state.revisions, [id]: (state.revisions[id] ?? 0) + 1 } })),
  error: (id, message) => set(state => ({ errors: { ...state.errors, [id]: message } })),
  add: (id, files) => {
    const current = get().drafts[id] ?? EMPTY_DRAFT_IMAGES
    if (!files.length) return
    if (current.length + files.length > CHAT_IMAGE_MAX_COUNT) { get().error(id, 'Attach at most four images.'); return }
    if (files.some(file => file.size === 0 || file.size > CHAT_IMAGE_MAX_BYTES)) { get().error(id, 'Each image must contain between 1 byte and 5 MiB.'); return }
    if (files.some(file => !CHAT_IMAGE_TYPES.includes(file.type as typeof CHAT_IMAGE_TYPES[number]))) {
      get().error(id, 'Paste a PNG, JPEG, GIF, or WebP image.'); return
    }
    const added = files.map(file => {
      const url = URL.createObjectURL(file); urls.add(url)
      return { clientId: crypto.randomUUID(), file, url }
    })
    get().replace(id, [...current, ...added]); get().error(id)
  },
  replace: (id, images) => {
    set(state => ({ drafts: { ...state.drafts, [id]: images }, revisions: { ...state.revisions, [id]: (state.revisions[id] ?? 0) + 1 } }))
    releaseUnused()
  },
  removeImage: (id, clientId) => get().replace(id, (get().drafts[id] ?? []).filter(image => image.clientId !== clientId)),
  removeSession: id => {
    set(state => {
      const drafts = { ...state.drafts }, revisions = { ...state.revisions }, errors = { ...state.errors }
      delete drafts[id]; delete revisions[id]; delete errors[id]
      const attempts = Object.fromEntries(Object.entries(state.attempts).filter(([, value]) => value.sessionId !== id))
      return { drafts, revisions, errors, attempts }
    })
    releaseUnused()
  },
  attempt: value => set(state => ({ attempts: { ...state.attempts, [value.requestId]: value } })),
  forget: requestId => {
    set(state => { const attempts = { ...state.attempts }; delete attempts[requestId]; return { attempts } })
    releaseUnused()
  },
}))

/** Native clipboard items are authoritative; files are a fallback, not a
 * second collection to append (browsers expose the same image both ways). */
export function pastedImages(data: DataTransfer): { files: File[]; hasImages: boolean } {
  const items = Array.from(data.items ?? [])
  const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'))
  const files = imageItems.map(item => item.getAsFile()).filter((file): file is File => file !== null)
  const fallback = Array.from(data.files ?? []).filter(file => file.type.startsWith('image/'))
  return { files: fallback.length > files.length ? fallback : files, hasImages: imageItems.length > 0 || fallback.length > 0 }
}

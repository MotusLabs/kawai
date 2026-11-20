// Image submission uses the same connection-level terminal answer owner as
// plan-context sends. A disconnected request is unconfirmed, never replayed.
import type { SendClientMessage, ServerMessage } from '@shared/types'
import { isChatImageId, type ChatImage } from '@shared/chatImages'
import { useChatStore } from './chatStore'
import { useChatImageDrafts, type ImageSendAttempt } from './chatImageDrafts'
import { usePlanWorkspaceScopeStore, type CapturedWorkspaceScope } from './planWorkspaceScopeStore'

export async function submitImageDraft(input: {
  sessionId: string; text: string; scope: CapturedWorkspaceScope | null
  send: SendClientMessage; connected: () => boolean; fetch?: typeof fetch
}): Promise<void> {
  const state = useChatImageDrafts.getState()
  const images = state.drafts[input.sessionId] ?? []
  const revision = state.revisions[input.sessionId] ?? 0
  if (!images.length || Object.values(state.attempts).some(p => p.sessionId === input.sessionId && p.revision === revision && ['uploading', 'awaiting-result'].includes(p.state))) return
  const attempt: ImageSendAttempt = {
    requestId: crypto.randomUUID(), sessionId: input.sessionId, revision,
    text: input.text, images: [...images], scope: input.scope, state: 'uploading',
  }
  state.attempt(attempt); state.error(input.sessionId)
  const alive = () => useChatImageDrafts.getState().attempts[attempt.requestId]?.state === 'uploading'
  try {
    const references: ChatImage[] = []
    for (const image of attempt.images) {
      if (!alive()) return
      if (!image.uploaded) {
        // Bun's multipart parser derives File.type from the part filename.
        // Clipboard filenames can be missing or misleading, so use the
        // already-validated media type rather than the clipboard name.
        const extension = image.file.type === 'image/jpeg' ? 'jpg' : image.file.type.slice('image/'.length)
        const form = new FormData(); form.append('image', image.file, `paste.${extension}`)
        const response = await (input.fetch ?? fetch)(`/api/chat/${encodeURIComponent(input.sessionId)}/images`, { method: 'POST', body: form })
        const result = await response.json() as { image?: ChatImage; error?: string }
        if (!response.ok || !isChatImageId(result.image?.id)) throw Error(result.error ?? 'Image upload failed.')
        if (!alive()) return
        image.uploaded = result.image
      }
      references.push(image.uploaded)
    }
    if (!alive()) return
    if (!input.connected()) throw Error('Connection lost before sending. Your draft was kept.')
    useChatImageDrafts.getState().attempt({ ...attempt, state: 'awaiting-result' })
    input.send({ type: 'chat-send', sessionId: input.sessionId, text: attempt.text,
      images: references.map(({ id }) => ({ id })), requestId: attempt.requestId,
      ...(attempt.scope ? { workspaceContext: attempt.scope.envelope } : {}),
    })
  } catch (error) {
    const current = useChatImageDrafts.getState().attempts[attempt.requestId]
    // A synchronous send may throw after writing. Once send was invoked,
    // delivery is unconfirmed rather than a proven refusal.
    if (current) useChatImageDrafts.getState().attempt({ ...current,
      state: current.state === 'awaiting-result' ? 'unconfirmed' : 'refused',
      error: error instanceof Error ? error.message : 'Image submission failed.',
    })
  }
}

export function consumeImageSendAnswer(message: ServerMessage): boolean {
  if ((message.type !== 'chat-send-result' && message.type !== 'error') || !message.requestId) return false
  const state = useChatImageDrafts.getState()
  const pending = state.attempts[message.requestId]
  if (!pending || pending.sessionId !== message.sessionId || pending.state === 'refused') return false
  if (message.type === 'error') {
    state.attempt({ ...pending, state: 'refused', error: message.message })
  } else {
    if ((state.revisions[pending.sessionId] ?? 0) === pending.revision) {
      state.replace(pending.sessionId, [])
      useChatStore.getState().setDraft(pending.sessionId, '')
      usePlanWorkspaceScopeStore.getState().setScope(pending.sessionId, null)
    }
    state.forget(pending.requestId)
  }
  return true
}

export function markImageSendsUnconfirmed(): void {
  const state = useChatImageDrafts.getState()
  for (const pending of Object.values(state.attempts)) {
    if (pending.state === 'awaiting-result') state.attempt({ ...pending, state: 'unconfirmed' })
    else if (pending.state === 'uploading') state.attempt({ ...pending, state: 'refused', error: 'Connection lost before sending. Your draft was kept.' })
  }
}

/** Explicit recovery is allowed to replace the editable draft; merely
 * receiving a late result never does so. No recovery path sends anything. */
export function restoreImageAttempt(requestId: string): void {
  const state = useChatImageDrafts.getState(), pending = state.attempts[requestId]
  if (!pending || !['refused', 'unconfirmed'].includes(pending.state)) return
  state.replace(pending.sessionId, pending.images)
  useChatStore.getState().setDraft(pending.sessionId, pending.text)
  usePlanWorkspaceScopeStore.getState().setScope(pending.sessionId, pending.scope)
  // Keep unconfirmed entries so a late acceptance can still settle them.
  if (pending.state === 'refused') state.forget(requestId)
}

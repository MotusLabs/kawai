// Draft previews and explicit recovery controls are shared by all hosts.
import { EMPTY_DRAFT_IMAGES, useChatImageDrafts } from '../../stores/chatImageDrafts'
import { restoreImageAttempt } from '../../stores/chatImageSends'

export default function ChatDraftImages({ sessionId }: { sessionId: string }) {
  const images = useChatImageDrafts(state => state.drafts[sessionId] ?? EMPTY_DRAFT_IMAGES)
  const attempts = useChatImageDrafts(state => state.attempts)
  const error = useChatImageDrafts(state => state.errors[sessionId])
  return <>
    {images.length > 0 && <div aria-label="Attached images" className="mb-2 flex flex-wrap gap-2">
      {images.map((image, index) => <div key={image.clientId} className="relative">
        <img src={image.url} alt={`Attached image ${index + 1}`} className="h-24 w-24 rounded border border-border object-contain" />
        <button type="button" className="btn text-xs" aria-label={`Remove image ${index + 1}`}
          onClick={() => useChatImageDrafts.getState().removeImage(sessionId, image.clientId)}>Remove</button>
      </div>)}
    </div>}
    {error && <p role="alert" className="text-chat-meta text-chat-danger">{error}</p>}
    {Object.values(attempts).filter(attempt => attempt.sessionId === sessionId).map(attempt =>
      <div key={attempt.requestId} role="status" className="mb-2 text-chat-meta">
        {attempt.state === 'uploading' ? 'Uploading images…' : attempt.state === 'awaiting-result' ? 'Sending images…'
          : attempt.state === 'unconfirmed' ? 'Send unconfirmed. Check the conversation before retrying.' : attempt.error ?? 'The image message was refused.'}
        {['unconfirmed', 'refused'].includes(attempt.state) && <>
          <button type="button" className="btn ml-2 text-xs" onClick={() => restoreImageAttempt(attempt.requestId)}>Use this draft</button>
          <button type="button" className="btn ml-2 text-xs" onClick={() => useChatImageDrafts.getState().forget(attempt.requestId)}>Dismiss</button>
        </>}
      </div>)}
  </>
}

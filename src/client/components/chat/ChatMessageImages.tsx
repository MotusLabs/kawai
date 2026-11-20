import { useState } from 'react'
import { chatImageUrl, type ChatImage } from '@shared/chatImages'

function MessageImage({ sessionId, image, index }: { sessionId: string; image: ChatImage; index: number }) {
  const [failed, setFailed] = useState(false)
  if (failed || image.unavailable) return <span role="img" aria-label={`Image ${index + 1} unavailable`} className="text-chat-meta text-secondary">Image unavailable</span>
  return <img src={chatImageUrl(sessionId, image.id)} alt={`Attached image ${index + 1}`} loading="lazy"
    className="max-h-72 max-w-full rounded border border-border object-contain" onError={() => setFailed(true)} />
}

export default function ChatMessageImages({ sessionId, images }: { sessionId: string; images: ChatImage[] }) {
  return <div className="mt-2 flex flex-wrap gap-2">{images.map((image, index) =>
    <MessageImage key={`${image.id}:${index}`} sessionId={sessionId} image={image} index={index} />)}</div>
}

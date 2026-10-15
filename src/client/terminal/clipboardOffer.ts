// Pending clipboard-offer card state: clipboard writes we could not perform
// (OSC 52 failure, iOS clipboard offers) surface a manual-copy card. Offer
// ids increment per offer so a stale card can't be mistaken for a new one.
import { useCallback, useRef, useState } from 'react'
import type { ClipboardOfferSource } from '@shared/types'
import { copyText } from '../utils/copyText'
import { clientLog } from '../utils/clientLog'

export interface PendingClipboardOffer {
  id: number
  text: string
  source: ClipboardOfferSource
}

export function usePendingClipboardOffer() {
  const offerIdRef = useRef(0)
  const [pending, setPending] = useState<PendingClipboardOffer | null>(null)

  /** Queue a manual-copy card; empty offers are ignored. */
  const offer = useCallback((text: string, source: ClipboardOfferSource) => {
    if (!text?.trim()) return
    offerIdRef.current += 1
    setPending({
      id: offerIdRef.current,
      text,
      source,
    })
  }, [])

  const copy = useCallback(() => {
    if (!pending) return
    copyText(pending.text)
    clientLog('clipboard_manual_copy', {
      source: pending.source,
      chars: pending.text.length,
    }, 'info')
    setPending(null)
  }, [pending])

  const dismiss = useCallback(() => {
    setPending(null)
  }, [])

  return { pending, offer, copy, dismiss }
}

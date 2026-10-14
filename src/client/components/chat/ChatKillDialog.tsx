// Kill confirmation for the chat header (chat-header-layout D5): names the
// session and says the removal is permanent, unlike Archive. Cancel takes the
// initial focus because a chat kill cannot be undone; Escape and Cancel close
// without killing. Base UI's AlertDialog traps focus while open. The body is
// its own component so its buttons are testable without a DOM.
import { useRef, type RefObject } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'

export function KillConfirmBody({ name, onCancel, onConfirm, cancelRef }: {
  name: string
  onCancel: () => void
  onConfirm: () => void
  cancelRef?: RefObject<HTMLButtonElement>
}) {
  return (
    <>
      <p className="mb-4 text-chat-body text-secondary text-pretty">
        Kill “{name}”? This permanently removes the chat session from kawai. Archive keeps it instead.
      </p>
      <div className="flex justify-end gap-2">
        <button ref={cancelRef} type="button" className="btn text-chat-meta" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger text-chat-meta" data-testid="chat-kill-confirm" onClick={onConfirm}>Kill</button>
      </div>
    </>
  )
}

export default function ChatKillDialog({ open, name, container, onOpenChange, onConfirm }: {
  open: boolean
  name: string
  container: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog.Root open={open} onOpenChange={next => onOpenChange(next)}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Popup initialFocus={cancelRef} data-testid="chat-kill-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-elevated p-4 shadow-xl">
          <AlertDialog.Title className="mb-2 text-chat-body font-medium text-primary">Kill session</AlertDialog.Title>
          <KillConfirmBody name={name} cancelRef={cancelRef}
            onCancel={() => onOpenChange(false)} onConfirm={() => { onOpenChange(false); onConfirm() }} />
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

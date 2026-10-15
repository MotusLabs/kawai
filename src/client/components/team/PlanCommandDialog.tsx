// An inline confirmation for one human plan command (durable-plans D7/D12):
// opening it mints the dialog's command id in the plan store (`arm`), every
// send from it reuses that id while the payload is unchanged — so a resend
// after a lost result replays on the server — and the store re-mints when
// the payload changes. The dialog closes itself once the store retires its
// slot (the command succeeded); a refusal keeps it open with the entered
// reason. Optional reason field; every control disables while disconnected.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import { useTeamPlanStore, type PlanAction } from '../../stores/teamPlanStore'

/** Send a plan command from a dialog slot: the slot's command id, a fresh request id, and the pending entry. */
export function sendPlanCommand(teamPath: string, sendMessage: SendClientMessage, action: PlanAction, slot: string,
  payload: Record<string, unknown>, build: (ids: { requestId: string; commandId: string }) => ClientMessage) {
  const store = useTeamPlanStore.getState()
  const requestId = crypto.randomUUID()
  const commandId = store.command(teamPath, slot, JSON.stringify(payload), requestId)
  store.begin(teamPath, requestId, action)
  sendMessage(build({ requestId, commandId }))
}

export default function PlanCommandDialog({ teamPath, slot, openLabel, confirmLabel, testId, connected, busy, disabled = false, reason, primary = false, children, onOpen, onConfirm }: {
  teamPath: string
  slot: string
  openLabel: string
  confirmLabel: string
  testId: string
  connected: boolean
  busy: boolean
  disabled?: boolean
  /** A reason field; `required` blocks confirming while it is empty. */
  reason?: { label: string; required: boolean }
  primary?: boolean
  children?: ReactNode
  /** Runs when the dialog opens: the place to capture the state the human is shown. */
  onOpen?: () => void
  onConfirm: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [text, setText] = useState('')
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  const firstField = useRef<HTMLTextAreaElement | HTMLButtonElement | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (open && sent && !armed) {
      setOpen(false)
      setSent(false)
      setText('')
    }
  }, [open, sent, armed])
  useEffect(() => { if (open) firstField.current?.focus() }, [open])
  // Closing returns focus to the button that opened the dialog.
  const [returnFocus, setReturnFocus] = useState(false)
  useEffect(() => {
    if (!open && returnFocus) {
      opener.current?.focus()
      setReturnFocus(false)
    }
  }, [open, returnFocus])
  const dismiss = () => { setOpen(false); setReturnFocus(true) }

  if (!open) {
    return <button ref={opener} type="button" className={`btn text-chat-meta ${primary ? 'btn-primary' : ''}`} data-testid={testId}
      disabled={!connected || busy || disabled} onClick={() => {
        useTeamPlanStore.getState().arm(teamPath, slot)
        onOpen?.()
        setOpen(true)
      }}>{openLabel}</button>
  }
  const blocked = !connected || busy || disabled || (reason?.required === true && !text.trim())
  return <div role="group" aria-label={openLabel} className="mt-2 w-full border border-border p-2" data-testid={`${testId}-dialog`}
    onKeyDown={event => { if (event.key === 'Escape') dismiss() }}>
    {children}
    {reason && <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>{reason.label}{reason.required ? ' (required)' : ' (optional)'}</span>
      <textarea ref={node => { firstField.current = node }} className="input min-h-12 text-chat-body" value={text} disabled={!connected}
        onChange={event => setText(event.target.value)} />
    </label>}
    <div className="mt-2 flex gap-2">
      <button ref={node => { if (!reason) firstField.current = node }} type="button" className={`btn text-chat-meta ${primary ? 'btn-primary' : ''}`}
        data-testid={`${testId}-confirm`} disabled={blocked} onClick={() => {
          setSent(true)
          onConfirm(text.trim())
        }}>{confirmLabel}</button>
      <button type="button" className="btn text-chat-meta" onClick={dismiss}>Cancel</button>
    </div>
  </div>
}

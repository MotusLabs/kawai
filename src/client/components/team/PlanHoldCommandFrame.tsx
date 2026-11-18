// The frame every revision-control dialog shares (revision-control D14):
// opening it arms its store slot, so a resend after a lost result replays
// under the same command id and a changed payload re-mints (the store's
// `command`); it closes itself once the store retires the slot (success). A
// refusal keeps it open with the refusal and every failing check inline, and
// turns Confirm off until the dialog is closed and reopened, which arms a
// new command against the current state. Every control disables while
// disconnected; the fields the caller renders read `connected` themselves.
import { useEffect, useState, type ReactNode } from 'react'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

// A stable empty list: a selector returning a fresh `[]` re-renders forever.
const NO_FAILURES: Array<{ name: string; message: string }> = []

/** Today plus `days`, as a `datetime-local` value in the browser's zone. */
export function localDeadline(days: number, from: Date = new Date()): string {
  const at = new Date(from.getTime() + days * 24 * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** A `datetime-local` value as an ISO instant, or null when it does not parse. */
export function deadlineIso(value: string): string | null {
  if (value.trim() === '') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

export default function PlanHoldCommandFrame({ teamPath, slot, openLabel, title, confirmLabel, testId, connected, busy, ready, onOpen, onConfirm, children }: {
  teamPath: string
  slot: string
  openLabel: string
  title: string
  confirmLabel: string
  testId: string
  connected: boolean
  busy: boolean
  /** The fields hold a sendable command. */
  ready: boolean
  /** Runs when the dialog opens: reset the fields. */
  onOpen?: () => void
  onConfirm: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  const error = useTeamPlanStore(state => state.views[teamPath]?.error ?? null)
  const failures = useTeamPlanStore(state => state.views[teamPath]?.failures) ?? NO_FAILURES
  useEffect(() => {
    if (open && sent && !armed) { setOpen(false); setSent(false) }
  }, [open, sent, armed])
  const dismiss = () => { setOpen(false); setSent(false) }
  if (!open) {
    return <button type="button" className="btn text-chat-meta" data-testid={testId} disabled={!connected || busy}
      onClick={() => { useTeamPlanStore.getState().arm(teamPath, slot); onOpen?.(); setOpen(true) }}>{openLabel}</button>
  }
  const refused = armed?.refused === true
  return <div role="group" aria-label={title} className="mt-2 w-full border border-border p-2" data-testid={`${testId}-dialog`}
    onKeyDown={event => { if (event.key === 'Escape') dismiss() }}>
    <p className="text-chat-meta font-medium">{title}</p>
    {children}
    {refused && <div role="alert" className="mt-1 text-chat-meta text-chat-danger" data-testid={`${testId}-refused`}>
      <p>Refused{error ? `: ${error}` : ''}. Close and reopen this dialog to try again against the current state.</p>
      {failures.length > 0 && <ul className="list-disc pl-5">
        {failures.map((failure, index) => <li key={`${failure.name}-${index}`}><code>{failure.name}</code>: {failure.message}</li>)}
      </ul>}
    </div>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn text-chat-meta" data-testid={`${testId}-confirm`}
        disabled={!connected || busy || refused || !ready} onClick={() => { setSent(true); onConfirm() }}>{confirmLabel}</button>
      <button type="button" className="btn text-chat-meta" onClick={dismiss}>Cancel</button>
    </div>
  </div>
}

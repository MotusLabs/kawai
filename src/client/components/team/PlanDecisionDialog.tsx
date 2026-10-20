// The Answer and Override dialogs for one decision card (plan-supervision
// D15). Opening either arms its store slot (`decide:<plan>:<card>` /
// `override:<plan>:<card>`), so a resend after a lost result replays under
// the same command id and a payload change re-mints. Override shows the
// decision it replaces (its `expectedDecisionId`) and requires a rationale;
// Answer takes a choice — one of the card's options, or new text — with an
// optional rationale. The dialog closes itself once the command succeeds
// (the store retires the slot); a refusal keeps it open but turns Confirm
// off, since the same command would be refused again, until the human
// closes and reopens it. Every control disables while disconnected.
import { useEffect, useState } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { DecisionCard, PlanDecision } from '@shared/planDecisions'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { sendPlanCommand } from './PlanCommandDialog'
import { decisionPartyLabel } from './planLabels'

export default function PlanDecisionDialog({ teamPath, planId, card, mode, current, sessions, connected, busy, onSend }: {
  teamPath: string
  planId: string
  card: DecisionCard
  mode: 'answer' | 'override'
  /** Override only: the decision being replaced — sent as `expectedDecisionId`. */
  current: PlanDecision | null
  sessions: Session[]
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
}) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [choiceIndex, setChoiceIndex] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [rationale, setRationale] = useState('')
  const slot = `${mode === 'answer' ? 'decide' : 'override'}:${planId}:${card.id}`
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  const error = useTeamPlanStore(state => state.views[teamPath]?.error)
  useEffect(() => {
    if (open && sent && !armed) {
      setOpen(false); setSent(false); setChoiceIndex(null); setCustom(''); setRationale('')
    }
  }, [open, sent, armed])
  const dismiss = () => { setOpen(false); setSent(false) }
  if (!open) {
    return <button type="button" className="btn text-chat-meta" data-testid={`plan-decision-${mode}`}
      disabled={!connected || busy}
      onClick={() => { useTeamPlanStore.getState().arm(teamPath, slot); setOpen(true) }}>
      {mode === 'answer' ? 'Answer…' : 'Override…'}
    </button>
  }
  const refused = armed?.refused === true
  // The server resolves exactly one of choice and optionIndex (decisionInputs
  // resolveChoice refuses both), so an option pick sends the 1-based index
  // with a null choice and written text the reverse.
  const choice: { choice: string | null; optionIndex: number | null } | null = custom.trim()
    ? { choice: custom.trim(), optionIndex: null }
    : choiceIndex !== null ? { choice: null, optionIndex: choiceIndex + 1 } : null
  const rationaleTrimmed = rationale.trim()
  const blocked = !connected || busy || refused || choice === null
    || (mode === 'override' && (rationaleTrimmed === '' || current === null))
  const openLabel = mode === 'answer' ? 'Answer the question' : `Override ${decisionPartyLabel(current!.decidedBy, sessions)}'s decision`
  const confirm = () => {
    setSent(true)
    // The payload names exactly the fields the server compares on replay.
    const payload = mode === 'answer'
      ? { cardId: card.id, choice: choice!.choice, optionIndex: choice!.optionIndex, rationale: rationaleTrimmed || null }
      : { cardId: card.id, expectedDecisionId: current!.id, choice: choice!.choice, optionIndex: choice!.optionIndex, rationale: rationaleTrimmed }
    sendPlanCommand(teamPath, onSend, mode === 'answer' ? 'decide' : 'override', slot, payload, ({ requestId, commandId }) =>
      mode === 'answer'
        ? { type: 'team-plan-decide', teamPath, requestId, planId, cardId: card.id, choice: choice!.choice, optionIndex: choice!.optionIndex, rationale: rationaleTrimmed || null, commandId }
        : { type: 'team-plan-override', teamPath, requestId, planId, cardId: card.id, expectedDecisionId: current!.id, choice: choice!.choice, optionIndex: choice!.optionIndex, rationale: rationaleTrimmed, commandId })
  }
  return <div role="group" aria-label={openLabel} className="mt-2 w-full border border-border p-2" data-testid={`plan-decision-${mode}-dialog`}
    onKeyDown={event => { if (event.key === 'Escape') dismiss() }}>
    <p className="text-chat-meta font-medium">{openLabel}</p>
    <fieldset className="mt-1 text-chat-meta">
      <legend>Choice</legend>
      {card.options.map((option, index) => <label key={index} className="block">
        <input type="radio" name={`${slot}-choice`} aria-label={`Option ${index + 1}: ${option}`} checked={choiceIndex === index && custom.trim() === ''}
          disabled={!connected} onChange={() => setChoiceIndex(index)} /> {index + 1}. {option}
      </label>)}
      <label className="mt-1 block">
        Or write another choice:{' '}
        <input type="text" aria-label="Another choice" className="input text-chat-body" value={custom} disabled={!connected}
          onChange={event => setCustom(event.target.value)} />
      </label>
    </fieldset>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Rationale {mode === 'override' ? '(required)' : '(optional)'}</span>
      <textarea aria-label={`${mode} rationale`} className="input min-h-12 text-chat-body" value={rationale} disabled={!connected}
        onChange={event => setRationale(event.target.value)} />
    </label>
    {refused && <p className="mt-1 text-chat-meta text-secondary" data-testid={`plan-decision-${mode}-refused`}>
      Refused{error ? `: ${error}` : ''}. Close and reopen this dialog to try again against the current state.
    </p>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn text-chat-meta" data-testid={`plan-decision-${mode}-confirm`}
        disabled={blocked} onClick={confirm}>{mode === 'answer' ? 'Answer' : 'Override'}</button>
      <button type="button" className="btn text-chat-meta" onClick={dismiss}>Cancel</button>
    </div>
  </div>
}

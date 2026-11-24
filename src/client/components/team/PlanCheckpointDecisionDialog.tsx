// The checkpoint decision dialog for one undecided pause target
// (revision-control D8, D9, D14): the checkpoint package, then the choices
// the target's state allows — Continue, Adapt (with the task's new
// direction), and Restart for a Paused target; Restart alone for a Pausing
// one, whatever its causes (`holder-killed` and `checkpoint-push-failed`
// included) — an optional rationale, whether to release the hold with the
// decision, and a link to the execution's Stop. Paused is read only from a
// recorded `paused_at` (D8): a target without one is Pausing here.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { CheckpointView, PauseTargetView } from '@shared/planRevisionControl'
import { sendPlanCommand } from './PlanCommandDialog'
import PlanHoldCommandFrame from './PlanHoldCommandFrame'

type Choice = 'continue' | 'adapt' | 'restart'

/** Whether the target reads Paused: the server's state and its recorded `paused_at` (D8, UI4). */
export const isPaused = (target: PauseTargetView): boolean => target.state.state === 'paused' && target.pausedAt !== null

/** The choices the dialog offers for a target (D9, UI5); none once it is decided. */
export function allowedChoices(target: PauseTargetView): Choice[] {
  if (target.state.state === 'decided') return []
  return isPaused(target) ? ['continue', 'adapt', 'restart'] : ['restart']
}

const CHOICE_LABELS: Record<Choice, string> = {
  continue: 'Continue: the holder resumes from its checkpoint',
  adapt: "Adapt: publish the task's next revision; a fix attempt continues from the branch head",
  restart: 'Restart: supersede the held work and start a new attempt',
}

/** One checkpoint's package: what was done, what is unfinished, errors and tests, and the next steps. */
export function CheckpointPackage({ checkpoint }: { checkpoint: CheckpointView }) {
  return <div className="text-chat-meta" data-testid={`plan-checkpoint-${checkpoint.id}`}>
    <p>Checkpoint {checkpoint.id} ({checkpoint.kind}{checkpoint.commitSha ? ` ${checkpoint.commitSha}` : ''}) · {checkpoint.createdAt}</p>
    <p>Done: {checkpoint.summary}</p>
    {checkpoint.unfinished && <p>Unfinished: {checkpoint.unfinished}</p>}
    {checkpoint.errorsTests && <p>Errors and tests: {checkpoint.errorsTests}</p>}
    <p>Next: {checkpoint.nextSteps}</p>
  </div>
}

export default function PlanCheckpointDecisionDialog({ teamPath, planId, pauseId, target, connected, busy, onSend }: {
  teamPath: string
  planId: string
  pauseId: string
  target: PauseTargetView
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
}) {
  const choices = allowedChoices(target)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [adapt, setAdapt] = useState('')
  const [rationale, setRationale] = useState('')
  const [releaseHold, setReleaseHold] = useState(false)
  if (choices.length === 0) return null
  const slot = `pause-resolve:${pauseId}:${target.change}`
  const testId = `plan-checkpoint-decide-${target.change}`
  // Adapt rewrites the change's work; a review's direction is its result (D9).
  const adaptBlocked = target.stage === 'review'
  const ready = choice !== null && choices.includes(choice) && (choice !== 'adapt' || (!adaptBlocked && adapt.trim() !== ''))
  const fromCheckpoint = target.checkpoint?.kind === 'commit' && target.checkpoint.commitSha !== null
  const confirm = () => {
    const extra = {
      ...(choice === 'adapt' ? { adapt: adapt.trim() } : {}),
      ...(rationale.trim() === '' ? {} : { rationale: rationale.trim() }),
      ...(releaseHold ? { releaseHold: true } : {}),
    }
    sendPlanCommand(teamPath, onSend, 'pause-resolve', slot, { planId, pauseId, change: target.change, choice, ...extra }, ({ requestId, commandId }) => ({
      type: 'team-plan-pause-resolve', teamPath, requestId, planId, pauseId, change: target.change, choice: choice!, commandId, ...extra,
    }))
  }
  return <PlanHoldCommandFrame teamPath={teamPath} slot={slot} openLabel="Decide…" title={`Decide paused change ${target.change}`} confirmLabel="Decide"
    testId={testId} connected={connected} busy={busy} ready={ready}
    onOpen={() => { setChoice(null); setAdapt(''); setRationale(''); setReleaseHold(false) }} onConfirm={confirm}>
    {target.checkpoint ? <CheckpointPackage checkpoint={target.checkpoint} />
      : <p className="text-chat-meta text-secondary">No checkpoint was recorded.</p>}
    <fieldset className="mt-1 text-chat-meta" data-testid={`${testId}-choices`}>
      <legend>Choice</legend>
      {choices.map(option => <label key={option} className="block">
        <input type="radio" name={`${slot}-choice`} aria-label={option} value={option} checked={choice === option}
          disabled={!connected || (option === 'adapt' && adaptBlocked)} onChange={() => setChoice(option)} /> {CHOICE_LABELS[option]}
      </label>)}
      {adaptBlocked && choices.includes('adapt') && <p className="text-secondary">Adapt is for attempts: this change is paused in review.</p>}
    </fieldset>
    {choice === 'restart' && !fromCheckpoint && <p className="mt-1 text-chat-meta text-approval" data-testid={`${testId}-may-predate`}>
      No checkpoint commit is on origin: the new attempt starts from the branch head on origin, which may predate the holder's work.
    </p>}
    {choice === 'adapt' && <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>The task's new direction (required)</span>
      <textarea aria-label="Adapted direction" className="input min-h-12 text-chat-body" value={adapt} disabled={!connected}
        onChange={event => setAdapt(event.target.value)} />
    </label>}
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Rationale (optional)</span>
      <textarea aria-label="Decision rationale" className="input min-h-12 text-chat-body" value={rationale} disabled={!connected}
        onChange={event => setRationale(event.target.value)} />
    </label>
    <label className="mt-1 block text-chat-meta">
      <input type="checkbox" aria-label="Release the hold" checked={releaseHold} disabled={!connected}
        onChange={event => setReleaseHold(event.target.checked)} /> Release the hold with this decision
    </label>
    <p className="mt-1 text-chat-meta">Or <a href="#plan-execution-stop" data-testid={`${testId}-stop`}>stop the execution</a> instead.</p>
  </PlanHoldCommandFrame>
}

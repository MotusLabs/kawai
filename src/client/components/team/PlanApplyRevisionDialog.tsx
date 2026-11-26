// The Apply dialog (plan-revision-apply D5, D6): it opens from the execution
// section while a running execution's revision is older than the plan's
// approved one. Opening arms its slot (`apply:<executionId>:<revision>`) and
// asks the server's preview, which reads only: the delta by class with each
// change's differing fields and the execution-wide findings, the changes that
// need a choice (changed changes with a task — no other change is asked), the
// generated Adapt text per change, and every precondition's standing. The
// owner picks continue, adapt, or restart per needed change and writes the
// required rationale; Apply recomputes everything, so a stale preview can
// only be refused. The payload names every field the server compares on
// replay, so a resend with it unchanged reuses the armed command id and any
// edit re-mints it. A refusal renders every failing check (the shared frame);
// every control disables while disconnected.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { PlanExecutionView } from '@shared/planExecution'
import type { ApplyPreview } from '@shared/planRevisionControl'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { sendPlanCommand } from './PlanCommandDialog'
import PlanHoldCommandFrame from './PlanHoldCommandFrame'

const CHOICES = ['continue', 'adapt', 'restart'] as const
type Choice = (typeof CHOICES)[number]
const CHOICE_LABELS: Record<Choice, string> = {
  continue: 'Continue: keep the work, read the new revision at its next step',
  adapt: 'Adapt: publish the new direction to its task and notify its developer',
  restart: 'Restart: supersede the work and start the change again',
}

function PreviewBody({ preview, choices, onChoose, connected }: {
  preview: ApplyPreview
  choices: Record<string, Choice>
  onChoose: (change: string, choice: Choice) => void
  connected: boolean
}) {
  const changes = preview.delta?.changes ?? []
  const findings = preview.delta?.findings ?? []
  // choices-complete is what the choices below answer; the server checks it again on Apply.
  const blocking = preview.standing.filter(entry => entry.message !== null && entry.name !== 'choices-complete')
  return <div className="mt-1 text-chat-meta">
    <p>From revision {preview.fromRevision} to revision {preview.revision}</p>
    <ul className="mt-1" data-testid="plan-apply-delta">
      {changes.map(row => <li key={row.change} data-testid={`plan-apply-change-${row.change}`}>
        <code>{row.change}</code>: {row.class}{row.fields.length > 0 ? ` (${row.fields.join(', ')})` : ''}
        {row.class === 'changed' && row.choice === 'none' ? ' — not provisioned yet; it takes the new definition' : ''}
      </li>)}
    </ul>
    {findings.length > 0 && <ul className="mt-1 list-disc pl-5" data-testid="plan-apply-findings">
      {findings.map((finding, index) => <li key={`${finding.kind}-${index}`}><code>{finding.kind}</code>: {finding.detail}</li>)}
    </ul>}
    {preview.needed.map(change => <fieldset key={change} className="mt-1" data-testid={`plan-apply-choice-${change}`}>
      <legend>Choice for <code>{change}</code></legend>
      {CHOICES.map(choice => <label key={choice} className="block">
        <input type="radio" name={`apply-${preview.executionId}-${change}`} aria-label={`${choice} ${change}`} checked={choices[change] === choice}
          disabled={!connected} onChange={() => onChoose(change, choice)} /> {CHOICE_LABELS[choice]}
      </label>)}
      {choices[change] === 'adapt' && preview.adaptations[change] !== undefined && <pre className="mt-1 whitespace-pre-wrap border border-border p-1"
        data-testid={`plan-apply-adaptation-${change}`}>{preview.adaptations[change]}</pre>}
    </fieldset>)}
    {blocking.length > 0 && <div className="mt-1" data-testid="plan-apply-standing">
      <p>Apply would be refused now:</p>
      <ul className="list-disc pl-5">
        {blocking.map(entry => <li key={entry.name}><code>{entry.name}</code>: {entry.message}</li>)}
      </ul>
    </div>}
  </div>
}

export default function PlanApplyRevisionDialog({ teamPath, execution, revision, contentHash, connected, busy, onSend }: {
  teamPath: string
  /** The running execution, whose revision is older than `revision`. */
  execution: PlanExecutionView
  /** The plan's current approved revision and its content hash. */
  revision: number
  contentHash: string
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [rationale, setRationale] = useState('')
  const key = `${execution.id}:${revision}`
  const slot = `apply:${key}`
  const standing = useTeamPlanStore(state => state.views[teamPath]?.revisionPreviews[key])
  const preview = standing?.state === 'preview' ? standing.preview : null
  const needed = preview?.needed ?? []
  const ready = preview !== null && rationale.trim() !== '' && needed.every(change => choices[change] !== undefined)
  const open = () => {
    setChoices({}); setRationale('')
    const requestId = crypto.randomUUID()
    useTeamPlanStore.getState().beginApplyPreview(teamPath, requestId, key)
    onSend({ type: 'team-plan-execution-apply-preview', teamPath, requestId, executionId: execution.id, revision })
  }
  const confirm = () => {
    if (preview === null) return
    const picked = Object.fromEntries(needed.map(change => [change, choices[change]!]))
    const payload = {
      executionId: execution.id, expectedRevision: preview.fromRevision, revision, contentHash: preview.contentHash ?? contentHash,
      choices: picked, rationale: rationale.trim(),
    }
    sendPlanCommand(teamPath, onSend, 'apply', slot, payload, ({ requestId, commandId }) => ({
      type: 'team-plan-execution-apply', teamPath, requestId, ...payload, commandId,
    }))
  }
  return <PlanHoldCommandFrame teamPath={teamPath} slot={slot} openLabel={`Apply revision ${revision}…`} title={`Apply revision ${revision} to this execution`}
    confirmLabel="Apply" testId="plan-apply-revision" connected={connected} busy={busy} ready={ready} onOpen={open} onConfirm={confirm}>
    {standing === undefined || standing.state === 'pending'
      ? <p className="mt-1 text-chat-meta text-secondary" data-testid="plan-apply-pending">Reading the revision's delta…</p>
      : standing.state === 'error'
        ? <p role="alert" className="mt-1 text-chat-meta text-chat-danger" data-testid="plan-apply-preview-error">{standing.error}</p>
        : <PreviewBody preview={standing.preview} choices={choices} connected={connected}
          onChoose={(change, choice) => setChoices(current => ({ ...current, [change]: choice }))} />}
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Rationale (required): the developers of adapted changes read it with the new revision</span>
      <textarea aria-label="Apply rationale" className="input min-h-12 text-chat-body" value={rationale} disabled={!connected}
        onChange={event => setRationale(event.target.value)} />
    </label>
  </PlanHoldCommandFrame>
}

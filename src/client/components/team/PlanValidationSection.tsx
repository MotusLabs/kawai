// A revision's Validation section (plan-validation design D11): the standing
// badge (Not validated, Blocked with counts, Ready, or Out of date naming
// what changed), the **Validate** control, the report grouped as the UX
// doc's rows (Product alignment; Intent and implementation strategy; Scope
// and relations; Readiness), and the owner's controls — answer, accept
// warning, resolve condition, record exception, authorize exploration, and
// the assessment form. Every decision dialog mints one command id when it
// opens and re-mints only when its payload changes; agents never decide, and
// nothing here approves. Every control disables while disconnected.
import { useEffect, useState, type ReactNode } from 'react'
import type { SendClientMessage } from '@shared/types'
import type {
  AlignmentAssessment,
  AlignmentValue,
  AssessmentRow,
  DecisionRecord,
  PlanRevisionValidation,
  PlanValidationStanding,
} from '@shared/planValidation'
import { ALIGNMENT_VALUES } from '@shared/planValidation'
/** Send one owner decision from a dialog slot (D6/D11). */
function sendDecision(teamPath: string, sendMessage: SendClientMessage, slot: string,
  payload: { planId: string; revision: number; kind: DecisionRecord['kind']; target: string; text: string; scope: string | null }) {
  sendPlanCommand(teamPath, sendMessage, 'decide', slot, payload as unknown as Record<string, unknown>,
    ids => ({ type: 'team-plan-validation-decide', teamPath, requestId: ids.requestId, ...payload, commandId: ids.commandId }))
}

/** Send the Validate request (D11): no command id — a repeat with unchanged inputs writes nothing. */
function sendValidate(teamPath: string, sendMessage: SendClientMessage, planId: string, revision: number) {
  const store = useTeamPlanStore.getState()
  const requestId = crypto.randomUUID()
  store.begin(teamPath, requestId, 'validate')
  sendMessage({ type: 'team-plan-validate', teamPath, requestId, planId, revision })
}

/** Send the owner's alignment assessment from its form slot (D5/D11). */
function sendAssessment(teamPath: string, sendMessage: SendClientMessage, slot: string, planId: string, revision: number, alignment: AlignmentAssessment) {
  sendPlanCommand(teamPath, sendMessage, 'assess', slot, { revision, alignment } as unknown as Record<string, unknown>,
    ids => ({ type: 'team-plan-assess', teamPath, requestId: ids.requestId, planId, revision, alignment, commandId: ids.commandId }))
}

import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { sendPlanCommand } from './PlanCommandDialog'

export const VALIDATION_ROW_TITLES = {
  alignment: 'Product alignment',
  intent: 'Intent and implementation strategy',
  scope: 'Scope and relations',
  readiness: 'Readiness',
} as const

/** The standing badge's text and tone (D11). */
export function standingLabel(standing: PlanValidationStanding): { label: string; tone: 'ready' | 'blocked' | 'stale' | 'none' } {
  if (standing.state === 'not-validated') return { label: 'Not validated', tone: 'none' }
  if (standing.state === 'current') return { label: 'Ready', tone: 'ready' }
  if (standing.state === 'out-of-date') return { label: `Out of date (${standing.changedParts.join(', ')})`, tone: 'stale' }
  return { label: 'Blocked', tone: 'blocked' }
}

/** A one-field (or text-plus-scope) owner decision, on one command slot (D6/D11). */
function DecisionDialog({ teamPath, sendMessage, planId, revision, kind, target, slot, openLabel, confirmLabel, textLabel, testId, connected, busy, disabled = false, needsScope = false, initialText = '', children }: {
  teamPath: string
  sendMessage: SendClientMessage
  planId: string
  revision: number
  kind: DecisionRecord['kind']
  target: string
  slot: string
  openLabel: string
  confirmLabel: string
  textLabel: string
  testId: string
  connected: boolean
  busy: boolean
  disabled?: boolean
  /** An exception or an exploration authorization requires its scope (D6). */
  needsScope?: boolean
  /** Prefill (a reused answer); reset when the dialog opens. */
  initialText?: string
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [text, setText] = useState('')
  const [scope, setScope] = useState('')
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  useEffect(() => {
    if (open && sent && !armed) {
      setOpen(false)
      setSent(false)
      setText('')
      setScope('')
    }
  }, [open, sent, armed])
  if (!open) {
    return <button type="button" className="btn text-chat-meta" data-testid={testId}
      disabled={!connected || busy || disabled} onClick={() => {
        useTeamPlanStore.getState().arm(teamPath, slot)
        setText(initialText)
        setOpen(true)
      }}>{openLabel}</button>
  }
  const refused = armed?.refused === true
  const blocked = !connected || busy || disabled || refused || !text.trim() || (needsScope && !scope.trim())
  return <div role="group" aria-label={openLabel} className="mt-2 w-full border border-border p-2" data-testid={`${testId}-dialog`}>
    {children}
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>{textLabel} (required)</span>
      <textarea className="input min-h-12 text-chat-body" value={text} disabled={!connected} onChange={event => setText(event.target.value)} />
    </label>
    {needsScope && <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Scope (required)</span>
      <textarea className="input min-h-8 text-chat-body" value={scope} disabled={!connected} onChange={event => setScope(event.target.value)} />
    </label>}
    {refused && <p className="mt-1 text-chat-meta text-secondary" data-testid={`${testId}-refused`}>
      Refused. Close and reopen this dialog to try again against the current state.
    </p>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn text-chat-meta" data-testid={`${testId}-confirm`} disabled={blocked}
        onClick={() => {
          setSent(true)
          sendDecision(teamPath, sendMessage, slot, {
            planId, revision, kind, target,
            text: text.trim(), scope: needsScope ? scope.trim() : null,
          })
        }}>{confirmLabel}</button>
      <button type="button" className="btn text-chat-meta" onClick={() => { setOpen(false); setSent(false) }}>Cancel</button>
    </div>
  </div>
}

/** The owner's Assess alignment form (D5): one assessment, one command id. */
function AssessAlignmentDialog({ teamPath, sendMessage, planId, revision, connected, busy, disabled }: {
  teamPath: string
  sendMessage: SendClientMessage
  planId: string
  revision: number
  connected: boolean
  busy: boolean
  disabled?: boolean
}) {
  const slot = `assess:${planId}:${revision}`
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [value, setValue] = useState<AlignmentValue>('aligned')
  const [conditions, setConditions] = useState('')
  const [criteria, setCriteria] = useState('')
  const [experimentScope, setExperimentScope] = useState('')
  const [rationale, setRationale] = useState('')
  const armed = useTeamPlanStore(state => state.views[teamPath]?.commands[slot])
  useEffect(() => {
    if (open && sent && !armed) {
      setOpen(false)
      setSent(false)
      setRationale('')
    }
  }, [open, sent, armed])
  if (!open) {
    return <button type="button" className="btn text-chat-meta" data-testid={`plan-assess-${revision}`}
      disabled={!connected || busy || disabled} onClick={() => {
        useTeamPlanStore.getState().arm(teamPath, slot)
        setOpen(true)
      }}>Assess alignment</button>
  }
  const refused = armed?.refused === true
  const needsConditions = value === 'aligned-with-conditions'
  const needsExperiment = value === 'exploratory'
  const parsedConditions = conditions.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.lastIndexOf('@')
    const gate = at > 0 ? line.slice(at + 1).trim() : 'ready'
    return { text: at > 0 ? line.slice(0, at).trim() : line, gate: (['ready', 'start', 'acceptance'].includes(gate) ? gate : 'ready') as 'ready' | 'start' | 'acceptance' }
  })
  const blocked = !connected || busy || disabled || refused || !rationale.trim()
    || (needsConditions && parsedConditions.length === 0) || (needsExperiment && (!criteria.trim() || !experimentScope.trim()))
  return <div role="group" aria-label="Assess alignment" className="mt-2 w-full border border-border p-2" data-testid={`plan-assess-${revision}-dialog`}>
    <p className="text-chat-meta text-secondary">One of the five values; outcomes and conflicts are the agents' words to cite elsewhere. Conditions gate at ready, start, or acceptance.</p>
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Assessment</span>
      <select className="input text-chat-body" value={value} disabled={!connected} onChange={event => setValue(event.target.value as AlignmentValue)}>
        {ALIGNMENT_VALUES.map(entry => <option key={entry} value={entry}>{entry}</option>)}
      </select>
    </label>
    {needsConditions && <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Conditions — one per line as “text @ ready|start|acceptance” (at least one)</span>
      <textarea className="input min-h-12 text-chat-body" value={conditions} disabled={!connected} onChange={event => setConditions(event.target.value)} />
    </label>}
    {needsExperiment && <>
      <label className="mt-1 flex flex-col gap-1 text-chat-meta">
        <span>Experiment criteria (required)</span>
        <textarea className="input min-h-8 text-chat-body" value={criteria} disabled={!connected} onChange={event => setCriteria(event.target.value)} />
      </label>
      <label className="mt-1 flex flex-col gap-1 text-chat-meta">
        <span>Experiment scope (required)</span>
        <textarea className="input min-h-8 text-chat-body" value={experimentScope} disabled={!connected} onChange={event => setExperimentScope(event.target.value)} />
      </label>
    </>}
    <label className="mt-1 flex flex-col gap-1 text-chat-meta">
      <span>Rationale (required)</span>
      <textarea className="input min-h-12 text-chat-body" value={rationale} disabled={!connected} onChange={event => setRationale(event.target.value)} />
    </label>
    {refused && <p className="mt-1 text-chat-meta text-secondary" data-testid={`plan-assess-${revision}-refused`}>
      Refused. Close and reopen this dialog to try again against the current state.
    </p>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn text-chat-meta" data-testid={`plan-assess-${revision}-confirm`} disabled={blocked}
        onClick={() => {
          setSent(true)
          sendAssessment(teamPath, sendMessage, slot, planId, revision, {
            assessment: value,
            outcomes: [],
            conditions: needsConditions ? parsedConditions : [],
            experiment: needsExperiment ? { criteria: criteria.trim(), scope: experimentScope.trim() } : null,
            conflicts: [],
            rationale: rationale.trim(),
          })
        }}>Save assessment</button>
      <button type="button" className="btn text-chat-meta" onClick={() => { setOpen(false); setSent(false) }}>Cancel</button>
    </div>
  </div>
}

/**
 * One revision's Validation section (D11). `validation` is the pushed
 * section for this revision — null means Not validated. The report's
 * findings render grouped by the four UX rows, each with the owner's
 * decision controls beside the item it resolves.
 */
export default function PlanValidationSection({ teamPath, planId, revision, pin, validation, earlierRevisions, onCaptureStrategy, sendMessage, connected, busy }: {
  teamPath: string
  planId: string
  revision: number
  /** The revision's strategy pin; empty means Alignment unassessed (S11). */
  pin: { strategyId: string; revision: number; hash: string } | null
  validation: PlanRevisionValidation | null
  /** Earlier revisions' validation sections, for reusing an answer (D11). */
  earlierRevisions: PlanRevisionValidation[]
  onCaptureStrategy?: () => void
  sendMessage: SendClientMessage
  connected: boolean
  busy: boolean
}) {
  const entry = validation
  const standing = entry?.standing ?? { state: 'not-validated' as const }
  const badge = standingLabel(standing)
  const report = entry?.report ?? null
  const readiness = report?.readiness ?? null
  const questions = (entry?.assessments ?? []).filter((row): row is Extract<AssessmentRow, { kind: 'question' }> => row.kind === 'question')
  const alignments = (entry?.assessments ?? []).filter((row): row is Extract<AssessmentRow, { kind: 'alignment' }> => row.kind === 'alignment')
  const findings = (entry?.assessments ?? []).filter((row): row is Extract<AssessmentRow, { kind: 'finding' }> => row.kind === 'finding')
  const decisions = entry?.decisions ?? []
  const answered = new Set(decisions.filter(decision => decision.kind === 'answer').map(decision => decision.target))
  const accepted = new Set(decisions.filter(decision => decision.kind === 'accept-warning').map(decision => decision.target))
  const rows = (Object.keys(VALIDATION_ROW_TITLES) as Array<keyof typeof VALIDATION_ROW_TITLES>)
    .map(row => ({ row, title: VALIDATION_ROW_TITLES[row], items: (report?.findings ?? []).filter(finding => finding.row === row) }))

  return <section data-testid={`plan-validation-${revision}`} aria-labelledby={`plan-validation-${revision}-heading`} className="mt-2 border border-border p-2">
    <h6 id={`plan-validation-${revision}-heading`} className="font-medium text-chat-meta">Validation — revision {revision}</h6>
    <p className="text-chat-meta" data-testid={`plan-validation-${revision}-standing`} data-tone={badge.tone}>
      {badge.label}
      {standing.state === 'out-of-date' && standing.changedParts.length > 0 ? '' : ''}
      {readiness && standing.state === 'blocked' ? ` — ${readiness.errors.length} error${readiness.errors.length === 1 ? '' : 's'}, ${readiness.unansweredQuestions.length} unanswered question${readiness.unansweredQuestions.length === 1 ? '' : 's'}, ${readiness.unacceptedWarnings.length} unaccepted warning${readiness.unacceptedWarnings.length === 1 ? '' : 's'}${readiness.alignment.reason ? `, alignment ${readiness.alignment.reason}` : ''}` : ''}
    </p>
    {pin === null
      ? <p className="text-chat-meta text-secondary" data-testid={`plan-validation-${revision}-unassessed`}>
          Unassessed: no approved strategy{onCaptureStrategy ? <> — <button type="button" className="btn text-chat-meta" data-testid={`plan-validation-${revision}-capture`} onClick={onCaptureStrategy}>capture one</button></> : null}
        </p>
      : <AssessAlignmentDialog teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision} connected={connected} busy={busy} />}
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className="btn text-chat-meta" data-testid={`plan-validate-${revision}`} disabled={!connected || busy}
        onClick={() => sendValidate(teamPath, sendMessage, planId, revision)}>Validate</button>
    </div>

    {report && <div className="mt-2" data-testid={`plan-validation-${revision}-report`}>
      {rows.map(({ row, title, items }) => <div key={row} className="mt-2" data-testid={`plan-validation-${revision}-row-${row}`}>
        <p className="text-chat-meta font-medium text-secondary">{title}</p>
        {items.length === 0 && <p className="text-chat-meta text-secondary">(nothing reported)</p>}
        <ul className="text-chat-meta">
          {items.map(finding => <li key={finding.key} data-testid={`plan-validation-${revision}-finding-${finding.key}`} data-severity={finding.severity}>
            <span className={finding.severity === 'error' ? 'text-approval' : finding.severity === 'warning' ? 'text-attention' : 'text-secondary'}>
              {finding.severity === 'evidence' ? '·' : finding.severity === 'error' ? '✗' : '!'} {finding.message}
            </span>
            {finding.severity === 'warning' && !accepted.has(finding.key) && <DecisionDialog
              teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision}
              kind="accept-warning" target={finding.key} slot={`accept:${planId}:${revision}:${finding.key}`}
              openLabel="Accept warning" confirmLabel="Accept warning" textLabel="Why this warning is acceptable"
              testId={`plan-accept-${revision}-${finding.key}`} connected={connected} busy={busy} />}
          </li>)}
        </ul>
      </div>)}

      <div className="mt-2" data-testid={`plan-validation-${revision}-questions`}>
        <p className="text-chat-meta font-medium text-secondary">Questions</p>
        {questions.length === 0 && <p className="text-chat-meta text-secondary">(none)</p>}
        <ul className="text-chat-meta">
          {questions.map(question => <li key={question.id} data-testid={`plan-validation-${revision}-question-${question.id}`}>
            {question.payload.mandatory ? 'Mandatory' : 'Optional'}{question.payload.subject ? ` (${question.payload.subject})` : ''}: {question.payload.text}
            {answered.has(question.id)
              ? <span className="text-secondary"> — answered</span>
              : <DecisionDialog
                  teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision}
                  kind="answer" target={question.id} slot={`answer:${planId}:${revision}:${question.id}`}
                  openLabel="Answer" confirmLabel="Answer" textLabel="The answer"
                  testId={`plan-answer-${revision}-${question.id}`} connected={connected} busy={busy}
                  initialText={reuseAnswer(earlierRevisions, question.payload.text)} />}
          </li>)}
        </ul>
      </div>

      {alignments.length > 0 && <div className="mt-2" data-testid={`plan-validation-${revision}-assessments`}>
        <p className="text-chat-meta font-medium text-secondary">Alignment assessments</p>
        <ul className="text-chat-meta">
          {alignments.map(row => <li key={row.id} data-testid={`plan-validation-${revision}-assessment-${row.id}`}>
            {row.payload.assessment} — {row.payload.rationale}
            {row.payload.assessment === 'conflicting' && !decisions.some(decision => decision.kind === 'alignment-exception' && decision.target === row.id) && <DecisionDialog
              teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision}
              kind="alignment-exception" target={row.id} slot={`except:${planId}:${revision}:${row.id}`}
              openLabel="Record exception" confirmLabel="Record exception" textLabel="Why the conflict is accepted"
              testId={`plan-exception-${revision}`} connected={connected} busy={busy} needsScope />}
            {(row.payload.assessment === 'exploratory' || row.payload.assessment === 'insufficient-information') && !decisions.some(decision => decision.kind === 'authorize-exploration' && decision.target === row.id) && <DecisionDialog
              teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision}
              kind="authorize-exploration" target={row.id} slot={`explore:${planId}:${revision}:${row.id}`}
              openLabel="Authorize exploration" confirmLabel="Authorize exploration" textLabel="The authorization"
              testId={`plan-explore-${revision}`} connected={connected} busy={busy} needsScope />}
            {row.payload.conditions.length > 0 && <ul className="text-secondary">
              {row.payload.conditions.map((condition, index) => <li key={index} data-testid={`plan-validation-${revision}-condition-${row.id}-${index}`}>
                condition {index + 1} ({condition.gate}): {condition.text}
                {condition.gate === 'ready' && !decisions.some(decision => decision.kind === 'resolve-condition' && decision.target === `${row.id}#${index}`) && <DecisionDialog
                  teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision}
                  kind="resolve-condition" target={`${row.id}#${index}`} slot={`resolve:${planId}:${revision}:${row.id}:${index}`}
                  openLabel="Resolve condition" confirmLabel="Resolve condition" textLabel="How it is resolved"
                  testId={`plan-resolve-${revision}-${index}`} connected={connected} busy={busy} />}
              </li>)}
            </ul>}
          </li>)}
        </ul>
      </div>}

      {findings.length > 0 && <div className="mt-2" data-testid={`plan-validation-${revision}-agent-findings`}>
        <p className="text-chat-meta font-medium text-secondary">Agent findings (warnings)</p>
        <ul className="text-chat-meta">
          {findings.map(row => <li key={row.id} data-testid={`plan-validation-${revision}-agent-finding-${row.id}`}>
            ! {row.payload.text}
            {!accepted.has(`finding:${row.id}`) && <DecisionDialog
              teamPath={teamPath} sendMessage={sendMessage} planId={planId} revision={revision}
              kind="accept-warning" target={`finding:${row.id}`} slot={`accept:${planId}:${revision}:finding:${row.id}`}
              openLabel="Accept warning" confirmLabel="Accept warning" textLabel="Why this finding is acceptable"
              testId={`plan-accept-finding-${row.id}`} connected={connected} busy={busy} />}
          </li>)}
        </ul>
      </div>}

      {readiness && readiness.carriedConditions.length > 0 && <p className="text-chat-meta text-secondary" data-testid={`plan-validation-${revision}-carried`}>
        Carried conditions: {readiness.carriedConditions.map(condition => `${condition.text} (${condition.gate}${condition.resolved ? ', resolved' : ''})`).join('; ')}
      </p>}
    </div>}
  </section>
}

/**
 * The same question's answer on an earlier revision, offered as a starting
 * point (D11): matched by text, from that revision's answer decisions.
 */
function reuseAnswer(earlier: PlanRevisionValidation[], text: string): string {
  for (const entry of [...earlier].reverse()) {
    const questions = entry.assessments.filter((row): row is Extract<AssessmentRow, { kind: 'question' }> => row.kind === 'question')
    for (const decision of entry.decisions) {
      if (decision.kind !== 'answer') continue
      const question = questions.find(row => row.id === decision.target)
      if (question?.payload.text === text) return decision.text
    }
  }
  return ''
}

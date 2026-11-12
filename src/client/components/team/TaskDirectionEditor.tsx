// The human's direction editor (task-revision-publication 5.2, D1/D2): a
// draft of direction, acceptance, and rationale that **Save draft** keeps
// without publishing anything, and **Publish revision N** / **Publish and
// notify** turn into the next revision from the draft's base. A draft based
// on an older revision says so and offers **Rebase onto revision M**; the
// server refuses a stale publication and keeps the draft. Publishing needs a
// rationale. Command keys are armed in the task store per payload, so a
// double click or a resend after a reconnect publishes once. The draft also
// holds the implementation contract (implementation-contract D3, D7): the
// textarea starts from the saved draft's raw text, else the base revision's
// rendered contract; live parser problems disable publishing, and clearing
// a contract the task already carries is refused before it is sent.
import { useEffect, useState } from 'react'
import type { TaskDraft, TeamTaskSummary } from '@shared/teamTasks'
import { contractHashInput, parseContract, renderContract, type ContractProblem, type ImplementationContract } from '@shared/implementationContract'
import type { TaskAction } from '../../stores/teamTaskStore'

/** The form an action sent, kept until the server's push shows it landed. */
interface SentForm {
  kind: 'draft' | 'publish' | 'discard'
  direction: string
  acceptance: string
  rationale: string
  contract: string
}

/** A contract's canonical form, '' for none: equal keys are the same contract. */
const contractKey = (contract: ImplementationContract | null | undefined) => (contract ? contractHashInput(contract) : '')
/** The text's contract key, or null while it does not parse. */
function textKey(text: string): string | null {
  if (!text.trim()) return ''
  const parsed = parseContract(text)
  return parsed.contract ? contractKey(parsed.contract) : null
}
const startText = (task: TeamTaskSummary) => (task.contract ? renderContract(task.contract) : '')

function landed(form: SentForm, task: TeamTaskSummary, draft: TaskDraft | null | undefined): boolean {
  if (form.kind === 'discard') return !draft
  if (form.kind === 'publish') {
    return task.direction === form.direction && (task.acceptance ?? '') === form.acceptance && contractKey(task.contract) === textKey(form.contract)
  }
  return !!draft && draft.direction === form.direction && (draft.acceptance ?? '') === form.acceptance && (draft.rationale ?? '') === form.rationale
    && (draft.contractText ?? '') === form.contract
}

/** Send a task action; `command` arms (or reuses) the slot's request key for it. */
export type TaskActFn = (action: TaskAction, message: Record<string, unknown>, command?: { slot: string; payload: string }) => void

export default function TaskDirectionEditor({ task, draft, connected, disabled, act }: {
  task: TeamTaskSummary
  draft: TaskDraft | null | undefined
  connected: boolean
  /** Disconnected, or an action is awaiting its result. */
  disabled: boolean
  act: TaskActFn
}) {
  const [direction, setDirection] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [rationale, setRationale] = useState('')
  const [contract, setContract] = useState('')
  /** The published revision the form edits; it never moves under unsaved text. */
  const [base, setBase] = useState(task.revision)
  /** Unsent edits: a push (a new revision, a saved draft) must not overwrite them. */
  const [touched, setTouched] = useState(false)
  /**
   * What the last action sent. The form is clean again only once the server
   * shows it — the draft saved, the revision published, the draft gone — so
   * a refusal (stale, key reuse) keeps every word and nothing flickers back
   * while the push is on its way.
   */
  const [sentForm, setSentForm] = useState<SentForm | null>(null)
  // Another task: start over.
  useEffect(() => { setTouched(false); setSentForm(null) }, [task.id])
  useEffect(() => {
    if (sentForm && landed(sentForm, task, draft)) {
      setSentForm(null)
      setTouched(false)
    }
  }, [sentForm, task, draft])
  // The form follows the saved draft, else the current revision — unless the
  // human is mid-edit, when the text and its base stay (a newer revision then
  // shows as stale instead of silently replacing their words).
  useEffect(() => {
    if (touched) return
    setDirection(draft?.direction ?? task.direction)
    setAcceptance(draft ? draft.acceptance ?? '' : task.acceptance ?? '')
    setRationale(draft?.rationale ?? '')
    // A draft saved before contracts has no text: start from the revision's.
    setContract(draft?.contractText ?? startText(task))
    setBase(draft?.baseRevision ?? task.revision)
  }, [touched, task.id, task.revision, task.direction, task.acceptance, task.contractHash, draft?.updatedAt, draft?.baseRevision, draft?.direction, draft?.acceptance, draft?.rationale, draft?.contractText])
  const edit = (setter: (value: string) => void) => (value: string) => { setTouched(true); setter(value) }
  const sent = (form: SentForm) => { setTouched(true); setSentForm(form) }

  const stale = base < task.revision
  const problems: ContractProblem[] = contract.trim() ? parseContract(contract).problems : []
  /** Clearing is refused once a revision carried a contract (C6); say so before sending. */
  const clearsContract = !contract.trim() && !!task.contract
  const contractEdited = textKey(contract) !== contractKey(task.contract)
  const edited = direction.trim() !== task.direction || acceptance.trim() !== (task.acceptance ?? '') || contractEdited
  const unsaved = !draft || direction.trim() !== draft.direction || acceptance.trim() !== (draft.acceptance ?? '') ||
    rationale.trim() !== (draft.rationale ?? '') || contract !== (draft.contractText ?? startText(task))
  // A task without a contract and a blank field sends none (C1); otherwise the text, which the server parses.
  const sendsContract = !!contract.trim() || !!task.contract || !!draft?.contractText
  const canPublish = !disabled && !stale && edited && !!direction.trim() && !!rationale.trim() && problems.length === 0 && !clearsContract
  const publish = (notify: boolean) => {
    const fields = { baseRevision: base, direction: direction.trim(), acceptance: acceptance.trim(), ...(sendsContract ? { contract } : {}), rationale: rationale.trim(), notify }
    sent({ kind: 'publish', direction: fields.direction, acceptance: fields.acceptance, rationale: fields.rationale, contract })
    act('publish', { type: 'team-task-publish', ...fields, fromDraft: !!draft }, { slot: `publish:${task.id}`, payload: JSON.stringify(fields) })
  }

  return <div className="mt-2 flex flex-col gap-2" data-testid="task-direction-editor">
    {draft && <p className="text-chat-meta text-secondary" data-testid="task-draft-status">
      Draft saved · based on revision {draft.baseRevision} · not published</p>}
    {stale && <div role="alert" className="text-chat-meta" data-testid="task-draft-stale">
      {draft ? 'Draft' : 'Your edit'} based on revision {base}; current is {task.revision}. Read revision {task.revision}, then rebase to publish.
      <button type="button" className="btn ml-2 text-chat-meta" disabled={disabled} data-testid="task-rebase-draft" onClick={() => {
        // The text stays; only its base moves. A saved draft moves on the server too.
        setBase(task.revision)
        if (draft) act('draft', { type: 'team-task-draft', action: 'rebase' })
      }}>Rebase onto revision {task.revision}</button>
    </div>}
    <textarea className="input min-h-16 text-chat-body" aria-label="Draft direction" value={direction} disabled={!connected}
      onChange={event => edit(setDirection)(event.target.value)} />
    <textarea className="input min-h-12 text-chat-body" aria-label="Draft acceptance criteria" value={acceptance} disabled={!connected}
      onChange={event => edit(setAcceptance)(event.target.value)} />
    <textarea className="input min-h-24 font-mono text-chat-meta" aria-label="Draft implementation contract" value={contract} disabled={!connected}
      placeholder={'## Implementation contract (optional)\n### Acceptance\n- A1: …\n### Invariants\n### Scope\n- src/**\n### Verification\n- V1: …\n### Excluded'}
      onChange={event => edit(setContract)(event.target.value)} />
    {problems.length > 0 && <ul role="alert" className="text-chat-meta" data-testid="task-contract-problems">
      {problems.map(problem => <li key={`${problem.line}:${problem.message}`}>Line {problem.line}: {problem.message}</li>)}
    </ul>}
    {clearsContract && <p role="alert" className="text-chat-meta" data-testid="task-contract-clear-refused">
      This task already has a contract; it can be replaced but not removed.</p>}
    <input className="input text-chat-body" aria-label="Rationale" placeholder="Why this change (required to publish)" value={rationale}
      disabled={!connected} onChange={event => edit(setRationale)(event.target.value)} />
    <p className="text-chat-meta text-secondary">A draft publishes nothing — agents never see it. Publishing records revision {task.revision + 1};
      Publish and notify also sends the assignment's claimed agent a revision notice.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn" data-testid="task-save-draft" disabled={disabled || !direction.trim() || !unsaved}
        onClick={() => {
          const fields = { direction: direction.trim(), acceptance: acceptance.trim(), rationale: rationale.trim(), ...(sendsContract ? { contract } : {}) }
          sent({ kind: 'draft', ...fields, contract })
          act('draft', { type: 'team-task-draft', action: 'save', baseRevision: base, ...fields })
        }}>Save draft</button>
      <button type="button" className="btn" data-testid="task-publish" disabled={!canPublish}
        onClick={() => publish(false)}>Publish revision {task.revision + 1}</button>
      <button type="button" className="btn btn-primary" data-testid="task-publish-notify" disabled={!canPublish}
        onClick={() => publish(true)}>Publish and notify</button>
      {draft && <button type="button" className="btn text-chat-meta" data-testid="task-discard-draft" disabled={disabled}
        onClick={() => {
          sent({ kind: 'discard', direction: '', acceptance: '', rationale: '', contract: '' })
          act('draft', { type: 'team-task-draft', action: 'discard' })
        }}>Discard draft</button>}
    </div>
  </div>
}

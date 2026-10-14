// The human's direction editor (task-revision-publication 5.2, D1/D2): a
// draft of direction, acceptance, and rationale that **Save draft** keeps
// without publishing anything, and **Publish revision N** / **Publish and
// notify** turn into the next revision from the draft's base. A draft based
// on an older revision says so and offers **Rebase onto revision M**; the
// server refuses a stale publication and keeps the draft. Publishing needs a
// rationale. Command keys are armed in the task store per payload, so a
// double click or a resend after a reconnect publishes once.
import { useEffect, useState } from 'react'
import type { TaskDraft, TeamTaskSummary } from '@shared/teamTasks'
import type { TaskAction } from '../../stores/teamTaskStore'

/** The form an action sent, kept until the server's push shows it landed. */
interface SentForm {
  kind: 'draft' | 'publish' | 'discard'
  direction: string
  acceptance: string
  rationale: string
}

function landed(form: SentForm, task: TeamTaskSummary, draft: TaskDraft | null | undefined): boolean {
  if (form.kind === 'discard') return !draft
  if (form.kind === 'publish') return task.direction === form.direction && (task.acceptance ?? '') === form.acceptance
  return !!draft && draft.direction === form.direction && (draft.acceptance ?? '') === form.acceptance && (draft.rationale ?? '') === form.rationale
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
    setBase(draft?.baseRevision ?? task.revision)
  }, [touched, task.id, task.revision, task.direction, task.acceptance, draft?.updatedAt, draft?.baseRevision, draft?.direction, draft?.acceptance, draft?.rationale])
  const edit = (setter: (value: string) => void) => (value: string) => { setTouched(true); setter(value) }
  const sent = (form: SentForm) => { setTouched(true); setSentForm(form) }

  const stale = base < task.revision
  const edited = direction.trim() !== task.direction || acceptance.trim() !== (task.acceptance ?? '')
  const unsaved = !draft || direction.trim() !== draft.direction || acceptance.trim() !== (draft.acceptance ?? '') ||
    rationale.trim() !== (draft.rationale ?? '')
  const canPublish = !disabled && !stale && edited && !!direction.trim() && !!rationale.trim()
  const publish = (notify: boolean) => {
    const fields = { baseRevision: base, direction: direction.trim(), acceptance: acceptance.trim(), rationale: rationale.trim(), notify }
    sent({ kind: 'publish', direction: fields.direction, acceptance: fields.acceptance, rationale: fields.rationale })
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
    <input className="input text-chat-body" aria-label="Rationale" placeholder="Why this change (required to publish)" value={rationale}
      disabled={!connected} onChange={event => edit(setRationale)(event.target.value)} />
    <p className="text-chat-meta text-secondary">A draft publishes nothing — agents never see it. Publishing records revision {task.revision + 1};
      Publish and notify also sends the assignment's claimed agent a revision notice.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn" data-testid="task-save-draft" disabled={disabled || !direction.trim() || !unsaved}
        onClick={() => {
          const fields = { direction: direction.trim(), acceptance: acceptance.trim(), rationale: rationale.trim() }
          sent({ kind: 'draft', ...fields })
          act('draft', { type: 'team-task-draft', action: 'save', baseRevision: base, ...fields })
        }}>Save draft</button>
      <button type="button" className="btn" data-testid="task-publish" disabled={!canPublish}
        onClick={() => publish(false)}>Publish revision {task.revision + 1}</button>
      <button type="button" className="btn btn-primary" data-testid="task-publish-notify" disabled={!canPublish}
        onClick={() => publish(true)}>Publish and notify</button>
      {draft && <button type="button" className="btn text-chat-meta" data-testid="task-discard-draft" disabled={disabled}
        onClick={() => {
          sent({ kind: 'discard', direction: '', acceptance: '', rationale: '' })
          act('draft', { type: 'team-task-draft', action: 'discard' })
        }}>Discard draft</button>}
    </div>
  </div>
}

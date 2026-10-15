// The strategy draft editor (product-strategy 5.2): the template's sections
// with claim-kind labels, `Unknown` success measures, and an impact
// proposal field for material changes. Local state is seeded from the
// stored draft when the editor opens or the author reloads — a CAS refusal
// never overwrites it, so the caller's unsaved text survives for
// reconciliation (S12); the stored draft is shown beside it, and Reload
// adopts that refused-with copy (the `draft` prop may predate it).
import { useEffect, useState } from 'react'
import type { StrategyContent, StrategyDraft } from '@shared/productStrategy'
import { UNKNOWN, STRATEGY_CLAIM_KINDS, normalizeStrategyContent, strategyContentErrors } from '@shared/productStrategy'
import { claimLabel } from '../chat/strategyLabels'

export interface DraftSavePayload {
  content: unknown
  impactProposal: string | null
  expectedDraftHash: string | null
  expectedBaseRevision: number | null
}

const EMPTY: StrategyContent = normalizeStrategyContent({})
const blank = <T extends object>(fields: T): T => ({ ...fields })

export default function StrategyDraftEditor({ draft, connected, busy, error, conflict, onSave, onReload, retained, onRetain, sectionAnchors = false }: {
  draft: StrategyDraft | null
  connected: boolean
  busy: boolean
  error: string | null
  conflict: StrategyDraft | null
  onSave: (payload: DraftSavePayload) => void
  /** Adopt `conflict` as the stored draft; the reseed below then follows the new `draft` prop. */
  onReload: () => void
  /**
   * The team's retained unsaved text (team-workspace-pages D5): present when
   * the host keeps it across sub-view switches. Seeding prefers it, and a
   * draft refresh never wipes text newer than the stored draft.
   */
  retained?: { body: StrategyContent; impact: string; dirty: boolean } | null
  onRetain?: (retained: { body: StrategyContent; impact: string; dirty: boolean } | null) => void
  /** Give the section headings ids, so a section list can scroll to them. */
  sectionAnchors?: boolean
}) {
  const [body, setBody] = useState<StrategyContent>(() => retained?.body ?? draft?.content ?? EMPTY)
  const [impact, setImpact] = useState(retained?.impact ?? draft?.impactProposal ?? '')
  const [localError, setLocalError] = useState<string | null>(null)
  // Seed only when the draft identity changes (first open, or an explicit
  // reload below): never on a prop refresh, or a CAS refusal would wipe
  // the very text it is supposed to preserve. Retained dirty text outranks
  // a refresh the same way (D5).
  useEffect(() => {
    if (retained?.dirty) return
    setBody(draft?.content ?? EMPTY)
    setImpact(draft?.impactProposal ?? '')
    setLocalError(null)
  }, [draft?.draftId, draft?.updatedAt, draft?.contentHash]) // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => {
    const stored = conflict ?? draft
    setBody(stored?.content ?? EMPTY)
    setImpact(stored?.impactProposal ?? '')
    setLocalError(null)
    onRetain?.(null)
    onReload()
  }
  // Every edit retains the text for the team, so a sub-view switch keeps it.
  const editBody = (next: StrategyContent) => {
    setBody(next)
    onRetain?.({ body: next, impact, dirty: true })
  }
  const editImpact = (next: string) => {
    setImpact(next)
    onRetain?.({ body, impact: next, dirty: true })
  }

  const patch = (fields: Partial<StrategyContent>) => editBody({ ...body, ...fields })
  const field = (key: keyof StrategyContent) => ({
    value: body[key] as string,
    disabled: !connected,
    onChange: (event: { target: { value: string } }) => patch({ [key]: event.target.value } as Partial<StrategyContent>),
  })
  const lines = (key: 'boundaries' | 'openQuestions') => ({
    value: (body[key] as string[]).join('\n'),
    disabled: !connected,
    onChange: (event: { target: { value: string } }) =>
      patch({ [key]: event.target.value.split('\n').filter(line => line.trim()) } as Partial<StrategyContent>),
  })

  const save = () => {
    const normalized = normalizeStrategyContent(body)
    const errors = strategyContentErrors(normalized)
    if (errors.length > 0) {
      setLocalError(errors.join(' '))
      return
    }
    setLocalError(null)
    onSave({
      content: normalized,
      impactProposal: impact.trim() || null,
      expectedDraftHash: draft?.contentHash ?? null,
      expectedBaseRevision: draft?.baseRevision ?? null,
    })
  }

  const claimInvalid = (index: number) => body.claims[index]?.kind === 'validated_observation' && !body.claims[index]?.source?.trim()

  return <section data-testid="strategy-draft-editor" className="mt-4 border border-border p-2">
    <h4 className="font-medium">Draft{draft ? ` (based on revision ${draft.baseRevision ?? 'none'})` : ''}</h4>
    <div className="mt-2 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Purpose
        <textarea className="input text-chat-body" aria-label="Purpose" placeholder="Why the product exists — one or two sentences" {...field('purpose')} /></label>
      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Primary users
        <textarea className="input text-chat-body" aria-label="Primary users" placeholder="Whom it serves" {...field('primaryUsers')} /></label>
      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Needs and outcomes
        <textarea className="input text-chat-body" aria-label="Needs and outcomes" placeholder="What changes for them" {...field('needsOutcomes')} /></label>

      <h5 className="mt-1 font-medium text-chat-body" {...(sectionAnchors ? { id: 'draft-section-useCases' } : {})}>Main use cases</h5>
      {body.useCases.map((useCase, index) => <fieldset key={index} data-testid="use-case" className="border border-border p-2">
        <legend className="text-chat-meta text-secondary">Use case {index + 1}</legend>
        <div className="grid grid-cols-1 gap-1">
          {(['userOrSituation', 'trigger', 'wantedOutcome', 'currentObstacle', 'desiredExperience', 'successSignal', 'constraints'] as const).map(key => (
            <input key={key} className="input text-chat-body" aria-label={key} placeholder={USE_CASE_PLACEHOLDERS[key]}
              value={useCase[key]} disabled={!connected}
              onChange={event => editBody({
                ...body,
                useCases: body.useCases.map((entry, at) => at === index ? { ...entry, [key]: event.target.value } : entry),
              })} />
          ))}
        </div>
        <button type="button" className="btn mt-1 text-chat-meta" disabled={!connected}
          onClick={() => editBody({ ...body, useCases: body.useCases.filter((_entry, at) => at !== index) })}>Remove use case</button>
      </fieldset>)}
      <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
        onClick={() => editBody({ ...body, useCases: [...body.useCases, blank(EMPTY.useCases[0] ?? {
          ref: `uc${body.useCases.length + 1}`, userOrSituation: '', trigger: '', wantedOutcome: '', currentObstacle: '', desiredExperience: '', successSignal: '', constraints: '',
        })] })}>Add use case</button>

      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Product approach
        <textarea className="input text-chat-body" aria-label="Product approach" placeholder="How the product pursues it" {...field('productApproach')} /></label>

      <h5 className="mt-1 font-medium text-chat-body" {...(sectionAnchors ? { id: 'draft-section-principles' } : {})}>Principles and trade-offs</h5>
      {body.principles.map((principle, index) => <div key={index} data-testid="principle" className="flex flex-col gap-1 border border-border p-2">
        <input className="input text-chat-body" aria-label="Principle" placeholder="Principle" value={principle.principle} disabled={!connected}
          onChange={event => editBody({ ...body, principles: body.principles.map((entry, at) => at === index ? { ...entry, principle: event.target.value } : entry) })} />
        <input className="input text-chat-body" aria-label="Trade-off" placeholder="Trade-off it accepts" value={principle.tradeoff} disabled={!connected}
          onChange={event => editBody({ ...body, principles: body.principles.map((entry, at) => at === index ? { ...entry, tradeoff: event.target.value } : entry) })} />
        <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
          onClick={() => editBody({ ...body, principles: body.principles.filter((_entry, at) => at !== index) })}>Remove principle</button>
      </div>)}
      <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
        onClick={() => editBody({ ...body, principles: [...body.principles, { ref: `pr${body.principles.length + 1}`, principle: '', tradeoff: '' }] })}>Add principle</button>

      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Boundaries and non-goals (one per line)
        <textarea className="input text-chat-body" aria-label="Boundaries and non-goals" placeholder={'What it deliberately does not do'} {...lines('boundaries')} /></label>

      <h5 className="mt-1 font-medium text-chat-body" {...(sectionAnchors ? { id: 'draft-section-successMeasures' } : {})}>Success measures</h5>
      {body.successMeasures.map((measure, index) => <div key={index} data-testid="success-measure" className="flex flex-col gap-1 border border-border p-2">
        <div className="grid grid-cols-2 gap-1">
          <input className="input text-chat-body" aria-label="Outcome" placeholder="Outcome" value={measure.outcome} disabled={!connected}
            onChange={event => editBody({ ...body, successMeasures: body.successMeasures.map((entry, at) => at === index ? { ...entry, outcome: event.target.value } : entry) })} />
          <input className="input text-chat-body" aria-label="Measure" placeholder="Proposed measure" value={measure.measure} disabled={!connected}
            onChange={event => editBody({ ...body, successMeasures: body.successMeasures.map((entry, at) => at === index ? { ...entry, measure: event.target.value } : entry) })} />
          <input className="input text-chat-body" aria-label="Baseline" placeholder="Known baseline" value={measure.baseline} disabled={!connected}
            onChange={event => editBody({ ...body, successMeasures: body.successMeasures.map((entry, at) => at === index ? { ...entry, baseline: event.target.value } : entry) })} />
          <input className="input text-chat-body" aria-label="Target" placeholder="Agreed target" value={measure.target} disabled={!connected}
            onChange={event => editBody({ ...body, successMeasures: body.successMeasures.map((entry, at) => at === index ? { ...entry, target: event.target.value } : entry) })} />
        </div>
        <p className="text-chat-meta text-secondary" data-testid="measure-unknown">Leave blank to record {UNKNOWN} — never invent a number.</p>
        <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
          onClick={() => editBody({ ...body, successMeasures: body.successMeasures.filter((_entry, at) => at !== index) })}>Remove measure</button>
      </div>)}
      <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
        onClick={() => editBody({ ...body, successMeasures: [...body.successMeasures, { ref: `m${body.successMeasures.length + 1}`, outcome: '', measure: '', baseline: UNKNOWN, target: UNKNOWN }] })}>Add measure</button>

      <h5 className="mt-1 font-medium text-chat-body" {...(sectionAnchors ? { id: 'draft-section-claims' } : {})}>Assumptions and evidence</h5>
      {body.claims.map((claim, index) => <div key={index} data-testid="claim" className={`flex flex-col gap-1 border p-2 ${claimInvalid(index) ? 'border-chat-danger' : 'border-border'}`}>
        <input className="input text-chat-body" aria-label="Claim" placeholder="The claim" value={claim.text} disabled={!connected}
          onChange={event => editBody({ ...body, claims: body.claims.map((entry, at) => at === index ? { ...entry, text: event.target.value } : entry) })} />
        <div className="grid grid-cols-2 gap-1">
          <select className="input text-chat-body" aria-label="Claim kind" value={claim.kind} disabled={!connected}
            onChange={event => editBody({ ...body, claims: body.claims.map((entry, at) => at === index ? { ...entry, kind: event.target.value as typeof entry.kind } : entry) })}>
            {STRATEGY_CLAIM_KINDS.map(kind => <option key={kind} value={kind}>{claimLabel(kind)}</option>)}
          </select>
          <input className="input text-chat-body" aria-label="Claim source" placeholder="Source (required for validated observations)" value={claim.source ?? ''} disabled={!connected}
            onChange={event => editBody({ ...body, claims: body.claims.map((entry, at) => at === index ? { ...entry, source: event.target.value } : entry) })} />
          <input className="input text-chat-body" aria-label="Claim limitations" placeholder="Limitations" value={claim.limitations ?? ''} disabled={!connected}
            onChange={event => editBody({ ...body, claims: body.claims.map((entry, at) => at === index ? { ...entry, limitations: event.target.value } : entry) })} />
          <input className="input text-chat-body" aria-label="Claim observed at" placeholder="Observed when/where" value={claim.observedAt ?? ''} disabled={!connected}
            onChange={event => editBody({ ...body, claims: body.claims.map((entry, at) => at === index ? { ...entry, observedAt: event.target.value } : entry) })} />
        </div>
        <p className="text-chat-meta text-secondary" data-testid={`claim-kind-${index}`}>{claimLabel(claim.kind)}</p>
        <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
          onClick={() => editBody({ ...body, claims: body.claims.filter((_entry, at) => at !== index) })}>Remove claim</button>
      </div>)}
      <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
        onClick={() => editBody({ ...body, claims: [...body.claims, { ref: `c${body.claims.length + 1}`, text: '', kind: 'hypothesis' }] })}>Add claim</button>

      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Open questions (one per line)
        <textarea className="input text-chat-body" aria-label="Open questions" placeholder="What is not decided yet" {...lines('openQuestions')} /></label>

      <h5 className="mt-1 font-medium text-chat-body" {...(sectionAnchors ? { id: 'draft-section-decisions' } : {})}>Decisions</h5>
      <DecisionsEditor body={body} connected={connected} setBody={editBody} />

      <label className="flex flex-col gap-1 text-chat-meta text-secondary">Impact proposal (for material direction changes)
        <textarea className="input text-chat-body" aria-label="Impact proposal" placeholder="What this change to purpose, users, or non-goals would affect" value={impact} disabled={!connected}
          onChange={event => editImpact(event.target.value)} /></label>
    </div>

    {(localError || error) && <p role="alert" data-testid="draft-error" className="mt-2 text-chat-meta text-chat-danger">{localError ?? error}</p>}
    {conflict && <div className="mt-2 border border-border p-2 text-chat-meta text-secondary" data-testid="draft-conflict">
      <p>Stored draft (changed while you edited — hash {conflict.contentHash.slice(0, 8)}…, updated {conflict.updatedAt}):</p>
      <p className="mt-1 whitespace-pre-wrap">{conflict.content.purpose || '(empty purpose)'}</p>
    </div>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn btn-primary text-chat-meta" disabled={!connected || busy} data-testid="draft-save" onClick={save}>Save draft</button>
      {(draft || conflict) && <button type="button" className="btn text-chat-meta" disabled={!connected} onClick={reload}>Reload stored draft</button>}
    </div>
  </section>
}

function DecisionsEditor({ body, connected, setBody }: {
  body: StrategyContent
  connected: boolean
  setBody: (next: StrategyContent) => void
}) {
  return <>
    {body.decisions.map((decision, index) => <div key={index} data-testid="decision" className="flex flex-col gap-1 border border-border p-2">
      <div className="grid grid-cols-3 gap-1">
        <input className="col-span-2 input text-chat-body" aria-label="Decision" placeholder="Decision" value={decision.decision} disabled={!connected}
          onChange={event => setBody({ ...body, decisions: body.decisions.map((entry, at) => at === index ? { ...entry, decision: event.target.value } : entry) })} />
        <input className="input text-chat-body" aria-label="Decision date" placeholder="Date" value={decision.date ?? ''} disabled={!connected}
          onChange={event => setBody({ ...body, decisions: body.decisions.map((entry, at) => at === index ? { ...entry, date: event.target.value } : entry) })} />
      </div>
      <input className="input text-chat-body" aria-label="Decision rationale" placeholder="Rationale" value={decision.rationale ?? ''} disabled={!connected}
        onChange={event => setBody({ ...body, decisions: body.decisions.map((entry, at) => at === index ? { ...entry, rationale: event.target.value } : entry) })} />
      <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
        onClick={() => setBody({ ...body, decisions: body.decisions.filter((_entry, at) => at !== index) })}>Remove decision</button>
    </div>)}
    <button type="button" className="btn self-start text-chat-meta" disabled={!connected}
      onClick={() => setBody({ ...body, decisions: [...body.decisions, { ref: `d${body.decisions.length + 1}`, decision: '' }] })}>Add decision</button>
  </>
}

const USE_CASE_PLACEHOLDERS: Record<string, string> = {
  userOrSituation: 'User or situation',
  trigger: 'Trigger',
  wantedOutcome: 'Wanted outcome',
  currentObstacle: 'Current obstacle',
  desiredExperience: 'Desired experience',
  successSignal: 'Success signal',
  constraints: 'Constraints',
}

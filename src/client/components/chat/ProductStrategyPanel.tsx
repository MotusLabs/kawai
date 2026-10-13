// The product strategy view (product-strategy 5.1/5.3): a product's
// strategy at product/repository scope in the ChatView side slot, scoped
// by the session's team. Direction leads — purpose, users, outcomes, use
// cases, trade-offs, boundaries — with revision/hash/owner/status in
// supporting detail; review separates what is known, assumed, and not
// decided; approve names the exact revision and hash with scope and open
// questions. A product with no record offers capture, never a forced
// wizard (S11). Every control disables while disconnected; refusals and
// stale errors show inline.
import { useMemo, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { StrategyDetail, StrategyRevision } from '@shared/productStrategy'
import { REVISION_STATUS_LABELS, actorLabel, shortHash } from './strategyLabels'
import StrategyDraftEditor from './StrategyDraftEditor'
import StrategyRevisionHistory from './StrategyRevisionHistory'
import { useSessionStore } from '../../stores/sessionStore'
import { useStrategyStore, type StrategyView } from '../../stores/strategyStore'

const DIRECTION_SECTIONS = ['purpose', 'primaryUsers', 'needsOutcomes', 'productApproach'] as const

export default function ProductStrategyPanel({ sessionId, view, sendMessage, connected, onClose }: {
  sessionId: string; view: StrategyView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
}) {
  const sessions = useSessionStore(state => state.sessions)
  const [capture, setCapture] = useState({ productId: '', title: '', purpose: '' })
  const busy = Object.keys(view.pending).length > 0
  const detail = view.detail
  const approved = useMemo(() => {
    if (!detail) return null
    return detail.strategy.currentApprovedRevision != null
      ? detail.revisions.find(revision => revision.revision === detail.strategy.currentApprovedRevision) ?? null
      : null
  }, [detail])
  const leading = approved ?? (detail ? [...detail.revisions].filter(revision => revision.status === 'in_review').at(-1) ?? null : null)

  const request = (message: Parameters<SendClientMessage>[0], action: 'save' | 'submit' | 'approve' | 'withdraw') => {
    if (!('requestId' in message)) return
    useStrategyStore.getState().begin(sessionId, message.requestId, action)
    sendMessage(message)
  }
  const withdrawRevision = (revision: number) => {
    request({ type: 'strategy-withdraw', sessionId, requestId: crypto.randomUUID(), revision, commandId: crypto.randomUUID() }, 'withdraw')
  }

  return <aside data-testid="product-strategy" className="flex min-h-0 w-full flex-col border-l border-border md:w-[28rem]">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Product Strategy</h3>
      <button className="btn" onClick={onClose}>Close strategy</button></header>
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update the strategy.</p>}
    {view.loading && <p role="status" className="p-3">Loading strategy…</p>}
    {view.error && <p role="alert" data-testid="strategy-error" className="border-b border-border p-3 text-chat-meta text-chat-danger">{view.error}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {!view.seen ? <p className="text-chat-meta text-secondary">Loading…</p> : !detail ? <CaptureForm capture={capture} setCapture={setCapture} connected={connected} busy={busy}
        onCapture={() => {
          request({
            type: 'strategy-save-draft', sessionId, requestId: crypto.randomUUID(),
            productId: capture.productId.trim(), title: capture.title.trim(), content: { purpose: capture.purpose.trim() },
            expectedDraftHash: null,
          }, 'save')
          setCapture({ productId: '', title: '', purpose: '' })
        }} /> : <>
        {/* Supporting detail: the record's identity and exact approved state. */}
        <p className="text-chat-meta text-secondary" data-testid="strategy-record">
          {detail.strategy.title} ({detail.strategy.productId}) · owner {actorLabel(detail.strategy.owner, sessions)}
        </p>
        <p className="text-chat-meta text-secondary" data-testid="strategy-status">
          {approved
            ? `Approved revision ${approved.revision} by ${actorLabel(approved.author, sessions)} · ${shortHash(approved.contentHash)} · ${REVISION_STATUS_LABELS.approved}`
            : 'No approved revision yet — the product is unassessed until one is approved'}
        </p>

        {/* Direction leads (spec: purpose, users, outcomes, use cases,
            trade-offs, boundaries first). */}
        <section data-testid="strategy-direction" className="mt-3">
          {!leading && <p className="text-chat-meta text-secondary">No revision content yet — capture direction in a draft below.</p>}
          {leading && <>
            {leading.revision !== approved?.revision && <p className="text-chat-meta text-secondary">(showing revision {leading.revision}, in review — not approved)</p>}
            {DIRECTION_SECTIONS.map(section => <DirectionRow key={section} label={SECTION_LABELS[section]} value={leading.content[section]} />)}
            <DirectionRow label="Main use cases" value={leading.content.useCases.map(useCase => `${useCase.userOrSituation}: ${useCase.trigger} → ${useCase.wantedOutcome} (obstacle: ${useCase.currentObstacle})`).join('\n')} />
            <DirectionRow label="Principles and trade-offs" value={leading.content.principles.map(principle => `${principle.principle} — trade-off: ${principle.tradeoff || 'not stated'}`).join('\n')} />
            <DirectionRow label="Boundaries and non-goals" value={leading.content.boundaries.join('\n')} />
          </>}
        </section>

        {detail.revisions.filter(revision => revision.status === 'in_review').map(revision => <ReviewSection key={revision.revision} revision={revision} detail={detail}
          connected={connected} busy={busy} request={request} sessionId={sessionId} />)}

        <StrategyDraftEditor
          draft={detail.drafts.find(draft => draft.draftId === 'human') ?? null}
          connected={connected} busy={busy}
          error={view.pending && Object.values(view.pending).includes('save') ? null : view.error}
          conflict={view.conflict}
          onReload={() => useStrategyStore.getState().adoptConflict(sessionId)}
          onSave={payload => request({
            type: 'strategy-save-draft', sessionId, requestId: crypto.randomUUID(),
            content: payload.content, impactProposal: payload.impactProposal ?? undefined,
            expectedDraftHash: payload.expectedDraftHash, expectedBaseRevision: payload.expectedBaseRevision,
          }, 'save')} />
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn text-chat-meta" disabled={!connected || busy} data-testid="strategy-submit"
            onClick={() => request({ type: 'strategy-submit', sessionId, requestId: crypto.randomUUID() }, 'submit')}>Submit draft for review</button>
          {detail.drafts.find(draft => draft.draftId === 'human') && connected && <button type="button" className="btn text-chat-meta" disabled={busy}
            data-testid="strategy-withdraw-draft"
            onClick={() => request({ type: 'strategy-withdraw', sessionId, requestId: crypto.randomUUID(), draftId: 'human', commandId: crypto.randomUUID() }, 'withdraw')}>Withdraw draft</button>}
        </div>

        <StrategyRevisionHistory detail={detail} sessions={sessions} connected={connected} busy={busy} onWithdrawRevision={withdrawRevision} />
      </>}
    </div>
  </aside>
}

/** Review of one InReview revision: findings by knowledge state, and the human Approve control (5.3). */
function ReviewSection({ revision, detail, connected, busy, request, sessionId }: {
  revision: StrategyRevision
  detail: StrategyDetail
  connected: boolean
  busy: boolean
  request: (message: Parameters<SendClientMessage>[0], action: 'save' | 'submit' | 'approve' | 'withdraw') => void
  sessionId: string
}) {
  // One command id per (revision, dialog) — a retry after a refusal reuses
  // it, which is what makes the server's replay the intended path.
  const [commandId] = useState(() => crypto.randomUUID())
  const [scope, setScope] = useState('')
  const [openQuestions, setOpenQuestions] = useState('')
  const known = revision.content.claims.filter(claim => claim.kind === 'validated_observation' || claim.kind === 'explicit_user_statement')
  const assumed = revision.content.claims.filter(claim => claim.kind === 'hypothesis' || claim.kind === 'agent_interpretation' || claim.kind === 'proposed_choice' || claim.kind === 'owner_preference')
  const diff = detail.strategy.currentApprovedRevision != null
    ? detail.revisions.find(candidate => candidate.revision === detail.strategy.currentApprovedRevision)
    : null
  return <section data-testid={`strategy-review-${revision.revision}`} className="mt-3 border border-border p-2">
    <h4 className="font-medium">Review revision {revision.revision}</h4>
    <p className="text-chat-meta text-secondary">Content hash {revision.contentHash}</p>
    {diff && <DiffSummary from={diff} to={revision} />}
    <div className="mt-2 space-y-1 text-chat-meta text-secondary">
      <p data-testid="review-known"><span className="font-medium text-primary">Known:</span> {known.length > 0 ? known.map(claim => claim.text).join('; ') : 'nothing validated yet'}</p>
      <p data-testid="review-assumed"><span className="font-medium text-primary">Assumed:</span> {assumed.length > 0 ? assumed.map(claim => `${claim.text} [${claim.kind}]`).join('; ') : 'no assumptions recorded'}</p>
      <p data-testid="review-not-decided"><span className="font-medium text-primary">Not decided:</span> {revision.content.openQuestions.length > 0 ? revision.content.openQuestions.join('; ') : 'no open questions'}</p>
    </div>
    <div className="mt-2 flex flex-col gap-1">
      <input className="input text-chat-body" aria-label="Approval scope" placeholder="Approval scope (what this approval covers)" value={scope} disabled={!connected}
        onChange={event => setScope(event.target.value)} />
      <input className="input text-chat-body" aria-label="Allowed open questions" placeholder="Allowed open questions (with rationale)" value={openQuestions} disabled={!connected}
        onChange={event => setOpenQuestions(event.target.value)} />
      <button type="button" className="btn btn-primary self-start text-chat-meta" disabled={!connected || busy} data-testid={`approve-${revision.revision}`}
        onClick={() => request({
          type: 'strategy-approve', sessionId, requestId: crypto.randomUUID(),
          revision: revision.revision, contentHash: revision.contentHash, commandId,
          expectedCurrentRevision: detail.strategy.currentApprovedRevision,
          ...(scope.trim() ? { approvalScope: scope.trim() } : {}),
          ...(openQuestions.trim() ? { openQuestions: openQuestions.trim() } : {}),
        }, 'approve')}>
        Approve revision {revision.revision}
      </button>
    </div>
  </section>
}

/** Which direction fields differ from the approved revision — the exact change being approved. */
function DiffSummary({ from, to }: { from: StrategyRevision; to: StrategyRevision }) {
  const changed = DIRECTION_SECTIONS.filter(section => from.content[section] !== to.content[section])
  const fields = [
    ...changed.map(section => SECTION_LABELS[section]),
    ...(from.content.boundaries.join('|') !== to.content.boundaries.join('|') ? ['boundaries'] : []),
    ...(from.content.useCases.length !== to.content.useCases.length ? [`use cases (${from.content.useCases.length} → ${to.content.useCases.length})`] : []),
    ...(from.content.principles.length !== to.content.principles.length ? [`principles (${from.content.principles.length} → ${to.content.principles.length})`] : []),
  ]
  return <p className="text-chat-meta text-secondary" data-testid="review-diff">
    Diff from approved revision {from.revision}: {fields.length > 0 ? fields.join(', ') : 'no direction changes'}
  </p>
}

function CaptureForm({ capture, setCapture, connected, busy, onCapture }: {
  capture: { productId: string; title: string; purpose: string }
  setCapture: React.Dispatch<React.SetStateAction<{ productId: string; title: string; purpose: string }>>
  connected: boolean
  busy: boolean
  onCapture: () => void
}) {
  const field = (key: keyof typeof capture) => ({
    value: capture[key], disabled: !connected,
    onChange: (event: { target: { value: string } }) => setCapture(current => ({ ...current, [key]: event.target.value })),
  })
  return <section data-testid="strategy-capture" className="border border-border p-2">
    <h4 className="font-medium">No strategy record for this product</h4>
    <p className="mt-1 text-chat-meta text-secondary">Work proceeds without one. To start capturing direction, record the product and its purpose — this creates the record with you as owner.</p>
    <div className="mt-2 flex flex-col gap-2">
      <input className="input text-chat-body" aria-label="Product id" placeholder="Product id (e.g. kawai)" {...field('productId')} />
      <input className="input text-chat-body" aria-label="Product title" placeholder="Title" {...field('title')} />
      <textarea className="input min-h-16 text-chat-body" aria-label="Initial purpose" placeholder="Purpose — why this product exists" {...field('purpose')} />
      <button type="button" className="btn btn-primary self-start text-chat-meta" disabled={!connected || busy || !capture.productId.trim() || !capture.title.trim()}
        data-testid="capture-create" onClick={onCapture}>
        Capture product strategy
      </button>
    </div>
  </section>
}

function DirectionRow({ label, value }: { label: string; value: string }) {
  return <div className="mt-1">
    <h5 className="text-chat-meta font-medium text-secondary">{label}</h5>
    <p className="whitespace-pre-wrap text-chat-body" data-testid="direction-text">{value || '(explicitly empty)'}</p>
  </div>
}

const SECTION_LABELS: Record<(typeof DIRECTION_SECTIONS)[number], string> = {
  purpose: 'Purpose',
  primaryUsers: 'Primary users',
  needsOutcomes: 'Needs and outcomes',
  productApproach: 'Product approach',
}

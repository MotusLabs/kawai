// The Strategy tab's sub-views (team-workspace-pages 5.2, D5): an overview
// where direction leads and every other section starts collapsed, a review
// of one revision in review with the diff beside the findings and the
// approve/withdraw controls underneath, the draft editor with a section
// list beside it (unsaved text retained per team in strategyStore), and the
// revision history. A team with no record offers capture in the overview
// (S11). Every existing strategy action and its human-only approval rule
// stays (product-strategy 5.1–5.3).
import { useEffect, useMemo, useState } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { StrategyDetail, StrategyRevision } from '@shared/productStrategy'
import { REVISION_STATUS_LABELS, actorLabel, shortHash } from '../chat/strategyLabels'
import StrategyDraftEditor from './StrategyDraftEditor'
import StrategyRevisionHistory from './StrategyRevisionHistory'
import { useSessionStore } from '../../stores/sessionStore'
import { useStrategyStore, type StrategyAction, type StrategyView } from '../../stores/strategyStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import type { StrategySubView } from '../../utils/teamLocation'

const DIRECTION_SECTIONS = ['purpose', 'primaryUsers', 'needsOutcomes', 'productApproach'] as const

const SECTION_LABELS: Record<(typeof DIRECTION_SECTIONS)[number], string> = {
  purpose: 'Purpose',
  primaryUsers: 'Primary users',
  needsOutcomes: 'Needs and outcomes',
  productApproach: 'Product approach',
}

/** Overview sections that start collapsed (team-workspace-pages 5.2). */
const OVERVIEW_DEFAULT_COLLAPSED = ['Success measures', 'Assumptions and evidence', 'Open questions', 'Decisions']
const OVERVIEW_DEFAULTS_APPLIED = '#strategy-overview-defaults'

export default function ProductStrategyView({ teamPath, view, sendMessage, connected, sub, revision, onNavigate }: {
  teamPath: string
  view: StrategyView
  sendMessage: SendClientMessage
  connected: boolean
  /** The Strategy sub-view; the Team page passes the URL's, a host without one keeps its own. */
  sub?: StrategySubView
  /** The review's revision number, from the URL. */
  revision?: string
  /** Reports sub-view moves so the host can push the location (D3). */
  onNavigate?: (next: { sub: StrategySubView; revision?: number }) => void
}) {
  const sessions = useSessionStore(state => state.sessions)
  // A host without the URL keeps its own sub-view route, revision included,
  // so its Review buttons open the revision they name.
  const [localRoute, setLocalRoute] = useState<{ sub: StrategySubView; revision?: number }>({ sub: sub ?? 'overview' })
  const activeSub = onNavigate ? (sub ?? 'overview') : localRoute.sub
  const activeRevision = onNavigate ? revision : localRoute.revision !== undefined ? String(localRoute.revision) : revision
  const goto = (next: { sub: StrategySubView; revision?: number }) => {
    if (onNavigate) onNavigate(next)
    else setLocalRoute({ sub: next.sub, ...(next.revision !== undefined ? { revision: next.revision } : {}) })
  }
  const [capture, setCapture] = useState({ productId: '', title: '', purpose: '' })
  const busy = Object.keys(view.pending).length > 0
  const detail = view.detail
  const inReview = useMemo(() => detail ? detail.revisions.filter(entry => entry.status === 'in_review') : [], [detail])

  const request = (message: Parameters<SendClientMessage>[0], action: StrategyAction) => {
    if (!('requestId' in message)) return
    useStrategyStore.getState().begin(teamPath, message.requestId, action)
    sendMessage(message)
  }
  const withdrawRevision = (target: number) => {
    request({ type: 'strategy-withdraw', teamPath, requestId: crypto.randomUUID(), revision: target, commandId: crypto.randomUUID() }, 'withdraw')
  }

  return <div data-testid="product-strategy" className="flex h-full min-h-0 flex-col">
    {view.error && <p role="alert" data-testid="strategy-error" className="border-b border-border p-3 text-sm text-danger">{view.error}</p>}
    <nav aria-label="Strategy views" className="flex flex-wrap gap-1 border-b border-border px-3 py-2" data-testid="strategy-subnav">
      <button type="button" className={`btn text-sm ${activeSub === 'overview' ? 'btn-primary' : ''}`} data-testid="strategy-sub-overview"
        onClick={() => goto({ sub: 'overview' })}>Overview</button>
      {inReview.map(entry => <button key={entry.revision} type="button"
        className={`btn text-sm ${activeSub === 'review' && activeRevision === String(entry.revision) ? 'btn-primary' : ''}`}
        data-testid={`strategy-sub-review-${entry.revision}`}
        onClick={() => goto({ sub: 'review', revision: entry.revision })}>Review {entry.revision}</button>)}
      <button type="button" className={`btn text-sm ${activeSub === 'draft' ? 'btn-primary' : ''}`} data-testid="strategy-sub-draft"
        onClick={() => goto({ sub: 'draft' })}>Draft</button>
      <button type="button" className={`btn text-sm ${activeSub === 'history' ? 'btn-primary' : ''}`} data-testid="strategy-sub-history"
        onClick={() => goto({ sub: 'history' })}>History</button>
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {!view.seen ? <p className="text-sm text-secondary">Loading…</p> : !detail ? (
        activeSub === 'overview'
          ? <CaptureForm capture={capture} setCapture={setCapture} connected={connected} busy={busy} onCapture={() => {
              request({
                type: 'strategy-save-draft', teamPath, requestId: crypto.randomUUID(),
                productId: capture.productId.trim(), title: capture.title.trim(), content: { purpose: capture.purpose.trim() },
                expectedDraftHash: null,
              }, 'save')
              setCapture({ productId: '', title: '', purpose: '' })
            }} />
          : <p className="text-sm text-secondary">No strategy record — capture one from the overview.</p>
      ) : <>
        {activeSub === 'overview' && <Overview detail={detail} sessions={sessions} teamPath={teamPath} />}
        {activeSub === 'review' && <Review detail={detail} sessions={sessions} connected={connected} busy={busy}
          request={request} teamPath={teamPath} revisionNumber={activeRevision} onWithdrawRevision={withdrawRevision} />}
        {activeSub === 'draft' && <DraftSubView detail={detail} view={view} teamPath={teamPath} connected={connected} busy={busy} request={request} />}
        {activeSub === 'history' && <StrategyRevisionHistory detail={detail} sessions={sessions} connected={connected} busy={busy} onWithdrawRevision={withdrawRevision} />}
      </>}
    </div>
  </div>
}

/** Direction leads; every other section starts collapsed and expands on its own (5.2). */
function Overview({ detail, sessions, teamPath }: { detail: StrategyDetail; sessions: Session[]; teamPath: string }) {
  const collapsed = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.strategy.collapsedSections) ?? []
  // Seed the default collapsed sections once per team, like the Mailbox's.
  useEffect(() => {
    if (!collapsed.includes(OVERVIEW_DEFAULTS_APPLIED)) {
      useTeamWorkspaceStore.getState().setCollapsedSections(teamPath, 'strategy', [OVERVIEW_DEFAULTS_APPLIED, ...OVERVIEW_DEFAULT_COLLAPSED])
    }
  }, [teamPath, collapsed]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (section: string) => useTeamWorkspaceStore.getState().toggleSectionCollapsed(teamPath, 'strategy', section)
  const sectionCollapsed = (section: string) => collapsed.includes(section)

  const approved = detail.strategy.currentApprovedRevision != null
    ? detail.revisions.find(entry => entry.revision === detail.strategy.currentApprovedRevision) ?? null
    : null
  const leading = approved ?? [...detail.revisions].filter(entry => entry.status === 'in_review').at(-1) ?? null
  const section = (label: string, body: React.ReactNode, testId: string) => <section data-testid={testId} className="mt-3">
    <button type="button" className="btn text-sm font-medium" aria-expanded={!sectionCollapsed(label)}
      data-testid={`strategy-section-toggle-${label}`} onClick={() => toggle(label)}>
      {sectionCollapsed(label) ? '▸' : '▾'} {label}
    </button>
    {!sectionCollapsed(label) && body}
  </section>

  return <div>
    {/* Supporting detail: the record's identity and exact approved state. */}
    <p className="text-sm text-secondary" data-testid="strategy-record">
      {detail.strategy.title} ({detail.strategy.productId}) · owner {actorLabel(detail.strategy.owner, sessions)}
    </p>
    <p className="text-sm text-secondary" data-testid="strategy-status">
      {approved
        ? `Approved revision ${approved.revision} by ${actorLabel(approved.author, sessions)} · ${shortHash(approved.contentHash)} · ${REVISION_STATUS_LABELS.approved}`
        : 'No approved revision yet — the product is unassessed until one is approved'}
    </p>
    <section data-testid="strategy-direction" className="mt-3">
      {!leading && <p className="text-sm text-secondary">No revision content yet — capture direction in the draft.</p>}
      {leading && <>
        {leading.revision !== approved?.revision && <p className="text-sm text-secondary">(showing revision {leading.revision}, in review — not approved)</p>}
        {DIRECTION_SECTIONS.map(key => <DirectionRow key={key} label={SECTION_LABELS[key]} value={leading.content[key]} />)}
        <DirectionRow label="Main use cases" value={leading.content.useCases.map(useCase => `${useCase.userOrSituation}: ${useCase.trigger} → ${useCase.wantedOutcome} (obstacle: ${useCase.currentObstacle})`).join('\n')} />
        <DirectionRow label="Principles and trade-offs" value={leading.content.principles.map(principle => `${principle.principle} — trade-off: ${principle.tradeoff || 'not stated'}`).join('\n')} />
        <DirectionRow label="Boundaries and non-goals" value={leading.content.boundaries.join('\n')} />
      </>}
    </section>
    {section('Success measures', <ul className="mt-1 list-disc pl-4 text-sm text-secondary">
      {leading?.content.successMeasures.map((measure, index) => <li key={index} data-testid="overview-measure">
        {measure.outcome} — {measure.measure} · baseline {measure.baseline} · target {measure.target}
      </li>)}
    </ul>, 'strategy-overview-measures')}
    {section('Assumptions and evidence', <ul className="mt-1 list-disc pl-4 text-sm text-secondary">
      {leading?.content.claims.map((claim, index) => <li key={index} data-testid="overview-claim">
        {claim.text} [{claim.kind}]{claim.source ? ` · source: ${claim.source}` : ''}
      </li>)}
    </ul>, 'strategy-overview-claims')}
    {section('Open questions', <ul className="mt-1 list-disc pl-4 text-sm text-secondary">
      {(leading?.content.openQuestions ?? []).map((question, index) => <li key={index}>{question}</li>)}
    </ul>, 'strategy-overview-questions')}
    {section('Decisions', <ul className="mt-1 list-disc pl-4 text-sm text-secondary">
      {(leading?.content.decisions ?? []).map((decision, index) => <li key={index}>{decision.decision}{decision.date ? ` (${decision.date})` : ''}</li>)}
    </ul>, 'strategy-overview-decisions')}
  </div>
}

/** The review of one in-review revision: diff beside findings, approve controls below (5.2). */
function Review({ detail, sessions, connected, busy, request, teamPath, revisionNumber, onWithdrawRevision }: {
  detail: StrategyDetail
  sessions: Session[]
  connected: boolean
  busy: boolean
  request: (message: Parameters<SendClientMessage>[0], action: StrategyAction) => void
  teamPath: string
  revisionNumber?: string
  onWithdrawRevision: (revision: number) => void
}) {
  const inReview = detail.revisions.filter(entry => entry.status === 'in_review')
  const wanted = revisionNumber !== undefined ? Number(revisionNumber) : NaN
  const revision = inReview.find(entry => entry.revision === wanted) ?? inReview.at(-1) ?? null
  if (!revision) return <p className="text-sm text-secondary" data-testid="strategy-review-none">No revision is in review.</p>
  // Keyed by the revision: moving to another review is a new dialog, with
  // its own command id and its own scope inputs (one command id per dialog,
  // so a retry replays — product-strategy 5.3).
  return <ReviewBody key={revision.revision} revision={revision} detail={detail} sessions={sessions}
    connected={connected} busy={busy} request={request} teamPath={teamPath} onWithdrawRevision={onWithdrawRevision} />
}

function ReviewBody({ revision, detail, sessions, connected, busy, request, teamPath, onWithdrawRevision }: {
  revision: StrategyRevision
  detail: StrategyDetail
  sessions: Session[]
  connected: boolean
  busy: boolean
  request: (message: Parameters<SendClientMessage>[0], action: StrategyAction) => void
  teamPath: string
  onWithdrawRevision: (revision: number) => void
}) {
  const known = revision.content.claims.filter(claim => claim.kind === 'validated_observation' || claim.kind === 'explicit_user_statement')
  const assumed = revision.content.claims.filter(claim => claim.kind === 'hypothesis' || claim.kind === 'agent_interpretation' || claim.kind === 'proposed_choice' || claim.kind === 'owner_preference')
  const diff = detail.strategy.currentApprovedRevision != null
    ? detail.revisions.find(entry => entry.revision === detail.strategy.currentApprovedRevision)
    : null
  // One command id per (revision, dialog) — a retry reuses it, so the server replays.
  const [commandId] = useState(() => crypto.randomUUID())
  const [scope, setScope] = useState('')
  const [openQuestions, setOpenQuestions] = useState('')
  return <section data-testid={`strategy-review-${revision.revision}`}>
    <h3 className="font-medium">Review revision {revision.revision}</h3>
    <p className="text-sm text-secondary">Content hash {revision.contentHash} · author {actorLabel(revision.author, sessions)}</p>
    <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
      <div data-testid="review-diff-column">
        {diff ? <DiffSummary from={diff} to={revision} /> : <p className="text-sm text-secondary">No approved revision yet — this is the first.</p>}
        <div className="mt-2 space-y-1">
          {DIRECTION_SECTIONS.map(key => <DirectionRow key={key} label={SECTION_LABELS[key]} value={revision.content[key]} />)}
        </div>
      </div>
      <div className="space-y-1 text-sm text-secondary">
        <p data-testid="review-known"><span className="font-medium text-primary">Known:</span> {known.length > 0 ? known.map(claim => claim.text).join('; ') : 'nothing validated yet'}</p>
        <p data-testid="review-assumed"><span className="font-medium text-primary">Assumed:</span> {assumed.length > 0 ? assumed.map(claim => `${claim.text} [${claim.kind}]`).join('; ') : 'no assumptions recorded'}</p>
        <p data-testid="review-not-decided"><span className="font-medium text-primary">Not decided:</span> {revision.content.openQuestions.length > 0 ? revision.content.openQuestions.join('; ') : 'no open questions'}</p>
      </div>
    </div>
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3" data-testid="review-footer">
      <input className="input" aria-label="Approval scope" placeholder="Approval scope (what this approval covers)" value={scope} disabled={!connected}
        onChange={event => setScope(event.target.value)} />
      <input className="input" aria-label="Allowed open questions" placeholder="Allowed open questions (with rationale)" value={openQuestions} disabled={!connected}
        onChange={event => setOpenQuestions(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={!connected || busy} data-testid={`approve-${revision.revision}`}
          onClick={() => request({
            type: 'strategy-approve', teamPath, requestId: crypto.randomUUID(),
            revision: revision.revision, contentHash: revision.contentHash, commandId,
            expectedCurrentRevision: detail.strategy.currentApprovedRevision,
            ...(scope.trim() ? { approvalScope: scope.trim() } : {}),
            ...(openQuestions.trim() ? { openQuestions: openQuestions.trim() } : {}),
          }, 'approve')}>
          Approve revision {revision.revision}
        </button>
        <button type="button" className="btn" disabled={!connected || busy} data-testid={`withdraw-${revision.revision}`}
          onClick={() => onWithdrawRevision(revision.revision)}>Withdraw</button>
      </div>
    </div>
  </section>
}

/** The draft editor with its section list, kept text, and submit/withdraw (5.2). */
function DraftSubView({ detail, view, teamPath, connected, busy, request }: {
  detail: StrategyDetail
  view: StrategyView
  teamPath: string
  connected: boolean
  busy: boolean
  request: (message: Parameters<SendClientMessage>[0], action: StrategyAction) => void
}) {
  const retained = view.retained
  const retain = useStrategyStore.getState().retainDraft
  return <div className="flex flex-col gap-3 md:flex-row" data-testid="strategy-draft-subview">
    <nav aria-label="Draft sections" data-testid="strategy-draft-sections" className="md:w-48 md:shrink-0">
      <ul className="list-disc pl-4 text-sm text-secondary">
        {DRAFT_SECTION_LIST.map(entry => <li key={entry.id}>
          <button type="button" className="underline-offset-2 hover:underline"
            onClick={() => {
              const target = typeof document === 'undefined' ? null : document.getElementById(`draft-section-${entry.id}`)
              target?.scrollIntoView?.({ block: 'start' })
            }}>
            {entry.label}
          </button>
        </li>)}
      </ul>
    </nav>
    <div className="min-w-0 flex-1">
      <StrategyDraftEditor
        draft={detail.drafts.find(draft => draft.draftId === 'human') ?? null}
        connected={connected} busy={busy} sectionAnchors
        error={view.pending && Object.values(view.pending).includes('save') ? null : view.error}
        conflict={view.conflict}
        retained={retained} onRetain={next => retain(teamPath, next)}
        onReload={() => useStrategyStore.getState().adoptConflict(teamPath)}
        onSave={payload => request({
          type: 'strategy-save-draft', teamPath, requestId: crypto.randomUUID(),
          content: payload.content, impactProposal: payload.impactProposal ?? undefined,
          expectedDraftHash: payload.expectedDraftHash, expectedBaseRevision: payload.expectedBaseRevision,
        }, 'save')} />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn text-sm" disabled={!connected || busy} data-testid="strategy-submit"
          onClick={() => request({ type: 'strategy-submit', teamPath, requestId: crypto.randomUUID() }, 'submit')}>Submit draft for review</button>
        {detail.drafts.find(draft => draft.draftId === 'human') && connected && <button type="button" className="btn text-sm" disabled={busy}
          data-testid="strategy-withdraw-draft"
          onClick={() => request({ type: 'strategy-withdraw', teamPath, requestId: crypto.randomUUID(), draftId: 'human', commandId: crypto.randomUUID() }, 'withdraw')}>Withdraw draft</button>}
      </div>
    </div>
  </div>
}

const DRAFT_SECTION_LIST = [
  { id: 'purpose', label: 'Purpose' },
  { id: 'primaryUsers', label: 'Primary users' },
  { id: 'needsOutcomes', label: 'Needs and outcomes' },
  { id: 'useCases', label: 'Main use cases' },
  { id: 'principles', label: 'Principles and trade-offs' },
  { id: 'successMeasures', label: 'Success measures' },
  { id: 'claims', label: 'Assumptions and evidence' },
  { id: 'decisions', label: 'Decisions' },
] as const

/** Which direction fields differ from the approved revision — the exact change being approved. */
function DiffSummary({ from, to }: { from: StrategyRevision; to: StrategyRevision }) {
  const changed = DIRECTION_SECTIONS.filter(key => from.content[key] !== to.content[key])
  const fields = [
    ...changed.map(key => SECTION_LABELS[key]),
    ...(from.content.boundaries.join('|') !== to.content.boundaries.join('|') ? ['boundaries'] : []),
    ...(from.content.useCases.length !== to.content.useCases.length ? [`use cases (${from.content.useCases.length} → ${to.content.useCases.length})`] : []),
    ...(from.content.principles.length !== to.content.principles.length ? [`principles (${from.content.principles.length} → ${to.content.principles.length})`] : []),
  ]
  return <p className="text-sm text-secondary" data-testid="review-diff">
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
    <p className="mt-1 text-sm text-secondary">Work proceeds without one. To start capturing direction, record the product and its purpose — this creates the record with you as owner.</p>
    <div className="mt-2 flex flex-col gap-2">
      <input className="input" aria-label="Product id" placeholder="Product id (e.g. kawai)" {...field('productId')} />
      <input className="input" aria-label="Product title" placeholder="Title" {...field('title')} />
      <textarea className="input min-h-16" aria-label="Initial purpose" placeholder="Purpose — why this product exists" {...field('purpose')} />
      <button type="button" className="btn btn-primary self-start" disabled={!connected || busy || !capture.productId.trim() || !capture.title.trim()}
        data-testid="capture-create" onClick={onCapture}>
        Capture product strategy
      </button>
    </div>
  </section>
}

function DirectionRow({ label, value }: { label: string; value: string }) {
  return <div className="mt-1">
    <h5 className="text-sm font-medium text-secondary">{label}</h5>
    <p className="whitespace-pre-wrap" data-testid="direction-text">{value || '(explicitly empty)'}</p>
  </div>
}

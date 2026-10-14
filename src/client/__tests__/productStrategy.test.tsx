// Product strategy UI (product-strategy 5.1–5.3): the store's snapshots,
// the capture affordance (offered, never forced), direction leading the
// approved view, the draft editor's claim labels and Unknown measures with
// retained text on a CAS refusal (S12), the review/approve/submit/withdraw
// controls and their disconnected states, and superseded/withdrawn
// revisions staying accessible in history.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import type { ProductStrategy, StrategyDetail, StrategyDraft } from '@shared/productStrategy'
import { UNKNOWN, normalizeStrategyContent } from '@shared/productStrategy'

/** Opaque fixture hash — the components display and echo hashes, never compute them. */
const hashOf = (seed: string): string => `h-${seed.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`
import ProductStrategyPanel from '../components/chat/ProductStrategyPanel'
import { useSessionStore } from '../stores/sessionStore'
import { useStrategyStore, closedStrategyView } from '../stores/strategyStore'

afterEach(() => {
  useStrategyStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [] })
})

const sessionRow = (id: string, name: string) => ({ id, name, projectPath: '/repo', status: 'waiting', lastActivity: '', lastActivityAt: '', createdAt: '', source: 'managed', kind: 'chat' } as Session)

const strategy = (extra: Partial<ProductStrategy> = {}): ProductStrategy => ({
  id: 'strategy-1', productId: 'kawai', title: 'Kawai', owner: { kind: 'human', sessionId: null }, lifecycle: 'active',
  currentApprovedRevision: 2,
  repoBindings: [{ root: '/repo/.git', kind: 'team' }, { root: '/repo', kind: 'worktree' }],
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...extra,
})

const content = (overrides: Record<string, unknown> = {}) => normalizeStrategyContent({
  purpose: 'Supervised autonomous development',
  primaryUsers: 'Small platform teams',
  needsOutcomes: 'Ship without babysitting agents',
  productApproach: 'One operator directing a team of agents',
  useCases: [{ userOrSituation: 'lead', trigger: 'task', wantedOutcome: 'lands reviewed', currentObstacle: 'queue', desiredExperience: 'agents draft', successSignal: 'latency', constraints: 'no force-push' }],
  principles: [{ principle: 'runtime records', tradeoff: 'slower' }],
  boundaries: ['no cross-repo'],
  successMeasures: [{ outcome: 'stability', measure: 'revisions/month', baseline: UNKNOWN, target: UNKNOWN }],
  claims: [
    { text: 'leads want gates', kind: 'owner_preference' },
    { text: 'demand grows 20% monthly', kind: 'hypothesis', limitations: 'no data' },
    { text: '42% archived', kind: 'validated_observation', source: 'db counts' },
  ],
  openQuestions: ['who owns multi-team repos?'],
  decisions: [{ decision: 'SQLite over files', date: '2026-10-13', rationale: 'S09' }],
  ...overrides,
})

const revision = (number: number, status: StrategyDetail['revisions'][number]['status'], body = content()) => ({
  revision: number, status, content: body, contentHash: hashOf(JSON.stringify(body.purpose ?? body)),
  author: { kind: 'agent' as const, sessionId: 'chat-dev' }, impactProposal: null, createdAt: `2026-10-13T0${number}:00:00.000Z`,
})

const draft = (extra: Partial<StrategyDraft> = {}): StrategyDraft => ({
  draftId: 'human', baseRevision: 2, author: { kind: 'human', sessionId: null },
  content: content({ purpose: 'A human draft in progress' }), contentHash: hashOf('A human draft in progress'),
  impactProposal: null, updatedAt: '2026-10-13T03:00:00.000Z', ...extra,
})

const detail = (extra: Partial<StrategyDetail> = {}): StrategyDetail => ({
  strategy: strategy(),
  revisions: [revision(1, 'superseded', content({ purpose: 'v1' })), revision(2, 'approved')],
  drafts: [draft()],
  evidence: [{ id: 'e1', revision: 2, claimRef: 'c1', kind: 'owner_preference', sourceRef: null, observedAt: null, limitations: null, accessScope: null }],
  decisions: [{ id: 'd1', revision: 2, contentHash: hashOf('approved-body'), decision: 'approve', rationale: null, actor: { kind: 'human', sessionId: null }, approvalScope: 'Direction', openQuestions: 'baseline unknown', commandId: 'c1', createdAt: '2026-10-13T02:00:00.000Z' }],
  impactReviews: [{ id: 'i1', revision: 2, contentHash: hashOf('approved-body'), commandId: 'c1', state: 'pending', createdAt: '2026-10-13T02:00:00.000Z' }],
  ...extra,
})

const openView = () => {
  useStrategyStore.getState().open('dev')
  return useStrategyStore.getState().views.dev!
}
const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
/** A fresh element from the store's current view; call `refresh` after store updates to re-render. */
const mount = (connected = true) => {
  let view = openView()
  const element = () => <ProductStrategyPanel teamPath="dev" view={view} sendMessage={sendMessage} connected={connected}
    onClose={() => useStrategyStore.getState().close('dev')} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element()) })
  const refresh = () => {
    view = useStrategyStore.getState().views.dev ?? view
    act(() => { renderer.update(element()) })
  }
  return { renderer, refresh }
}
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const find = (root: TestRenderer.ReactTestRenderer, testId: string) =>
  root.root.findAll(node => node.props['data-testid'] === testId)

test('store: snapshots set the record, null keeps capture, results track errors and conflicts', () => {
  const view = openView()
  expect(view.seen).toBe(false)
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: null }))
  expect(useStrategyStore.getState().views.dev).toMatchObject({ seen: true, strategy: null })
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail() }))
  expect(useStrategyStore.getState().views.dev!.detail!.strategy.productId).toBe('kawai')
  act(() => useStrategyStore.getState().begin('dev', 'r1', 'save'))
  act(() => useStrategyStore.getState().applyResult({ type: 'strategy-result', teamPath: 'dev', requestId: 'r1', error: 'changed while you edited', conflict: draft() }))
  const after = useStrategyStore.getState().views.dev!
  expect(after.error).toContain('changed while you edited')
  expect(after.conflict!.draftId).toBe('human')
  // A closed view ignores pushes.
  act(() => useStrategyStore.getState().close('dev'))
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: null }))
  expect(useStrategyStore.getState().views.dev).toBeUndefined()
})

test('a product with no record offers capture, never a forced wizard (S11)', () => {
  openView()
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: null }))
  const { renderer } = mount()
  const capture = find(renderer, 'strategy-capture')
  expect(capture).toHaveLength(1)
  expect(textOf(capture[0]!)).toContain('Work proceeds without one')
  // The capture form creates the record through the first save.
  const inputs = capture[0]!.findAll(node => node.props['aria-label'])
  act(() => {
    inputs.find(node => node.props['aria-label'] === 'Product id')!.props.onChange({ target: { value: 'kawai' } })
    inputs.find(node => node.props['aria-label'] === 'Product title')!.props.onChange({ target: { value: 'Kawai' } })
    inputs.find(node => node.props['aria-label'] === 'Initial purpose')!.props.onChange({ target: { value: 'Supervise agents' } })
  })
  sent.length = 0
  act(() => { find(renderer, 'capture-create')[0]!.props.onClick() })
  const message = sent.at(-1)!
  expect(message).toMatchObject({ type: 'strategy-save-draft', productId: 'kawai', title: 'Kawai', expectedDraftHash: null })
})

test('an approved product leads with direction; revision, hash, owner, and status sit in detail (S04 view)', () => {
  openView()
  act(() => useSessionStore.getState().setSessions([sessionRow('chat-dev', 'Dev')]))
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail() }))
  const { renderer } = mount()
  // Direction first: purpose, users, outcomes, use cases, trade-offs, boundaries.
  const direction = find(renderer, 'strategy-direction')[0]!
  const directionText = textOf(direction)
  expect(directionText.indexOf('Supervised autonomous development')).toBeGreaterThanOrEqual(0)
  for (const fragment of ['Small platform teams', 'Ship without babysitting agents', 'lands reviewed', 'runtime records', 'no cross-repo']) {
    expect(directionText).toContain(fragment)
  }
  // Supporting detail: record identity and exact approved state with hash.
  expect(textOf(find(renderer, 'strategy-record')[0]!)).toContain('Kawai (kawai)')
  const status = textOf(find(renderer, 'strategy-status')[0]!)
  expect(status).toContain('Approved revision 2')
  expect(status).toContain('Dev')
  // Revision history keeps superseded content accessible.
  act(() => { find(renderer, 'revision-status-1')[0]!.parent!.props.onClick() })
  expect(textOf(find(renderer, 'revision-content-1')[0]!)).toContain('v1')
})

test('the draft editor labels hypotheses, keeps Unknown measures, and refuses a sourceless validated observation before sending', () => {
  openView()
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail() }))
  const { renderer } = mount()
  // Claim kinds are labeled, hypotheses stay hypotheses.
  expect(textOf(find(renderer, 'claim-kind-1')[0]!)).toContain('Hypothesis')
  expect(textOf(find(renderer, 'claim-kind-2')[0]!)).toContain('Validated observation')
  // Unknown measures render as the sentinel.
  const measure = find(renderer, 'success-measure')[0]!
  expect(measure.findAll(node => node.props['aria-label'] === 'Baseline')[0]!.props.value).toBe(UNKNOWN)
  // Switching a claim to validated observation with no source blocks save.
  const claims = find(renderer, 'claim')
  act(() => {
    claims[1]!.findAll(node => node.props['aria-label'] === 'Claim kind')[0]!.props.onChange({ target: { value: 'validated_observation' } })
  })
  sent.length = 0
  act(() => { find(renderer, 'draft-save')[0]!.props.onClick() })
  expect(sent).toHaveLength(0)
  expect(textOf(find(renderer, 'draft-error')[0]!)).toContain('names no source')
})

test('a material draft keeps its unsaved text after a CAS refusal, with the stored draft beside it (S12)', () => {
  openView()
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail() }))
  const { renderer, refresh } = mount()
  const editor = find(renderer, 'strategy-draft-editor')[0]!
  // The human types a material change with an impact proposal.
  const purpose = editor.findAll(node => node.props['aria-label'] === 'Purpose')[0]!
  act(() => { purpose.props.onChange({ target: { value: 'A narrower purpose I just typed' } }) })
  act(() => { editor.findAll(node => node.props['aria-label'] === 'Impact proposal')[0]!.props.onChange({ target: { value: 'narrows purpose' } }) })
  sent.length = 0
  act(() => { find(renderer, 'draft-save')[0]!.props.onClick() })
  const message = sent.at(-1)!
  expect(message).toMatchObject({ type: 'strategy-save-draft', expectedDraftHash: draft().contentHash })
  // The server refuses with the stored draft; the editor's text survives
  // (its state is never re-seeded from the refusal).
  act(() => useStrategyStore.getState().applyResult({
    type: 'strategy-result', teamPath: 'dev', requestId: (message as { requestId: string }).requestId,
    error: 'Draft human changed while you edited', conflict: draft(),
  }))
  refresh()
  const after = find(renderer, 'strategy-draft-editor')[0]!
  expect(after.findAll(node => node.props['aria-label'] === 'Purpose')[0]!.props.value).toBe('A narrower purpose I just typed')
  expect(after.findAll(node => node.props['aria-label'] === 'Impact proposal')[0]!.props.value).toBe('narrows purpose')
  expect(textOf(find(renderer, 'draft-conflict')[0]!)).toContain('Stored draft')
})

test('reload after a CAS refusal adopts the stored draft the server returned, and the next save carries its hash (S12)', () => {
  openView()
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail() }))
  const { renderer, refresh } = mount()
  const purposeOf = () => find(renderer, 'strategy-draft-editor')[0]!.findAll(node => node.props['aria-label'] === 'Purpose')[0]!
  act(() => { purposeOf().props.onChange({ target: { value: 'My unsaved edit' } }) })
  sent.length = 0
  act(() => { find(renderer, 'draft-save')[0]!.props.onClick() })
  // Another editor wrote the stored draft behind this client: no detail
  // push arrived, so only the refusal carries the stored version.
  const stored = draft({ content: content({ purpose: 'Stored by another editor' }), contentHash: hashOf('Stored by another editor'), updatedAt: '2026-10-13T04:00:00.000Z' })
  act(() => useStrategyStore.getState().applyResult({
    type: 'strategy-result', teamPath: 'dev', requestId: (sent.at(-1) as { requestId: string }).requestId,
    error: 'Draft human changed while you edited', conflict: stored,
  }))
  refresh()
  expect(purposeOf().props.value).toBe('My unsaved edit')
  const reload = find(renderer, 'strategy-draft-editor')[0]!.findAll(node => node.type === 'button' && textOf(node) === 'Reload stored draft')[0]!
  act(() => { reload.props.onClick() })
  refresh()
  expect(purposeOf().props.value).toBe('Stored by another editor')
  expect(find(renderer, 'draft-conflict')).toHaveLength(0)
  expect(useStrategyStore.getState().views.dev!.error).toBeNull()
  // Saving now is based on the adopted draft, not the stale one.
  sent.length = 0
  act(() => { find(renderer, 'draft-save')[0]!.props.onClick() })
  expect(sent.at(-1)).toMatchObject({ type: 'strategy-save-draft', expectedDraftHash: stored.contentHash, expectedBaseRevision: stored.baseRevision })
})

test('a detail push after a CAS refusal supersedes its stored draft: the box and Reload follow the push', () => {
  openView()
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail() }))
  const { renderer, refresh } = mount()
  const purposeOf = () => find(renderer, 'strategy-draft-editor')[0]!.findAll(node => node.props['aria-label'] === 'Purpose')[0]!
  act(() => { find(renderer, 'draft-save')[0]!.props.onClick() })
  const refused = draft({ content: content({ purpose: 'Refusal snapshot C1' }), contentHash: hashOf('Refusal snapshot C1'), updatedAt: '2026-10-13T04:00:00.000Z' })
  act(() => useStrategyStore.getState().applyResult({
    type: 'strategy-result', teamPath: 'dev', requestId: (sent.at(-1) as { requestId: string }).requestId,
    error: 'Draft human changed while you edited', conflict: refused,
  }))
  // Another writer saves through the server: its push carries C2.
  const pushed = draft({ content: content({ purpose: 'Pushed later C2' }), contentHash: hashOf('Pushed later C2'), baseRevision: 3, updatedAt: '2026-10-13T05:00:00.000Z' })
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail({ drafts: [pushed] }) }))
  refresh()
  expect(textOf(find(renderer, 'draft-conflict')[0]!)).toContain('Pushed later C2')
  const reload = find(renderer, 'strategy-draft-editor')[0]!.findAll(node => node.type === 'button' && textOf(node) === 'Reload stored draft')[0]!
  act(() => { reload.props.onClick() })
  refresh()
  expect(purposeOf().props.value).toBe('Pushed later C2')
  expect(useStrategyStore.getState().views.dev!.detail!.drafts.find(entry => entry.draftId === 'human')!.contentHash).toBe(pushed.contentHash)
  // A push whose draft is gone (withdrawn elsewhere) drops the conflict with it.
  act(() => { find(renderer, 'draft-save')[0]!.props.onClick() })
  act(() => useStrategyStore.getState().applyResult({
    type: 'strategy-result', teamPath: 'dev', requestId: (sent.at(-1) as { requestId: string }).requestId,
    error: 'Draft human changed while you edited', conflict: refused,
  }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail({ drafts: [] }) }))
  expect(useStrategyStore.getState().views.dev!.conflict).toBeNull()
})

test('review separates known, assumed, and not decided; approve carries the exact revision and hash with scope and open questions', () => {
  openView()
  act(() => useSessionStore.getState().setSessions([sessionRow('chat-dev', 'Dev')]))
  const inReview = revision(3, 'in_review', content({ purpose: 'v3', openQuestions: ['who owns multi-team repos?'] }))
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy({ currentApprovedRevision: 2 }) }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail({ revisions: [...detail().revisions, inReview] }) }))
  const { renderer, refresh } = mount()
  const review = find(renderer, 'strategy-review-3')[0]!
  expect(textOf(find(renderer, 'review-known')[0]!)).toContain('42% archived')
  expect(textOf(find(renderer, 'review-assumed')[0]!)).toContain('hypothesis')
  expect(textOf(find(renderer, 'review-not-decided')[0]!)).toContain('who owns multi-team repos?')
  expect(textOf(review)).toContain(inReview.contentHash)
  act(() => { review.findAll(node => node.props['aria-label'] === 'Approval scope')[0]!.props.onChange({ target: { value: 'Direction only' } }) })
  act(() => { review.findAll(node => node.props['aria-label'] === 'Allowed open questions')[0]!.props.onChange({ target: { value: 'baseline unknown' } }) })
  sent.length = 0
  act(() => { find(renderer, 'approve-3')[0]!.props.onClick() })
  expect(sent.at(-1)).toMatchObject({
    type: 'strategy-approve', revision: 3, contentHash: inReview.contentHash, expectedCurrentRevision: 2,
    approvalScope: 'Direction only', openQuestions: 'baseline unknown',
  })
  // The same command id is reused on retry (idempotency, S17).
  act(() => useStrategyStore.getState().applyResult({
    type: 'strategy-result', teamPath: 'dev', requestId: (sent.at(-1) as { requestId: string }).requestId, error: 'network hiccup',
  }))
  refresh()
  // A stale approval error shows inline.
  expect(textOf(find(renderer, 'strategy-error')[0]!)).toContain('network hiccup')
  act(() => { find(renderer, 'approve-3')[0]!.props.onClick() })
  expect((sent.at(-1) as { commandId: string }).commandId).toBe((sent.at(-2) as { commandId: string }).commandId)
})

test('submit and withdraw controls exist and every control disables while disconnected', () => {
  const inReview = revision(3, 'in_review')
  openView()
  act(() => useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: strategy() }))
  act(() => useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: detail({ revisions: [...detail().revisions, inReview] }) }))
  let renderer = mount(false).renderer
  expect(find(renderer, 'strategy-submit')[0]!.props.disabled).toBe(true)
  expect(find(renderer, 'approve-3')[0]!.props.disabled).toBe(true)
  expect(find(renderer, 'draft-save')[0]!.props.disabled).toBe(true)
  expect(find(renderer, 'withdraw-revision-1')).toHaveLength(0)
  act(() => { renderer.unmount() })
  // Connected: the controls act.
  const live = mount()
  renderer = live.renderer
  sent.length = 0
  act(() => { find(renderer, 'strategy-submit')[0]!.props.onClick() })
  expect(sent.at(-1)).toMatchObject({ type: 'strategy-submit' })
  // Withdraw lives in the revision's expanded history row.
  const status3 = find(renderer, 'revision-status-3')[0]!
  act(() => { status3.parent!.props.onClick() })
  act(() => { find(renderer, 'withdraw-revision-3')[0]!.props.onClick() })
  expect(sent.at(-1)).toMatchObject({ type: 'strategy-withdraw', revision: 3 })
  act(() => { find(renderer, 'strategy-withdraw-draft')[0]!.props.onClick() })
  expect(sent.at(-1)).toMatchObject({ type: 'strategy-withdraw', draftId: 'human' })
  // A withdrawn revision stays in history with its status label.
  act(() => useStrategyStore.getState().applyDetail({
    type: 'strategy-detail', teamPath: 'dev', teamId: 'team',
    detail: detail({ revisions: [revision(1, 'superseded', content({ purpose: 'v1' })), revision(2, 'approved'), revision(3, 'withdrawn', content({ purpose: 'v3' }))] }),
  }))
  live.refresh()
  expect(textOf(find(renderer, 'revision-status-3')[0]!)).toContain('Withdrawn')
  // Still expanded from the withdraw click above: the withdrawn content stays accessible.
  expect(textOf(find(renderer, 'revision-content-3')[0]!)).toContain('v3')
  expect(textOf(find(renderer, 'impact-review-row')[0]!)).toContain('pending')
})

test('the closed default view renders nothing until opened', () => {
  expect(closedStrategyView()).toMatchObject({ open: false, seen: false, detail: null })
})

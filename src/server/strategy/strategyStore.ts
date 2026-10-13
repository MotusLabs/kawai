// Durable product strategies (product-strategy design D1): one record per
// product with immutable numbered revisions, CAS-guarded working drafts,
// per-claim evidence rows, human decisions, and the single impact-review
// item a publication creates — all in the server's SQLite database beside
// `team_tasks`. Nothing here deletes a revision or rewrites approved
// content: revisions change status only, and only approval, supersession,
// and withdrawal move it. The store is policy-free; who may do what is
// decided by StrategyService before it calls in. Repository bindings
// (`strategy_repo_bindings`) are the product's team scope: the owning
// team's git common dir plus its listed worktrees, one product per team
// (the unique root index enforces it).
import type { Database } from 'bun:sqlite'
import type {
  ProductStrategy,
  StrategyActor,
  StrategyClaimKind,
  StrategyDecision,
  StrategyDraft,
  StrategyDetail,
  StrategyEvidence,
  StrategyImpactReview,
  StrategyRevision,
  StrategyRevisionStatus,
} from '../../shared/productStrategy'
import {
  STRATEGY_CLAIM_KINDS,
  STRATEGY_REVISION_STATUSES,
  hashStrategyContent,
  normalizeStrategyContent,
  strategyContentErrors,
} from '../../shared/productStrategy'

export const CREATE_STRATEGY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS product_strategies (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_session TEXT,
  lifecycle TEXT NOT NULL,
  current_approved_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS product_strategies_product ON product_strategies (product_id);
CREATE TABLE IF NOT EXISTS strategy_revisions (
  strategy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  impact_proposal TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, revision)
);
CREATE TABLE IF NOT EXISTS strategy_drafts (
  strategy_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  base_revision INTEGER,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  impact_proposal TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, draft_id)
);
CREATE TABLE IF NOT EXISTS strategy_evidence (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  claim_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_ref TEXT,
  observed_at TEXT,
  limitations TEXT,
  access_scope TEXT
);
CREATE INDEX IF NOT EXISTS strategy_evidence_revision ON strategy_evidence (strategy_id, revision);
-- Idempotency is a database fact (design D1/D4): a retried approve or
-- withdraw cannot insert a second decision, and S14's "impact-review item
-- once" is the same constraint one table over.
CREATE TABLE IF NOT EXISTS strategy_decisions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  revision INTEGER,
  content_hash TEXT,
  decision TEXT NOT NULL,
  rationale TEXT,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  approval_scope TEXT,
  open_questions TEXT,
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
CREATE TABLE IF NOT EXISTS strategy_impact_reviews (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  command_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
CREATE TABLE IF NOT EXISTS strategy_repo_bindings (
  strategy_id TEXT NOT NULL,
  root TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, root)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_repo_bindings_root ON strategy_repo_bindings (root);
`

export interface CreateStrategyInput {
  productId: string
  title: string
  /** The human owner (design D7: a single human actor). */
  owner: StrategyActor
  /** The owning team's git common dir (`TeamIdentity.teamId`). */
  teamId: string
  /** The team's listed worktree roots. */
  worktrees: string[]
}

export interface SaveDraftInput {
  draftId: string
  author: StrategyActor
  /** Raw content; normalized (and validated) before it is stored. */
  content: unknown
  impactProposal?: string | null
  /** CAS (design D4): the draft hash the caller believes it overwrites; null = create. */
  expectedDraftHash: string | null
  /** CAS: the base revision the caller believes the draft sits on. */
  expectedBaseRevision?: number | null
}

export type DraftSaveOutcome =
  | { ok: true; draft: StrategyDraft }
  | { ok: false; reason: 'content' | 'conflict'; message: string; stored: StrategyDraft | null }

export interface SubmitRevisionInput {
  author: StrategyActor
  content: unknown
  impactProposal?: string | null
}

export interface ApproveInput {
  revision: number
  contentHash: string
  commandId: string
  /** CAS (design D4): the current approved revision the caller saw; the update guards on its prior value. */
  expectedCurrentRevision: number | null
  approvalScope?: string | null
  openQuestions?: string | null
  actor: StrategyActor
}

export interface WithdrawRevisionInput {
  revision: number
  commandId: string
  actor: StrategyActor
}

export type DecisionOutcome =
  | {
    ok: true
    replayed: boolean
    decision: StrategyDecision
    revision: StrategyRevision
    /** Present for approvals: the one publication side effect (design D6). */
    impactReview: StrategyImpactReview | null
    strategy: ProductStrategy
  }
  | { ok: false; reason: 'stale' | 'payload'; message: string }

const nowIso = () => new Date().toISOString()

export class StrategyStore {
  private readonly listeners = new Set<(strategy: ProductStrategy) => void>()

  constructor(private readonly db: Database) {
    db.exec(CREATE_STRATEGY_TABLES_SQL)
  }

  /** Every committed change, with the strategy as it is now. */
  subscribe(listener: (strategy: ProductStrategy) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(id: string): ProductStrategy {
    const strategy = this.get(id)!
    for (const listener of this.listeners) listener(strategy)
    return strategy
  }

  create(input: CreateStrategyInput, now = nowIso()): ProductStrategy {
    const id = `strategy-${crypto.randomUUID()}`
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO product_strategies
        (id, product_id, title, owner_kind, owner_session, lifecycle, current_approved_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`).run(
        id, input.productId, input.title, input.owner.kind, input.owner.sessionId, now, now,
      )
      const binding = this.db.prepare('INSERT INTO strategy_repo_bindings (strategy_id, root, kind, created_at) VALUES (?, ?, ?, ?)')
      binding.run(id, input.teamId, 'team', now)
      for (const root of input.worktrees) {
        if (root !== input.teamId) binding.run(id, root, 'worktree', now)
      }
    })()
    return this.changed(id)
  }

  get(id: string): ProductStrategy | null {
    const row = this.db.prepare('SELECT * FROM product_strategies WHERE id = ?').get(id)
    return row ? this.mapStrategy(row as Record<string, unknown>) : null
  }

  getByProductId(productId: string): ProductStrategy | null {
    const row = this.db.prepare('SELECT * FROM product_strategies WHERE product_id = ?').get(productId)
    return row ? this.mapStrategy(row as Record<string, unknown>) : null
  }

  /** The team's strategies, oldest first (one per team by the binding rule). */
  listForTeam(teamId: string): ProductStrategy[] {
    return (this.db.prepare(`SELECT s.* FROM product_strategies s
      JOIN strategy_repo_bindings b ON b.strategy_id = s.id AND b.kind = 'team'
      WHERE b.root = ? ORDER BY s.created_at, s.rowid`).all(teamId) as Record<string, unknown>[])
      .map(row => this.mapStrategy(row))
  }

  /** The strategy bound to a team's repository, if the team has one. */
  forTeam(teamId: string): ProductStrategy | null {
    return this.listForTeam(teamId)[0] ?? null
  }

  detail(id: string): StrategyDetail | null {
    const strategy = this.get(id)
    if (!strategy) return null
    return {
      strategy,
      revisions: this.revisions(id),
      drafts: this.drafts(id),
      evidence: this.evidence(id),
      decisions: this.decisions(id),
      impactReviews: this.impactReviews(id),
    }
  }

  revisions(strategyId: string): StrategyRevision[] {
    return (this.db.prepare('SELECT * FROM strategy_revisions WHERE strategy_id = ? ORDER BY revision').all(strategyId) as Record<string, unknown>[])
      .map(mapRevision)
  }

  revision(strategyId: string, revision: number): StrategyRevision | null {
    const row = this.db.prepare('SELECT * FROM strategy_revisions WHERE strategy_id = ? AND revision = ?').get(strategyId, revision)
    return row ? mapRevision(row as Record<string, unknown>) : null
  }

  drafts(strategyId: string): StrategyDraft[] {
    return (this.db.prepare('SELECT * FROM strategy_drafts WHERE strategy_id = ? ORDER BY updated_at, rowid').all(strategyId) as Record<string, unknown>[])
      .map(mapDraft)
  }

  getDraft(strategyId: string, draftId: string): StrategyDraft | null {
    const row = this.db.prepare('SELECT * FROM strategy_drafts WHERE strategy_id = ? AND draft_id = ?').get(strategyId, draftId)
    return row ? mapDraft(row as Record<string, unknown>) : null
  }

  /** Human withdrawal of a draft (Draft stage): the row is discarded, not parked. */
  deleteDraft(strategyId: string, draftId: string): boolean {
    const changes = this.db.prepare('DELETE FROM strategy_drafts WHERE strategy_id = ? AND draft_id = ?').run(strategyId, draftId).changes
    if (changes !== 1) return false
    this.changed(strategyId)
    return true
  }

  evidence(strategyId: string, revision?: number): StrategyEvidence[] {
    const rows = (revision === undefined
      ? this.db.prepare('SELECT * FROM strategy_evidence WHERE strategy_id = ? ORDER BY revision, rowid').all(strategyId)
      : this.db.prepare('SELECT * FROM strategy_evidence WHERE strategy_id = ? AND revision = ? ORDER BY rowid').all(strategyId, revision)
    ) as Record<string, unknown>[]
    return rows.map(row => ({
      id: String(row.id),
      revision: Number(row.revision),
      claimRef: String(row.claim_ref),
      kind: claimKind(row.kind),
      sourceRef: text(row.source_ref),
      observedAt: text(row.observed_at),
      limitations: text(row.limitations),
      accessScope: text(row.access_scope),
    }))
  }

  decisions(strategyId: string): StrategyDecision[] {
    return (this.db.prepare('SELECT * FROM strategy_decisions WHERE strategy_id = ? ORDER BY created_at, rowid').all(strategyId) as Record<string, unknown>[])
      .map(row => ({
        id: String(row.id),
        revision: row.revision === null ? null : Number(row.revision),
        contentHash: text(row.content_hash),
        decision: row.decision === 'withdraw' ? 'withdraw' as const : 'approve' as const,
        rationale: text(row.rationale),
        actor: actor(row.actor_kind, row.actor_session),
        approvalScope: text(row.approval_scope),
        openQuestions: text(row.open_questions),
        commandId: String(row.command_id),
        createdAt: String(row.created_at),
      }))
  }

  impactReviews(strategyId: string): StrategyImpactReview[] {
    return (this.db.prepare('SELECT * FROM strategy_impact_reviews WHERE strategy_id = ? ORDER BY created_at, rowid').all(strategyId) as Record<string, unknown>[])
      .map(row => ({
        id: String(row.id),
        revision: Number(row.revision),
        contentHash: String(row.content_hash),
        commandId: String(row.command_id),
        state: 'pending' as const,
        createdAt: String(row.created_at),
      }))
  }

  decisionByCommand(strategyId: string, commandId: string): StrategyDecision | null {
    return this.decisions(strategyId).find(decision => decision.commandId === commandId) ?? null
  }

  /**
   * Save a working draft (design D4). The content is normalized and its
   * claims validated first — a validated observation without a source is
   * refused here. The write is CAS-guarded: the stored draft must still
   * carry `expectedDraftHash` (and sit on `expectedBaseRevision` when
   * given), otherwise the save is refused and the stored draft returned so
   * the caller can keep its own text for resolution (S12).
   */
  saveDraft(strategyId: string, input: SaveDraftInput, now = nowIso()): DraftSaveOutcome {
    const content = normalizeStrategyContent(input.content)
    const errors = strategyContentErrors(content)
    if (errors.length > 0) return { ok: false, reason: 'content', message: errors.join(' '), stored: null }
    const hash = hashStrategyContent(content)
    const impact = input.impactProposal?.trim() ? input.impactProposal.trim() : null
    return this.db.transaction((): DraftSaveOutcome => {
      const strategy = this.get(strategyId)
      if (!strategy) return { ok: false, reason: 'conflict', message: `No strategy record: ${strategyId}`, stored: null }
      const stored = this.getDraft(strategyId, input.draftId)
      if (stored) {
        if (input.expectedBaseRevision !== undefined && input.expectedBaseRevision !== null && input.expectedBaseRevision !== stored.baseRevision) {
          return {
            ok: false, reason: 'conflict',
            message: `Draft ${input.draftId} is based on revision ${stored.baseRevision ?? 'none'}, not ${input.expectedBaseRevision}; the base changed while you edited.`,
            stored,
          }
        }
        if (input.expectedDraftHash !== stored.contentHash) {
          return {
            ok: false, reason: 'conflict',
            message: `Draft ${input.draftId} changed while you edited (expected hash ${input.expectedDraftHash ?? 'no draft'}). Your text is not saved; reconcile with the stored draft.`,
            stored,
          }
        }
        this.db.prepare(`UPDATE strategy_drafts SET content_json = ?, content_hash = ?, impact_proposal = ?, updated_at = ?
          WHERE strategy_id = ? AND draft_id = ?`).run(JSON.stringify(content), hash, impact, now, strategyId, input.draftId)
        this.changed(strategyId)
        return { ok: true, draft: this.getDraft(strategyId, input.draftId)! }
      }
      if (input.expectedDraftHash !== null) {
        return {
          ok: false, reason: 'conflict',
          message: `Draft ${input.draftId} no longer exists (it may have been withdrawn); start a new draft.`,
          stored: null,
        }
      }
      try {
        this.db.prepare(`INSERT INTO strategy_drafts
          (strategy_id, draft_id, base_revision, author_kind, author_session, content_json, content_hash, impact_proposal, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          strategyId, input.draftId, strategy.currentApprovedRevision, input.author.kind, input.author.sessionId,
          JSON.stringify(content), hash, impact, now,
        )
      } catch (error) {
        // The primary key race: another editor created this draft first.
        if (String(error).includes('UNIQUE constraint failed')) {
          return {
            ok: false, reason: 'conflict',
            message: `Draft ${input.draftId} was created by another editor while you saved. Your text is not saved; reconcile with the stored draft.`,
            stored: this.getDraft(strategyId, input.draftId),
          }
        }
        throw error
      }
      this.changed(strategyId)
      return { ok: true, draft: this.getDraft(strategyId, input.draftId)! }
    })()
  }

  /**
   * Promote content to a numbered InReview revision: the next revision
   * number, the content and hash frozen, and one evidence row per claim.
   * Content is re-validated; drafts that were valid stay valid, but a
   * hand-built payload meets the same rules.
   */
  submitRevision(strategyId: string, input: SubmitRevisionInput, now = nowIso()): { ok: true; revision: StrategyRevision } | { ok: false; reason: 'content'; message: string } {
    const content = normalizeStrategyContent(input.content)
    const errors = strategyContentErrors(content)
    if (errors.length > 0) return { ok: false, reason: 'content', message: errors.join(' ') }
    const hash = hashStrategyContent(content)
    const impact = input.impactProposal?.trim() ? input.impactProposal.trim() : null
    const revision = this.db.transaction(() => {
      const current = this.get(strategyId)
      if (!current) throw new Error(`No strategy record: ${strategyId}`)
      const max = (this.db.prepare('SELECT MAX(revision) AS max FROM strategy_revisions WHERE strategy_id = ?').get(strategyId) as { max: number | null }).max
      const next = (max ?? 0) + 1
      this.db.prepare(`INSERT INTO strategy_revisions
        (strategy_id, revision, status, content_json, content_hash, author_kind, author_session, impact_proposal, created_at)
        VALUES (?, ?, 'in_review', ?, ?, ?, ?, ?, ?)`).run(
        strategyId, next, JSON.stringify(content), hash, input.author.kind, input.author.sessionId, impact, now,
      )
      const insertEvidence = this.db.prepare(`INSERT INTO strategy_evidence
        (id, strategy_id, revision, claim_ref, kind, source_ref, observed_at, limitations, access_scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      for (const claim of content.claims) {
        insertEvidence.run(`evidence-${crypto.randomUUID()}`, strategyId, next, claim.ref, claim.kind,
          claim.source ?? null, claim.observedAt ?? null, claim.limitations ?? null)
      }
      this.db.prepare('UPDATE product_strategies SET updated_at = ? WHERE id = ?').run(now, strategyId)
      return next
    })()
    this.changed(strategyId)
    return { ok: true, revision: this.revision(strategyId, revision)! }
  }

  /**
   * Human approval (design D3/D4): one transaction writes the decision,
   * moves the revision to Approved, supersedes the prior approved revision,
   * creates the single impact-review item, and flips
   * `current_approved_revision` under its prior value — so a racing or
   * repeated approval can neither land twice nor leave two actives.
   */
  approve(strategyId: string, input: ApproveInput, now = nowIso()): DecisionOutcome {
    const outcome = this.db.transaction((): DecisionOutcome => {
      const strategy = this.get(strategyId)
      if (!strategy) return { ok: false, reason: 'stale', message: `No strategy record: ${strategyId}` }
      const prior = this.decisionByCommand(strategyId, input.commandId)
      if (prior) return this.replayOrRefuse(strategy, prior, input)
      const revision = this.revision(strategyId, input.revision)
      if (!revision) return { ok: false, reason: 'stale', message: `Revision ${input.revision} does not exist` }
      if (revision.status !== 'in_review') {
        return { ok: false, reason: 'stale', message: `Revision ${input.revision} is ${revision.status}, not in review — it changed while this approval was open. Reload and review the current state.` }
      }
      if (revision.contentHash !== input.contentHash) {
        return { ok: false, reason: 'stale', message: `Revision ${input.revision} content hash is ${revision.contentHash}, not ${input.contentHash} — the content differs from what was reviewed.` }
      }
      if (input.expectedCurrentRevision !== strategy.currentApprovedRevision) {
        return {
          ok: false, reason: 'stale',
          message: `The active approved revision changed while this approval was open (expected ${input.expectedCurrentRevision ?? 'none'}, now ${strategy.currentApprovedRevision ?? 'none'}). Reload and approve again.`,
        }
      }
      const guarded = this.db.prepare(`UPDATE product_strategies SET current_approved_revision = ?, updated_at = ?
        WHERE id = ? AND current_approved_revision IS ?`).run(input.revision, now, strategyId, strategy.currentApprovedRevision).changes
      if (guarded !== 1) {
        return { ok: false, reason: 'stale', message: 'The active approved revision changed while this approval landed; it is refused as stale.' }
      }
      if (strategy.currentApprovedRevision != null) {
        this.db.prepare(`UPDATE strategy_revisions SET status = 'superseded' WHERE strategy_id = ? AND revision = ?`)
          .run(strategyId, strategy.currentApprovedRevision)
      }
      this.db.prepare(`UPDATE strategy_revisions SET status = 'approved' WHERE strategy_id = ? AND revision = ?`).run(strategyId, input.revision)
      const decisionId = `decision-${crypto.randomUUID()}`
      this.db.prepare(`INSERT INTO strategy_decisions
        (id, strategy_id, revision, content_hash, decision, rationale, actor_kind, actor_session, approval_scope, open_questions, command_id, created_at)
        VALUES (?, ?, ?, ?, 'approve', NULL, ?, ?, ?, ?, ?, ?)`).run(
        decisionId, strategyId, input.revision, input.contentHash,
        input.actor.kind, input.actor.sessionId, input.approvalScope?.trim() || null, input.openQuestions?.trim() || null, input.commandId, now,
      )
      const reviewId = `impact-${crypto.randomUUID()}`
      this.db.prepare(`INSERT INTO strategy_impact_reviews
        (id, strategy_id, revision, content_hash, command_id, state, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(reviewId, strategyId, input.revision, input.contentHash, input.commandId, now)
      return {
        ok: true, replayed: false,
        decision: this.decisions(strategyId).find(decision => decision.id === decisionId)!,
        revision: this.revision(strategyId, input.revision)!,
        impactReview: this.impactReviews(strategyId).find(review => review.id === reviewId)!,
        strategy: this.get(strategyId)!,
      }
    })()
    if (outcome.ok) this.changed(strategyId)
    return outcome
  }

  /**
   * Human withdrawal of a revision: status moves to Withdrawn, history,
   * decisions, and impact-review items stay (spec: withdrawal preserves
   * them), and withdrawing the active approved revision clears the active
   * pointer in the same transaction — approval records are never erased.
   */
  withdrawRevision(strategyId: string, input: WithdrawRevisionInput, now = nowIso()): DecisionOutcome {
    const outcome = this.db.transaction((): DecisionOutcome => {
      const strategy = this.get(strategyId)
      if (!strategy) return { ok: false, reason: 'stale', message: `No strategy record: ${strategyId}` }
      const prior = this.decisionByCommand(strategyId, input.commandId)
      if (prior) return this.replayOrRefuse(strategy, prior, input)
      const revision = this.revision(strategyId, input.revision)
      if (!revision) return { ok: false, reason: 'stale', message: `Revision ${input.revision} does not exist` }
      if (revision.status === 'withdrawn') {
        return { ok: false, reason: 'stale', message: `Revision ${input.revision} is already withdrawn` }
      }
      if (strategy.currentApprovedRevision === input.revision) {
        this.db.prepare(`UPDATE product_strategies SET current_approved_revision = NULL, updated_at = ? WHERE id = ?`).run(now, strategyId)
      } else {
        this.db.prepare('UPDATE product_strategies SET updated_at = ? WHERE id = ?').run(now, strategyId)
      }
      this.db.prepare(`UPDATE strategy_revisions SET status = 'withdrawn' WHERE strategy_id = ? AND revision = ?`).run(strategyId, input.revision)
      const decisionId = `decision-${crypto.randomUUID()}`
      this.db.prepare(`INSERT INTO strategy_decisions
        (id, strategy_id, revision, content_hash, decision, rationale, actor_kind, actor_session, approval_scope, open_questions, command_id, created_at)
        VALUES (?, ?, ?, NULL, 'withdraw', NULL, ?, ?, NULL, NULL, ?, ?)`).run(
        decisionId, strategyId, input.revision, input.actor.kind, input.actor.sessionId, input.commandId, now,
      )
      return {
        ok: true, replayed: false,
        decision: this.decisions(strategyId).find(decision => decision.id === decisionId)!,
        revision: this.revision(strategyId, input.revision)!,
        impactReview: null,
        strategy: this.get(strategyId)!,
      }
    })()
    if (outcome.ok) this.changed(strategyId)
    return outcome
  }

  /** Same command id again: same payload replays the prior result, different payload is refused (S17). */
  private replayOrRefuse(strategy: ProductStrategy, prior: StrategyDecision, input: ApproveInput | WithdrawRevisionInput): DecisionOutcome {
    const samePayload = 'contentHash' in input
      ? prior.decision === 'approve' && prior.revision === input.revision && prior.contentHash === input.contentHash
      : prior.decision === 'withdraw' && prior.revision === input.revision
    if (!samePayload) {
      return {
        ok: false, reason: 'payload',
        message: `command_id ${input.commandId} was already used with a different payload; the recorded ${prior.decision} of revision ${prior.revision ?? 'none'} stands.`,
      }
    }
    return {
      ok: true, replayed: true,
      decision: prior,
      revision: this.revision(strategy.id, prior.revision ?? input.revision)!,
      impactReview: this.impactReviews(strategy.id).find(review => review.commandId === input.commandId) ?? null,
      strategy: this.get(strategy.id)!,
    }
  }

  private mapStrategy(row: Record<string, unknown>): ProductStrategy {
    const bindings = (this.db.prepare('SELECT root, kind FROM strategy_repo_bindings WHERE strategy_id = ? ORDER BY kind, root')
      .all(String(row.id)) as Record<string, unknown>[])
    return {
      id: String(row.id),
      productId: String(row.product_id),
      title: String(row.title),
      owner: actor(row.owner_kind, row.owner_session),
      lifecycle: 'active',
      currentApprovedRevision: row.current_approved_revision === null || row.current_approved_revision === undefined ? null : Number(row.current_approved_revision),
      repoBindings: bindings.map(binding => ({
        root: String(binding.root),
        kind: binding.kind === 'team' ? 'team' as const : 'worktree' as const,
      })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function actor(kind: unknown, session: unknown): StrategyActor {
  return kind === 'agent' && typeof session === 'string' ? { kind: 'agent', sessionId: session } : { kind: 'human', sessionId: null }
}

function revisionStatus(value: unknown): StrategyRevisionStatus {
  const status = String(value) as StrategyRevisionStatus
  return STRATEGY_REVISION_STATUSES.includes(status) ? status : 'in_review'
}

function claimKind(value: unknown): StrategyClaimKind {
  const kind = String(value) as StrategyClaimKind
  return STRATEGY_CLAIM_KINDS.includes(kind) ? kind : 'hypothesis'
}

function mapRevision(row: Record<string, unknown>): StrategyRevision {
  return {
    revision: Number(row.revision),
    status: revisionStatus(row.status),
    content: normalizeStrategyContent(JSON.parse(String(row.content_json))),
    contentHash: String(row.content_hash),
    author: actor(row.author_kind, row.author_session),
    impactProposal: text(row.impact_proposal),
    createdAt: String(row.created_at),
  }
}

function mapDraft(row: Record<string, unknown>): StrategyDraft {
  return {
    draftId: String(row.draft_id),
    baseRevision: row.base_revision === null || row.base_revision === undefined ? null : Number(row.base_revision),
    author: actor(row.author_kind, row.author_session),
    content: normalizeStrategyContent(JSON.parse(String(row.content_json))),
    contentHash: String(row.content_hash),
    impactProposal: text(row.impact_proposal),
    updatedAt: String(row.updated_at),
  }
}

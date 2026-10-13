// Strategy operations with identity and permissions (product-strategy
// design D3/D5/D7). Agent calls are bound to the calling session — its team
// comes from the session record and the group files as they are now, never
// from tool arguments, so a forged actor kind or team in the input is never
// seen here. Human calls arrive through the UI connection with a team
// already resolved. Rules:
// - read (list/get) and propose (save draft, submit for review): agents
//   and the human, scoped to the caller's team's strategy;
// - capture (create the record): the human only, folded into the first
//   draft save — an agent saving with no record is told the human creates
//   it (S11: work proceeds without a strategy; none is auto-created);
// - approve, publish, withdraw, delete: the human only. There is no agent
//   tool for any of them (the registered surface is exactly the four
//   read/propose tools), and this service refuses an agent caller on the
//   same paths — the guarantee is structural, not a prompt convention.
//
// Draft B boundary (ruled 2026-10-13, design D3b): like `team-task-*`, the
// forged-WS-client vector is explicitly accepted — human actions are
// trusted from the UI connection's session, and the spec's guarantee is
// that no agent tool surface can approve, not that a local process speaking
// the UI connection protocol can be distinguished from a browser. Draft A's
// nonce assurance step stays documented in design D3b and is not built.
import type { ChatSessionRecord } from '../db'
import type {
  ProductStrategy,
  StrategyDetail,
} from '../../shared/productStrategy'
import type { TeamIdentity } from '../team/teamIdentity'
import { loadTeamGroups } from '../team/teamGroups'
import { TeamWorktrees } from '../team/worktreeRoots'
import type {
  DraftSaveOutcome,
} from './strategyStore'
import type { StrategyStore } from './strategyStore'

export interface StrategySaveDraftInput {
  /** Capture only (human, no record yet): the human-chosen product slug. */
  product_id?: string
  /** Capture only: the product title. */
  title?: string
  /** Default: the caller's session id (agents) or 'human'. */
  draft_id?: string
  /** Raw template content; normalized and validated by the store. */
  content: unknown
  impact_proposal?: string | null
  expected_base_revision?: number | null
  expected_draft_hash?: string | null
}

export interface StrategySubmitInput {
  draft_id?: string
}

export interface StrategyApproveInput {
  revision: number
  content_hash: string
  command_id: string
  expected_current_revision: number | null
  approval_scope?: string | null
  open_questions?: string | null
}

export interface StrategyWithdrawInput {
  revision?: number
  draft_id?: string
  command_id: string
}

export type StrategyCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

const PRODUCT_SLUG = /^[a-z0-9][a-z0-9-]*$/

export class StrategyService {
  readonly worktrees: TeamWorktrees

  constructor(readonly store: StrategyStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    homeDir?: string
    worktrees?: TeamWorktrees
  }) {
    this.worktrees = options.worktrees ?? new TeamWorktrees()
  }

  async list(caller: StrategyCaller): Promise<ProductStrategy[]> {
    const { team } = await this.context(caller)
    return this.store.listForTeam(team.teamId)
  }

  /** The team's strategy in full; null when the product has no record (S11). */
  async get(caller: StrategyCaller, productId?: string): Promise<StrategyDetail | null> {
    const { team } = await this.context(caller)
    const strategy = this.teamStrategy(team, productId)
    return strategy ? this.store.detail(strategy.id) : null
  }

  /**
   * Save a working draft. The human's first save on a product with no
   * record captures it: the record is created with that human as owner and
   * the product's repository bindings, then the draft is stored (spec: the
   * first-strategy scenario). An agent's save with no record is refused —
   * agents propose on an existing record; they never create one.
   */
  async saveDraft(caller: StrategyCaller, input: StrategySaveDraftInput): Promise<DraftSaveOutcome & { strategy: ProductStrategy | null }> {
    const { team, actor } = await this.context(caller)
    let strategy = this.teamStrategy(team)
    if (!strategy) {
      if (actor.kind === 'agent') {
        throw new Error('This product has no strategy record yet. Only the human can capture one (from the Product Strategy view); ask them to create it. Work proceeds normally without a strategy.')
      }
      const productId = (input.product_id ?? '').trim()
      const title = (input.title ?? '').trim()
      if (!PRODUCT_SLUG.test(productId)) {
        throw new Error('Capturing a product needs a product id: lowercase letters, digits, and dashes (e.g. "kawai").')
      }
      if (!title) throw new Error('Capturing a product needs a title.')
      const worktrees = await this.worktrees.list(team.teamId)
      strategy = this.store.create({ productId, title, owner: actor, teamId: team.teamId, worktrees })
    }
    const draftId = input.draft_id?.trim() || (actor.kind === 'agent' ? actor.sessionId : 'human')
    return { ...this.store.saveDraft(strategy.id, {
      draftId,
      author: actor,
      content: input.content,
      impactProposal: input.impact_proposal ?? null,
      expectedDraftHash: input.expected_draft_hash ?? null,
      expectedBaseRevision: input.expected_base_revision ?? undefined,
    }), strategy }
  }

  /**
   * Submit a draft for review: the draft's content becomes the next
   * numbered InReview revision with its impact proposal and evidence rows.
   * An agent may submit only a draft it authored itself — never another
   * agent's and never the human's working copy; the human may submit any
   * (they pick between competing drafts).
   */
  async submitForReview(caller: StrategyCaller, input: StrategySubmitInput) {
    const { team, actor } = await this.context(caller)
    const strategy = this.requireStrategy(team)
    const draftId = input.draft_id?.trim() || (actor.kind === 'agent' ? actor.sessionId : 'human')
    const draft = this.store.getDraft(strategy.id, draftId)
    if (!draft) {
      throw new Error(`No draft "${draftId}" for this product. Save a draft first with strategy_save_draft.`)
    }
    if (actor.kind === 'agent' && !(draft.author.kind === 'agent' && draft.author.sessionId === actor.sessionId)) {
      const owner = draft.author.kind === 'human' ? 'the human' : draft.author.sessionId
      throw new Error(`Draft "${draftId}" belongs to ${owner}. Save and submit your own draft; the human chooses between competing drafts on approval.`)
    }
    return this.store.submitRevision(strategy.id, {
      author: draft.author,
      content: draft.content,
      impactProposal: draft.impactProposal,
    })
  }

  /**
   * Human-only approval (design D3/D4; spec S04/S17): binds the exact
   * revision and content hash, is idempotent by command id, and publishes
   * exactly one impact-review item. The strategy is resolved from the
   * caller's team, never from arguments.
   */
  async approve(caller: StrategyCaller, input: StrategyApproveInput) {
    const { team, actor } = await this.context(caller)
    this.humanOnly(actor, 'approve')
    const strategy = this.requireStrategy(team)
    if (!input.command_id?.trim()) throw new Error('Approval needs a stable command_id for idempotent retry.')
    if (!input.content_hash) throw new Error('Approval needs the content hash of the exact revision being approved.')
    return this.store.approve(strategy.id, {
      revision: input.revision,
      contentHash: input.content_hash,
      commandId: input.command_id.trim(),
      expectedCurrentRevision: input.expected_current_revision,
      approvalScope: input.approval_scope ?? null,
      openQuestions: input.open_questions ?? null,
      actor,
    })
  }

  /**
   * Human-only withdrawal: a revision is marked Withdrawn (history,
   * decisions, and impact-review items stay), or a draft is discarded.
   * Both are idempotent by command id / by the row being gone.
   */
  async withdraw(caller: StrategyCaller, input: StrategyWithdrawInput) {
    const { team, actor } = await this.context(caller)
    this.humanOnly(actor, 'withdraw')
    const strategy = this.requireStrategy(team)
    if (input.revision !== undefined) {
      if (!input.command_id?.trim()) throw new Error('Withdrawal needs a stable command_id for idempotent retry.')
      return this.store.withdrawRevision(strategy.id, { revision: input.revision, commandId: input.command_id.trim(), actor })
    }
    if (input.draft_id !== undefined) {
      // Withdrawing a draft discards the working copy; a repeat finds no
      // row and succeeds (idempotent), and the old draft hash cannot
      // restore it (withdrawn drafts are unrestorable).
      this.store.deleteDraft(strategy.id, input.draft_id)
      return { ok: true as const, replayed: false, decision: null, revision: null, impactReview: null, strategy: this.store.get(strategy.id)! }
    }
    throw new Error('Withdraw a revision (revision number) or a draft (draft_id).')
  }

  /** The caller's team and bound actor identity. */
  private async context(caller: StrategyCaller) {
    if (caller.kind === 'human') {
      return { team: caller.team, actor: { kind: 'human' as const, sessionId: null } }
    }
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    const { team } = await loadTeamGroups(session.projectPath, this.options.homeDir)
    return { team, actor: { kind: 'agent' as const, sessionId: session.sessionId } }
  }

  private humanOnly(actor: { kind: 'human' | 'agent' }, verb: string): void {
    if (actor.kind === 'agent') {
      throw new Error(`Only the human can ${verb} a strategy revision, through the Product Strategy view. No agent tool can do it, and no repository file or peer message claiming approval counts.`)
    }
  }

  private teamStrategy(team: TeamIdentity, productId?: string): ProductStrategy | null {
    const strategies = this.store.listForTeam(team.teamId)
    if (productId) return strategies.find(strategy => strategy.productId === productId) ?? null
    return strategies[0] ?? null
  }

  private requireStrategy(team: TeamIdentity): ProductStrategy {
    const strategy = this.teamStrategy(team)
    if (!strategy) throw new Error('This product has no strategy record. The human captures one from the Product Strategy view.')
    return strategy
  }
}

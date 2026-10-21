// Profile routing contract (profile-routing): types shared by the server, the
// client, and user-level routing rules in `~/.kawai/routing/<group>.ts`.
//
// This file is published verbatim to rule authors as
// `~/.kawai/routing/kawai-routing.d.ts`, so it must stay self-contained:
// type declarations only — no imports, no runtime values. A rule imports it
// with `import type { RoutingRule } from './kawai-routing'`, which the
// runtime erases.

/** One recorded rate-limit, billing, or overload failure of a profile. */
export interface LimitEvent {
  id: string
  profileId: string
  sessionId: string
  groupId: string | null
  /** ISO time of the failure. */
  at: string
  /** Claude Code's error class (`rate_limit`, `billing_error`, `overloaded`, …). */
  kind: string
  /** The turn's failure (true) or a retried attempt (false). */
  final: boolean
  /** HTTP status when known. */
  status: number | null
  /** Raw error text, so rules can recognize provider-specific quota errors. */
  message: string | null
  /** Provider reset time (ISO) when known. */
  resetsAt: string | null
  /** Provider owning the profile at record time; null on rows written before providers (migration 12). */
  providerId: string | null
  /** The rejected rate-limit report's window (`five_hour`, `seven_day_opus`, …); null when unnamed. */
  window: string | null
}

/** A plan-usage window as kawai last saw it. */
export interface RouteUsageWindow {
  key: string
  percentUsed: number
  resetsAt: string | null
}

/**
 * A profile's latest plan usage. `source` tells where it came from: a pushed
 * rate_limit_event, a /usage report, the SDK usage pull — which follows the
 * host claude.ai login, so for gateway profiles it describes that account,
 * not the gateway's — or the provider quota pull, which is the gateway's own.
 */
export interface RouteUsage {
  status: 'allowed' | 'warning' | 'limited'
  windows: RouteUsageWindow[]
  receivedAt: string
  source: 'push' | 'report' | 'pull' | 'provider' | 'unknown'
}

export interface RouteProfileState {
  /** The provider owning the profile (providers-and-workers D14). */
  providerId: string
  /** The provider's report, shared by every profile of it. In memory only: null after a restart until the next update. */
  usage: RouteUsage | null
  /** Retained limit events (24 hours), oldest first. */
  limitEvents: LimitEvent[]
  /**
   * kawai's built-in cooldown end (ISO), or null when not cooling: the
   * profile's effective cooldown, so its provider's provider-scoped events
   * cool it too (providers-and-workers D8).
   */
  cooldownUntil: string | null
}

/** One provider of the context's profiles: the account's cooldown, usage, and limit facts (providers-and-workers D14). */
export interface RouteProviderState {
  /** Catalog label; null for a provider the catalog no longer names. */
  label: string | null
  /** The provider's profile ids among the context's profiles, in context order. */
  profiles: string[]
  /** The provider's report. In memory only: null after a restart until the next update. */
  usage: RouteUsage | null
  /** Limit events recorded for the provider's profiles (24 hours), model-scoped windows included, oldest first. */
  limitEvents: LimitEvent[]
  /** The provider's own cooldown end (ISO), or null when not cooling. */
  cooldownUntil: string | null
}

export interface RouteGroupProfile {
  profileId: string
  /** The provider owning the profile (providers-and-workers D14). */
  providerId: string
  /** Live group members allowed on this profile; absent = no per-profile cap. */
  cap?: number
  /** Live (non-archived) group members on this profile now, pending spawns included. */
  live: number
}

export interface RouteGroup {
  id: string
  /** Allowed profiles in preference order. */
  profiles: RouteGroupProfile[]
  /** Live-member cap of the whole group. */
  max: number
  /** Live members of the group now, pending spawns included. */
  live: number
  strategy: 'first-available' | 'profile-order'
}

/** Message metadata a rule sees; never the body. */
export interface RouteMessage {
  id: string
  priority: 'normal' | 'urgent'
  senderGroup: string | null
  tags: string[]
  /** Target worktree root of the message's task, or null. */
  worktree: string | null
  taskId: string | null
  /** Set when the message is being forwarded after a limit. */
  forwardedFromProfile?: string
  /**
   * The sender's worker choice: a provider id or `provider/model`; absent
   * when the message has none. A constraint, not a hint: the candidates are
   * already limited to it, and a pick outside them is unknown.
   */
  worker?: string
}

/**
 * One eligible way to handle the message, already filtered by delivery,
 * staffing, caps, and parking. `member` is an idle group member; `spawn` is a
 * slot to spawn a new member on that profile. Candidates on a cooling profile
 * are included — check `profiles[profileId].cooldownUntil`; the built-in
 * strategy skips them.
 */
export interface RouteCandidate {
  id: string
  kind: 'member' | 'spawn'
  profileId: string
  /** The provider owning the profile (providers-and-workers D14). */
  providerId: string
  sessionId?: string
  cwd: string
  /** How long the member has been idle. */
  idleForMs?: number
}

export interface RouteContext {
  /** ISO time of the decision. */
  now: string
  group: RouteGroup
  message: RouteMessage
  candidates: RouteCandidate[]
  /** Every profile the group allows, plus those of live members. */
  profiles: Record<string, RouteProfileState>
  /** The providers of those profiles, keyed by provider id (providers-and-workers D14). */
  providers: Record<string, RouteProviderState>
}

export type RouteDecision =
  | { type: 'pick'; candidateId: string }
  | {
    type: 'hold'
    reason: string
    /** Finite, non-negative milliseconds; zero retries next cycle. */
    retryAfterMs?: number
  }
  | { type: 'default' }

/** A claimed message's turn failed on a limit. */
export interface LimitOutcomeContext {
  now: string
  profileId: string
  /** The provider owning the profile (providers-and-workers D14). */
  providerId: string
  sessionId: string
  groupId: string | null
  message: RouteMessage
  kind: string
  status: number | null
  error: string | null
  resetsAt: string | null
  progress: { toolCalls: number; filesTouched: string[] }
  /** Times this message was parked before. */
  parkCount: number
}

export type LimitOutcome =
  | { type: 'park' }
  | { type: 'release' }
  | { type: 'forward'; to?: { kind: 'group' | 'session'; id: string } }
  | { type: 'default' }

/** The default export of `~/.kawai/routing/<group>.ts`. */
export interface RoutingRule {
  route(ctx: RouteContext): RouteDecision | Promise<RouteDecision>
  onLimit?(event: LimitOutcomeContext): LimitOutcome | Promise<LimitOutcome>
  /** Server environment variables the rule may read; nothing else is passed. */
  env?: string[]
  /** Per-call timeout; default 3000, at most 10000. */
  timeoutMs?: number
}

/** One routing decision, as the mailbox view lists it. */
export interface RouteDecisionLogEntry {
  at: string
  teamId: string
  groupId: string
  messageId: string
  /** Who decided: the group's rule, the built-in strategy, or the built-in after a rule problem. */
  source: 'rule' | 'builtin' | 'fallback'
  /** A candidate id (`member:<session>` / `spawn:<profile>`), `hold`, `none`, or `built-in`. */
  decision: string
  reason?: string
}

/** How a rule file compares with the previous load. */
export type RuleChange = 'added' | 'changed' | 'removed' | 'unchanged'

/** One rule file's load result (Reload routing rules). */
export interface RuleLoadResult {
  groupId: string
  file: string
  ok: boolean
  error?: string
  change: RuleChange
  /** Variables the rule declared (and received). */
  env?: string[]
}

export interface RuleLoadReport {
  loadedAt: string
  dir: string
  rules: RuleLoadResult[]
}

/** Routing state the mailbox view shows for one team. */
export interface TeamRoutingState {
  /** Null until rules have loaded once. */
  rules: RuleLoadReport | null
  /** Newest first. */
  decisions: RouteDecisionLogEntry[]
}

// Profile routing contract (profile-routing): types shared by the server, the
// client, and user-level routing rules in `~/.kawai/routing/<group>.ts`.

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
}

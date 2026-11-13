// The provider a recorded Codex limit event names (codex-chat-sessions D9,
// PR E 7.2). The package reports Codex limit failures (`codexLimitFailure` in
// `@motuslabs/agent-runtime/usage`: the closed kind table, the latest reset
// among the exhausted windows, no credit rule for a Codex 402), and
// runtimeEvents.ts maps them to Kawai's ChatLimitSignal. Kawai keeps the
// attribution: login- or plan-scoped kinds record once for the Codex home's
// provider (`codex-home-<12 hex>`), so every profile on the home cools
// through the shared cooldown; the session's own budget cools its profile
// alone, with no provider (task-ce05430a R2 A6).
import { codexLimitScope } from '@motuslabs/agent-runtime/usage'

/**
 * The provider a recorded Codex limit event names: the home's provider for
 * the login-scoped kinds (one event cools every profile on the home), none
 * for the session's own budget. Every other kind — a Claude kind included —
 * passes its provider through unchanged.
 */
export function codexLimitProviderId(kind: string, homeProviderId: string): string | null {
  return codexLimitScope(kind) === 'session' ? null : homeProviderId
}

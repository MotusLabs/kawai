// Example routing rule: copy to ~/.kawai/routing/devs.ts (the file name is
// the group id), then press Reload routing rules in a chat's Mailbox panel.
// The types come from kawai-routing.d.ts, which kawai writes next to your
// rules on every load; the import is type-only and erased at runtime.
import type { RouteContext, RoutingRule } from './kawai-routing'

/** Plan usage above this share counts as "nearly out" for a profile. */
const NEARLY_OUT = 90

function nearlyOut(ctx: RouteContext, profileId: string): boolean {
  const usage = ctx.profiles[profileId]?.usage
  // A pull describes the host claude.ai login, not a gateway's quota.
  if (!usage || usage.source === 'pull') return false
  return usage.windows.some(window => window.percentUsed >= NEARLY_OUT)
}

const rule: RoutingRule = {
  // Only these server variables reach the rule; everything else is absent.
  env: [],
  timeoutMs: 2000,

  route(ctx) {
    const usable = ctx.candidates.filter(candidate =>
      !ctx.profiles[candidate.profileId]?.cooldownUntil && !nearlyOut(ctx, candidate.profileId))
    // Urgent work: any idle member first, else a new member on a usable profile.
    const member = usable.filter(candidate => candidate.kind === 'member')
      .sort((a, b) => (b.idleForMs ?? 0) - (a.idleForMs ?? 0))[0]
    if (member) return { type: 'pick', candidateId: member.id }
    if (ctx.message.priority === 'urgent') {
      const spawn = usable.find(candidate => candidate.kind === 'spawn')
      if (spawn) return { type: 'pick', candidateId: spawn.id }
    }
    if (usable.length === 0 && ctx.candidates.length > 0) {
      return { type: 'hold', reason: 'every profile is cooling or nearly out', retryAfterMs: 10 * 60_000 }
    }
    return { type: 'default' }
  },

  onLimit(event) {
    // Review work is cheap to restart elsewhere; everything else follows the
    // group's onLimit frontmatter.
    if (event.message.tags.includes('review')) return { type: 'release' }
    return { type: 'default' }
  },
}

export default rule

// The context meter (context meter design): a compact chip in the chat
// header beside the session status — the share of the autocompact threshold
// in use plus the `used / threshold` token counts. Null is a state, not a
// zero (design D7): nothing renders before the first model request.
// A threshold marked approximate (design D2 steps 2–3) is a window standing
// in for the compaction threshold, and the title says so rather than claiming
// a distance to compaction the session does not know.
// Archived chats render the stored reading as inert text — no refresh
// affordance — because the agent that would refresh it is stopped.
// The compact form (narrowest header, chat-header-layout D8) shows only the
// percentage; the title and a screen-reader label still carry the counts.
import type { ChatContextUsage } from '@shared/chat'

/**
 * Compact token counts: 157.9k, 167k, 1M, 900. Rounds to one decimal of the
 * larger unit and promotes at the rounded boundary, so 999950 reads 1M
 * rather than 1000k.
 */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000) {
    const thousands = Math.round(tokens / 100) / 10
    if (thousands >= 1_000) return `${Math.round(tokens / 100_000) / 10}M`
    return `${thousands}k`
  }
  return String(Math.round(tokens))
}

export default function ChatContextMeter({ usage, compact = false }: { usage: ChatContextUsage | null; compact?: boolean }) {
  if (!usage) return null
  const percent = Math.round(usage.percentage * 10) / 10
  const title = usage.thresholdApproximate
    ? `${usage.usedTokens} of ${usage.thresholdTokens} tokens — the model window standing in for the compaction threshold, which is not known for this session (measured ${usage.at})`
    : `${usage.usedTokens} of ${usage.thresholdTokens} tokens at the compaction threshold (measured ${usage.at})`
  return (
    <span
      className="shrink-0 whitespace-nowrap text-chat-meta text-secondary tabular-nums"
      data-testid="chat-context-meter"
      title={title}
    >
      {compact ? <>
        <span aria-hidden="true">{percent}%</span>
        <span className="sr-only">Context {percent}% · {usage.usedTokens} of {usage.thresholdTokens} tokens</span>
      </> : <>Context {percent}% · {formatContextTokens(usage.usedTokens)} /{' '}
        {formatContextTokens(usage.thresholdTokens)}</>}
      {usage.thresholdApproximate ? '~' : ''}
    </span>
  )
}

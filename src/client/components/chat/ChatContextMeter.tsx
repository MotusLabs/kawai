// The context meter (context meter design): a compact chip in the chat
// header beside the session status — the share of the autocompact threshold
// in use plus the `used / threshold` token counts. Null is a state, not a
// zero (design D7): nothing renders before the first model request.
// Archived chats render the stored reading as inert text — no refresh
// affordance — because the agent that would refresh it is stopped.
import type { ChatContextUsage } from '@shared/chat'

/** Compact token counts: 157.9k, 167k, 1M, 900. */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${formatTenth(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${formatTenth(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

function formatTenth(value: number): string {
  return String(Math.round(value * 10) / 10)
}

export default function ChatContextMeter({ usage }: { usage: ChatContextUsage | null }) {
  if (!usage) return null
  const percent = Math.round(usage.percentage * 10) / 10
  return (
    <span
      className="shrink-0 whitespace-nowrap text-chat-meta text-secondary tabular-nums"
      data-testid="chat-context-meter"
      title={`${usage.usedTokens} of ${usage.thresholdTokens} tokens at the compaction threshold (measured ${usage.at})`}
    >
      Context {percent}% · {formatContextTokens(usage.usedTokens)} /{' '}
      {formatContextTokens(usage.thresholdTokens)}
    </span>
  )
}

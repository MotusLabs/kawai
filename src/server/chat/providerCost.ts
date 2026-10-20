// Provider-reported turn cost (openrouter-provider D9), SDK-free. OpenRouter
// streams the charge of each model call as `usage.cost` (USD) on the
// `message_delta` event; the SDK's own `total_cost_usd` is an estimate from
// Anthropic list prices that is far off for routed models. The driver sums
// these per turn and reports the sum beside the estimate.

/** The `usage.cost` a stream event carries: a finite, non-negative number on a `message_delta`, else null. */
export function messageDeltaCost(event: unknown): number | null {
  if (!event || typeof event !== 'object') return null
  const { type, usage } = event as { type?: unknown; usage?: unknown }
  if (type !== 'message_delta' || !usage || typeof usage !== 'object') return null
  const cost = (usage as { cost?: unknown }).cost
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
}

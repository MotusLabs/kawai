// Provider-reported turn cost (design §6, task 5.2; from Kawai's committed
// providerCost.ts). Some providers (OpenRouter) stream each model call's
// charge as `usage.cost` (USD) on a `message_delta` stream event; the SDK's
// own `total_cost_usd` is a list-price estimate. The Claude driver sums these
// per turn and reports the sum beside the estimate; a turn with none is null.

/** The `usage.cost` of a stream event: a finite, non-negative number on a `message_delta`, else null. */
export function messageDeltaCost(event: unknown): number | null {
  if (!event || typeof event !== 'object') return null
  const { type, usage } = event as { type?: unknown; usage?: unknown }
  if (type !== 'message_delta' || !usage || typeof usage !== 'object') return null
  const cost = (usage as { cost?: unknown }).cost
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
}

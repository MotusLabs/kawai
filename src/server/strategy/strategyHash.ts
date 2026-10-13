// Strategy content hashing (product-strategy design D2). Server-side only
// by construction: the client displays hashes the server sent and never
// computes one, so this lives beside the store instead of in the SDK-free
// shared module the browser bundles. The canonical serialization itself
// (`canonicalJson`) stays shared — it is pure and defines the hash input.
import { createHash } from 'node:crypto'
import type { StrategyContent } from '../../shared/productStrategy'
import { canonicalJson } from '../../shared/productStrategy'

/** SHA-256 of the canonical serialization (design D2). */
export function hashStrategyContent(content: StrategyContent): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}

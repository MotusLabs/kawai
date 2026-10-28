// Token evidence for log discovery (bounded-log-reads D3): what a bounded
// token read observed, the file generation it observed it under, and the
// token gate rows G0–G6 every consumer applies.

/**
 * A file generation from one `fstat` at the highest precision available
 * (bigint stats). Decimal strings keep it JSON- and postMessage-safe. Stat
 * checks are evidence, not an atomic snapshot: undetectable ABA is possible.
 */
export interface LogGeneration {
  dev: string
  ino: string
  size: number
  mtimeNs: string
  ctimeNs: string
}

export type TokenEvidence =
  /** Known session: new enrichment was legitimately skipped. */
  | { kind: 'known' }
  /** No usable token observation: missing, unreadable, or not counted. */
  | { kind: 'unavailable' }
  /** The whole logical input, read stably: `count` is exact. */
  | { kind: 'complete'; count: number; generation: LogGeneration; readKey: string }
  /** A bounded or unstable observation: `count` is a lower bound only. */
  | { kind: 'partial'; count: number; generation: LogGeneration | null; readKey: string }

export const KNOWN_EVIDENCE: TokenEvidence = { kind: 'known' }
export const UNAVAILABLE_EVIDENCE: TokenEvidence = { kind: 'unavailable' }

/** The fstat fields of a generation, from bigint stats. */
export interface BigIntGenerationStats {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/**
 * The generation of bigint stats, or null when it cannot be established
 * (no inode or change time, or a size beyond exact integers): such a file is
 * never cached nor served from a cache.
 */
export function generationOf(stats: BigIntGenerationStats): LogGeneration | null {
  if (stats.ino <= 0n || stats.ctimeNs <= 0n) return null
  if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  }
}

export function generationKey(generation: LogGeneration): string {
  const { dev, ino, size, mtimeNs, ctimeNs } = generation
  return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`
}

/**
 * The empty-cache key of evidence: only a complete zero with its generation
 * and read key (agent, mode, options) has one. Everything else is never
 * admitted to, nor matched against, an empty cache.
 */
export function emptyCacheKey(evidence: TokenEvidence): string | null {
  if (evidence.kind !== 'complete' || evidence.count !== 0) return null
  return `${generationKey(evidence.generation)}|${evidence.readKey}`
}

/**
 * Reuse of an empty cache (path -> key of a C(0)): the cached complete zero
 * when this evidence observed the same generation and read key, evaluated
 * by the caller's current gate. A stale or unverifiable entry is dropped.
 */
export function reuseEmptyCache(
  cache: Map<string, string>,
  logPath: string,
  evidence: TokenEvidence
): TokenEvidence | null {
  const cached = cache.get(logPath)
  if (cached === undefined) return null
  if (
    (evidence.kind === 'complete' || evidence.kind === 'partial') &&
    evidence.generation &&
    cached === `${generationKey(evidence.generation)}|${evidence.readKey}`
  ) {
    return { kind: 'complete', count: 0, generation: evidence.generation, readKey: evidence.readKey }
  }
  cache.delete(logPath)
  return null
}

export type TokenGateVerdict = 'pass' | 'known' | 'unavailable' | 'empty' | 'below'

/**
 * The token predicate alone, rows G0–G6 (design D3). Metadata, exclusion,
 * window, and skip-pattern prerequisites still apply independently.
 * - G0 U: never creates eligibility.
 * - G1 K: the consumer keeps its existing known behavior.
 * - G2 P(n): passes whatever n and minimum.
 * - G3 C(n), minimum ≤ 0: passes.
 * - G4 C(n ≥ minimum): passes.
 * - G5 C(0), minimum > 0: rejected as proven empty.
 * - G6 C(0 < n < minimum): rejected below threshold, never called empty.
 */
export function tokenGate(evidence: TokenEvidence, minimum: number): TokenGateVerdict {
  switch (evidence.kind) {
    case 'unavailable':
      return 'unavailable'
    case 'known':
      return 'known'
    case 'partial':
      return 'pass'
    case 'complete':
      if (minimum <= 0 || evidence.count >= minimum) return 'pass'
      return evidence.count === 0 ? 'empty' : 'below'
  }
}

/** The worker gates' reading: known sessions pass as they always have. */
export function passesMatchTokenGate(evidence: TokenEvidence, minimum: number): boolean {
  const verdict = tokenGate(evidence, minimum)
  return verdict === 'pass' || verdict === 'known'
}

/** Evidence summary for logs: kind and count, never the generation. */
export function describeEvidence(evidence: TokenEvidence): string {
  return evidence.kind === 'complete' || evidence.kind === 'partial'
    ? `${evidence.kind}(${evidence.count})`
    : evidence.kind
}

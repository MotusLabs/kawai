// The execution pin and its three-way match (plan-workspace 2.4, design D4;
// fix round findings B1 and O1). The pin is worktree-scoped: the newest
// attempt of the execution change provisioned in the document's worktree —
// never another change's attempt, and nothing for a worktree no change
// occupies (the main checkout included). The comparison is
// convention-comparable: the attempt manifest hashes `git show`'s stdout
// decoded as UTF-8 and cut at the git output bound (executionDispatch.ts
// artifactsAt, gitCommand.ts GIT_MAX_OUTPUT_BYTES), while the reader hashes
// raw bytes, so current bytes compare only when the two conventions provably
// agree — markdown, within the bound, fatally valid UTF-8, no BOM. Anything
// else reads `unknown`, never a false mismatch.
import { GIT_MAX_OUTPUT_BYTES } from '../../git/gitCommand'
import type { WorkspaceExecutionMatch } from '../../../shared/planWorkspace'
import type { AttemptRow, ChangeRow, ExecutionRow } from '../execution/executionRows'

/** Both pin sides compare normalized repo-relative paths (B7). */
export const normalizePinPath = (value: string): string => value.replace(/^\.\//, '').replace(/\\/g, '/')

export interface ExecutionPin {
  executionId: string
  artifacts: Record<string, string>
}

/**
 * The read-only execution surface the pin reads (D5, O4): accessors only —
 * no writer is reachable through it, and the real ExecutionStore satisfies
 * it structurally.
 */
export interface ExecutionPinStore {
  execution(id: string): ExecutionRow | null
  latestForPlan(planId: string): ExecutionRow | null
  changes(executionId: string): ChangeRow[]
  latestAttemptForChange(executionId: string, change: string): AttemptRow | null
}

/** The current side of the comparison: the reader's successful payload. */
export interface CurrentDocument {
  kind: 'markdown' | 'image'
  hash: string
  size: number
  bytes: Uint8Array
}

const startsWithUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf

/** A fatal UTF-8 decode of the bytes, or null when they are not valid UTF-8. */
function comparableUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * The pin's three-way rule (D4, CP1 §5 as amended by B1/O1): comparable and
 * equal → `match`, comparable and different → `mismatch`, and everything the
 * pin contract cannot speak for reads `unknown` — no pin, the path absent
 * from the attempt's map, an image, a file past the bound, invalid UTF-8, a
 * BOM, or no current content. The manifest hashes git show's UTF-8-decoded
 * stdout string cut at GIT_MAX_OUTPUT_BYTES characters; raw bytes re-encode
 * to exactly that string only under the comparable gate (bytes within the
 * bound imply the string within it, so the cut never bites), so equality is
 * meaningful there and unknown everywhere else (D4: a missing identity is
 * never a mismatch).
 */
export function executionMatchFor(
  pin: ExecutionPin | null,
  relativePath: string,
  current: CurrentDocument | null,
): { match: WorkspaceExecutionMatch; executionId: string | null } {
  if (current === null) return { match: 'unknown', executionId: pin?.executionId ?? null }
  if (!pin) return { match: 'unknown', executionId: null }
  const comparable =
    current.kind === 'markdown' &&
    current.size <= GIT_MAX_OUTPUT_BYTES &&
    !startsWithUtf8Bom(current.bytes) &&
    comparableUtf8(current.bytes) !== null
  if (!comparable) return { match: 'unknown', executionId: pin.executionId }
  const pinned = pin.artifacts[normalizePinPath(relativePath)]
  if (pinned === undefined) return { match: 'unknown', executionId: pin.executionId }
  return { match: pinned === current.hash ? 'match' : 'mismatch', executionId: pin.executionId }
}

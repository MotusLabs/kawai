// effectOutcome.ts - The D14 classification of a failed git or gh call:
// transient (network errors, timeouts, a push the remote failed on its own
// side, 5xx responses, 429, and GitHub's rate limits — retried with the
// 30s/2m/10m backoff, then effect-failed) or permanent (a refused push, a
// refused merge, every other 4xx, and a gh spawn failure — failed at once).
// A call that succeeded never reaches
// here. The input is either adapter's error shape; the classifier is pure
// so the runner, tests, and any inspector agree.
import type { GithubError } from './github'
import type { GitRemoteError } from './gitRemote'

export type EffectFailureClass = 'transient' | 'permanent'

/** Git's own wording for a network-level failure; anything else it exits non-zero for is a refusal. */
const NETWORK_STDERR = /could not resolve host|connection timed out|connection refused|connection reset|network is unreachable|connection was closed|unexpected disconnect|timed out/i

/**
 * A ref the remote failed to update for no reason of the push's own: GitHub's
 * `remote: fatal error in commit_refs` then `! [remote rejected] <sha> -> <ref>
 * (failure)`. A refusal names its cause there instead (`non-fast-forward`,
 * `pre-receive hook declined`, `protected branch hook declined`) and repeating
 * it cannot help. Retrying is safe: the push adapter reads the branch first.
 */
const REMOTE_REF_FAILURE = /\[remote rejected\][^\n]*\((?:failure|internal server error)\)/i

/** GitHub rate-limit wording gh reports, primary or secondary, either as 403 or 429. */
const RATE_LIMIT = /rate limit/i

export function classifyEffectFailure(error: GitRemoteError | GithubError): EffectFailureClass {
  // gh never ran: retrying a spawn failure cannot succeed (gh is missing or
  // the context is broken), so it is permanent — typed by the adapter, never
  // inferred from wording. The git shape carries no such marker, and an
  // unknown null exit (a killed process, a timeout) stays transient below.
  if ('spawnFailure' in error && error.spawnFailure === true) return 'permanent'
  // No exit of its own: a timeout — transient for both adapters.
  if (error.exitCode === null) return 'transient'
  if ('httpStatus' in error) {
    const status = error.httpStatus
    if (status !== null && (status >= 500 || status === 429)) return 'transient'
    if (RATE_LIMIT.test(error.message)) return 'transient'
    return 'permanent'
  }
  return NETWORK_STDERR.test(error.stderr) || REMOTE_REF_FAILURE.test(error.stderr) ? 'transient' : 'permanent'
}

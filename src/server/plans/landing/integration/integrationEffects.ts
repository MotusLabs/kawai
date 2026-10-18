// integrationEffects.ts - The effect adapters integration landing owns
// (integration-candidates D4, D5):
// - `create-integration`, an execution-level effect: the branch at the
//   default head through the ref API. A 422 is read back: a ref at the
//   requested commit, or one this plan's record holds, is our own success;
//   any other is a foreign branch, and the effect fails naming it.
// - `fast-forward`: the non-forced ref update to a passed candidate. A 422
//   settles as refused, with origin's head re-read, so the follow-on applies
//   D6's moved and rewritten rules.
import type { EffectAdapter, EffectCallResult } from '../../execution/effects'
import type { EffectRow } from '../../execution/executionRows'
import type { GhCommandOptions } from '../ghCommand'
import { gitFetch, isAncestor, lsRemoteHead } from '../gitRemote'
import type { IntegrationBranchRecord } from '../../../../shared/planIntegration'
import { ghCreateRef, ghFastForwardRef } from '../github'

export interface IntegrationAdapters {
  createRef: typeof ghCreateRef
  fastForwardRef: typeof ghFastForwardRef
  lsRemoteHead: typeof lsRemoteHead
  fetch: typeof gitFetch
  isAncestor: typeof isAncestor
}

export const integrationAdapters: IntegrationAdapters = { createRef: ghCreateRef, fastForwardRef: ghFastForwardRef, lsRemoteHead, fetch: gitFetch, isAncestor }

const is422 = (error: { httpStatus?: number | null }) => 'httpStatus' in error && error.httpStatus === 422
const failure = (argv: string[], stderr: string): EffectCallResult => ({ ok: false, error: { argv, exitCode: 1, stderr } })

/** The create-integration effect (D4); `record` reads the branch's row for the 422 read-back. */
export function createIntegrationAdapter(
  adapters: IntegrationAdapters,
  record: (teamId: string, branch: string) => IntegrationBranchRecord | null,
  ghOptions?: GhCommandOptions,
): EffectAdapter {
  return {
    async call(effect: EffectRow): Promise<EffectCallResult> {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const branch = String(command.branch ?? '')
      const sha = String(command.sha ?? '')
      const created = await adapters.createRef(repo, branch, sha, ghOptions)
      if (created.ok) return { ok: true, outcome: { created: true, sha } }
      if (!is422(created.error)) return { ok: false, error: created.error }
      const head = await adapters.lsRemoteHead(String(command.cwd ?? ''), `refs/heads/${branch}`)
      if (!head.ok) return { ok: false, error: head.error }
      if (head.sha === sha) return { ok: true, outcome: { created: true, sha } }
      const row = record(String(command.teamId ?? ''), branch)
      if (head.sha !== null && row !== null && row.planId === command.planId) return { ok: true, outcome: { created: false, reused: true, sha: head.sha } }
      return failure(['gh', 'api', 'git/refs'], `foreign-branch: the integration branch "${branch}" already exists on origin at ${head.sha ?? 'an unreadable head'}, and no execution of this plan created it; Kawai never adopts it.`)
    },
  }
}

/** The fast-forward effect (D5): C onto the integration branch, never forced. */
export function fastForwardAdapter(adapters: IntegrationAdapters, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect: EffectRow): Promise<EffectCallResult> {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const branch = String(command.branch ?? '')
      const sha = String(command.sha ?? '')
      const updated = await adapters.fastForwardRef(repo, branch, sha, ghOptions)
      if (updated.ok) return { ok: true, outcome: { fastForwarded: true, head: sha } }
      if (!is422(updated.error)) return { ok: false, error: updated.error }
      const head = await adapters.lsRemoteHead(String(command.cwd ?? ''), `refs/heads/${branch}`)
      if (!head.ok) return { ok: false, error: head.error }
      return { ok: true, outcome: { fastForwarded: false, refused: true, head: head.sha } }
    },
  }
}

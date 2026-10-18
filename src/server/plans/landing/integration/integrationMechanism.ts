// integrationMechanism.ts - The `integration-branch` landing mechanism
// (integration-candidates D2, D4-D6). Its base is the plan's integration
// branch: Start records it as the execution's base branch and issues the
// execution-level `create-integration` effect when it is missing; each
// worktree starts from the branch's head on origin when it is provisioned.
// A passed change runs direct landing's steps 1 to 3 unchanged, then its
// own final step: the rewritten check against the reference commit, the
// exact candidate (the round's commit over the head it contains, with the
// owner's outside commits named), and the non-forced `fast-forward` effect.
// A fast-forward that lands records the candidate landed, the landing fact
// (head = merge = C, tree verified, no post-merge CI), and the change landed
// in one transaction; a refused one re-reads the head and applies D6.
import { runGit } from '../../../git/gitCommand'
import { logger } from '../../../logger'
import { referenceCommit } from '../../../../shared/planIntegration'
import type { IntegrationBranchRecord, IntegrationCandidate, OutsideCommit } from '../../../../shared/planIntegration'
import type { EffectKind } from '../../../../shared/planExecution'
import type { ChangeRow, EffectRow, ExecutionRow } from '../../execution/executionRows'
import type { ExecutionStore } from '../../execution/executionStore'
import { afterLanded, applyLanding, applyLandingOutcome, updateBranchAdapter, type LandingDeps, type LandingAdapters } from '../../execution/executionLanding'
import type { LandingMechanism } from '../landingMechanisms'
import { probeIntegrationLanding } from './integrationProbe'
import { createIntegrationAdapter, fastForwardAdapter, integrationAdapters, type IntegrationAdapters } from './integrationEffects'
import type { IntegrationStore } from './integrationStore'

/** The execution's branch record; a done creation the crash window left unrecorded is recorded first. */
export function branchRecordOf(store: IntegrationStore, executions: ExecutionStore, execution: ExecutionRow): IntegrationBranchRecord | null {
  const record = store.branch(execution.teamId, execution.baseBranch)
  if (record !== null) return record
  const created = executions.effectsOf(execution.id).filter(effect => effect.change === null && effect.kind === 'create-integration' && effect.state === 'done').at(-1)
  if (created === undefined) return null
  recordCreated(store, created)
  return store.branch(execution.teamId, execution.baseBranch)
}

function recordCreated(store: IntegrationStore, effect: EffectRow): void {
  const outcome = effect.outcome as { created?: unknown; sha?: unknown } | null
  // A reused branch (our own record, found by the 422 read-back) keeps its creation fields.
  if (outcome?.created !== true || typeof outcome.sha !== 'string') return
  const command = effect.command
  store.recordCreation({
    teamId: String(command.teamId ?? ''), branch: String(command.branch ?? ''), planId: String(command.planId ?? ''),
    targetBranch: String(command.target ?? ''), executionId: effect.executionId, sha: outcome.sha,
  })
}

/** `git log <reference>..<head>`: the commits the owner put on the branch outside Kawai's landings (D5). */
async function outsideCommits(cwd: string, reference: string, head: string): Promise<OutsideCommit[] | null> {
  if (reference === head) return []
  const listed = await runGit(['log', '--format=%H%x00%an%x00%s', `${reference}..${head}`], { cwd })
  if (!listed.ok) return null
  return listed.stdout.split('\n').filter(line => line !== '').map(line => {
    const [sha = '', author = '', subject = ''] = line.split('\0')
    return { sha, author, subject }
  })
}

/** D6's rewritten rule: the change stops, naming the head and the missing commit; Retry checks again. */
function stopRewritten(executions: ExecutionStore, row: ChangeRow, branch: string, head: string | null, reference: string): void {
  stopIntegration(executions, row, {
    message: head === null
      ? `The integration branch "${branch}" is missing on origin, so it lacks ${reference}, which Kawai landed or created. Kawai never re-creates it under a landing; restore the branch, then Retry.`
      : `The integration branch "${branch}" was rewritten: its head ${head} lacks ${reference}, which Kawai landed or created. Kawai never forces it; restore the branch, then Retry.`,
    names: head === null ? [`refs/heads/${branch}`, reference] : [head, reference],
  })
}

/** No branch record for the execution's base: nothing names the reference commit, so the change stops rather than loop (review F1). */
function stopUnrecorded(executions: ExecutionStore, row: ChangeRow, branch: string): void {
  stopIntegration(executions, row, {
    message: `The integration branch "${branch}" has no creation record, so its reference commit is unknown and Kawai cannot check it was not rewritten. Retry once the record is restored.`,
    names: [`refs/heads/${branch}`],
  })
}

function stopIntegration(executions: ExecutionStore, row: ChangeRow, detail: { message: string; names: string[] }): void {
  const fresh = executions.change(row.executionId, row.change)
  if (fresh === null || fresh.state !== 'landing') return
  executions.transition(row.executionId, row.change, fresh, {
    state: 'stopped', stopReason: 'integration-rewritten', step: null,
    stopDetail: { ...detail, resumeState: 'landing' },
  })
}

export function integrationMechanism(store: IntegrationStore, adapters: IntegrationAdapters = integrationAdapters): LandingMechanism {
  /** D5's final step, after direct's steps 1 to 3: the rewritten check, the candidate, the fast-forward. */
  async function finish(deps: LandingDeps, row: ChangeRow, at: { execution: ExecutionRow; roundId: string; resultId: string; head: string; base: string; cwd: string }): Promise<void> {
    const executions = deps.executions
    if (row.step === 'merging') return
    const record = branchRecordOf(store, executions, at.execution)
    if (record === null) return stopUnrecorded(executions, row, at.execution.baseBranch)
    const reference = referenceCommit(record, store.candidates(record.teamId, record.branch))
    const contains = await adapters.isAncestor(at.cwd, reference, at.base)
    if (!contains.ok) return
    if (!contains.ancestor) return stopRewritten(executions, row, record.branch, at.base, reference)
    let candidate: IntegrationCandidate | null = store.candidateOf(row.executionId, row.change)
    if (candidate !== null && candidate.state !== 'verifying' && candidate.state !== 'passed') candidate = null
    if (candidate !== null && (candidate.commitSha !== at.head || candidate.baselineSha !== at.base)) {
      // An older candidate over another head: the branch moved (D6), or a new round replaced it.
      store.transitionCandidate(candidate.id, 'superseded')
      candidate = null
    }
    if (candidate === null) {
      const outside = await outsideCommits(at.cwd, reference, at.base)
      const tree = await runGit(['rev-parse', `${at.head}^{tree}`], { cwd: at.cwd })
      if (outside === null || !tree.ok) return
      candidate = store.insertCandidate({
        teamId: record.teamId, branch: record.branch, kind: 'increment', executionId: row.executionId, change: row.change,
        resultId: at.resultId, roundId: at.roundId, baselineSha: at.base, commitSha: at.head, treeSha: tree.stdout.trim(),
        outside: outside.length > 0 ? outside : null, state: 'passed',
      })
    } else if (candidate.state === 'verifying') {
      // A carried round's candidate: its own CI passed, so the round reached landing (D7).
      candidate = store.transitionCandidate(candidate.id, 'passed')
    }
    const passed = candidate
    executions.atomically(() => {
      const fresh = executions.change(row.executionId, row.change)
      if (fresh === null || fresh.state !== 'landing' || fresh.step === 'merging') return
      executions.transition(row.executionId, row.change, fresh, { step: 'merging' })
      executions.insertEffect({
        executionId: row.executionId, change: row.change, roundId: at.roundId, kind: 'fast-forward',
        effectKey: `${row.executionId}:${row.change}:fast-forward:${passed.seq}:${fresh.generation}`,
        command: { repo: deps.repo, branch: record.branch, sha: at.head, base: at.base, cwd: at.cwd, candidateId: passed.id },
      })
    })
  }

  /** The fast-forward's follow-on (D5, D6): landed in one transaction, or the moved and rewritten rules. */
  async function fastForwarded(deps: LandingDeps, effect: EffectRow): Promise<void> {
    const executions = deps.executions
    if (effect.change === null) return
    const row = executions.change(effect.executionId, effect.change)
    const execution = executions.execution(effect.executionId)
    if (row === null || row.state !== 'landing' || execution === null) return
    const command = effect.command
    const sha = String(command.sha ?? '')
    const cwd = String(command.cwd ?? row.worktree ?? deps.team.groupsRoot)
    const candidateId = String(command.candidateId ?? '')
    const outcome = effect.outcome as { fastForwarded?: boolean; head?: string | null } | null
    let landed = outcome?.fastForwarded === true
    if (!landed) {
      const head = outcome?.head ?? null
      const record = branchRecordOf(store, executions, execution)
      if (record === null) return stopUnrecorded(executions, row, execution.baseBranch)
      // A missing branch lacks the reference commit too: D6's rewritten rule (review F1).
      if (head === null) return stopRewritten(executions, row, record.branch, null, referenceCommit(record, store.candidates(record.teamId, record.branch)))
      if (!(await adapters.fetch(cwd, 'origin', `refs/heads/${record.branch}`)).ok) return
      const containsC = await adapters.isAncestor(cwd, sha, head)
      if (!containsC.ok) return
      landed = containsC.ancestor
      if (!landed) {
        const reference = referenceCommit(record, store.candidates(record.teamId, record.branch))
        const containsReference = await adapters.isAncestor(cwd, reference, head)
        if (!containsReference.ok) return
        if (!containsReference.ancestor) return stopRewritten(executions, row, record.branch, head, reference)
        // Moved (D6): the candidate is superseded, and the change returns to the
        // up-to-date step keeping the slot; its next candidate names the outside commits.
        executions.atomically(() => {
          store.transitionCandidate(candidateId, 'superseded')
          executions.transition(effect.executionId, effect.change!, row, { step: 'up-to-date' })
        })
        return
      }
    }
    executions.atomically(() => {
      const fresh = executions.change(effect.executionId, effect.change!)
      if (fresh === null || fresh.state !== 'landing') return
      if (store.candidate(candidateId)?.state === 'passed') store.transitionCandidate(candidateId, 'landed')
      executions.insertLanding({
        planId: execution.planId, change: effect.change!, executionId: effect.executionId, teamId: execution.teamId,
        mechanism: 'integration-branch', prNumber: fresh.prNumber, prUrl: fresh.prUrl,
        headSha: sha, baseSha: String(command.base ?? ''), mergeSha: sha, treeVerified: true,
      })
      executions.transition(effect.executionId, effect.change!, fresh, { state: 'landed', step: null })
    })
    await afterLanded(deps, row, effect.executionId, sha)
  }

  return {
    mode: 'integration-branch',
    probe: (input, options) => probeIntegrationLanding({
      ...input,
      branch: input.landing.mode === 'integration-branch' ? input.landing.branch : '',
      record: (teamId, branch) => store.branch(teamId, branch),
    }, options),
    async startBase(input) {
      // D2: the integration branch's head on origin when the worktree is provisioned.
      const head = await input.lsRemoteHead(input.repo, `refs/heads/${input.execution.baseBranch}`)
      if (!head.ok) return { ok: false, error: head.error }
      if (head.sha === null) {
        return { ok: false, error: { argv: ['git', 'ls-remote', 'origin', input.execution.baseBranch], exitCode: 1, stderr: `the integration branch "${input.execution.baseBranch}" is missing on origin` } }
      }
      return { ok: true, sha: head.sha }
    },
    startEffects({ execution, probe, main }) {
      // D4: a missing branch is created at the default head before anything provisions.
      if (probe.integration === undefined || probe.integration.exists || probe.repo === null) return []
      return [{
        kind: 'create-integration' as EffectKind,
        effectKey: `${execution.id}::create-integration:1`,
        command: { repo: probe.repo, branch: probe.integration.branch, sha: execution.baseCommit, target: probe.integration.target, planId: execution.planId, teamId: execution.teamId, cwd: main },
      }]
    },
    roundFailed(round) {
      // D7: a carried round whose CI failed fails its candidate; the branch keeps its head.
      const candidate = store.candidateOf(round.executionId, round.change)
      if (candidate !== null && candidate.roundId === round.id && candidate.state === 'verifying') store.transitionCandidate(candidate.id, 'failed')
    },
    effectDone(effect) {
      if (effect.kind === 'create-integration') recordCreated(store, effect)
    },
    land: (deps, landing, row, round) => applyLanding(deps, landing, row, round, (fresh, at) => finish(deps, fresh, { ...at, roundId: round.id, resultId: round.resultId }), fresh => baseMissing(deps, fresh)),
    async landOutcome(deps, effect, landing) {
      if (effect.kind === 'fast-forward') return fastForwarded(deps, effect)
      await applyLandingOutcome(deps, effect, landing)
      if (effect.kind === 'update-branch') await recordCarriedCandidate(deps, effect)
    },
    effectAdapter(kind, landing: LandingAdapters, ghOptions) {
      if (kind === 'update-branch') return updateBranchAdapter(landing, ghOptions)
      if (kind === 'fast-forward') return fastForwardAdapter(adapters, ghOptions)
      if (kind === 'create-integration') return createIntegrationAdapter(adapters, (teamId, branch) => store.branch(teamId, branch), ghOptions)
      return undefined
    },
  }

  /** Step 3 found the integration branch absent on origin: it lacks the reference commit, so D6 stops the change (review F1). */
  function baseMissing(deps: LandingDeps, row: ChangeRow): void {
    const execution = deps.executions.execution(row.executionId)
    if (execution === null) return
    const record = branchRecordOf(store, deps.executions, execution)
    if (record === null) return stopUnrecorded(deps.executions, row, execution.baseBranch)
    stopRewritten(deps.executions, row, record.branch, null, referenceCommit(record, store.candidates(record.teamId, record.branch)))
  }

  /**
   * D5: a clean branch update carried the round onto H'; its candidate is
   * `verifying` until the carried round's CI decides (D7). The baseline is
   * the integration head the update merged, when it is still that head.
   */
  async function recordCarriedCandidate(deps: LandingDeps, effect: EffectRow): Promise<void> {
    if (effect.change === null) return
    const executions = deps.executions
    const execution = executions.execution(effect.executionId)
    const round = executions.rounds(effect.executionId, effect.change).at(-1) ?? null
    if (execution === null || round === null || round.carriedFrom === null || round.carriedFrom !== effect.roundId) return
    if (store.candidates(execution.teamId, execution.baseBranch).some(candidate => candidate.roundId === round.id)) return
    const record = branchRecordOf(store, executions, execution)
    const cwd = executions.change(effect.executionId, effect.change)?.worktree ?? deps.team.groupsRoot
    if (record === null) return
    const base = await adapters.lsRemoteHead(cwd, `refs/heads/${record.branch}`)
    const tree = await runGit(['rev-parse', `${round.commitSha}^{tree}`], { cwd })
    if (!base.ok || base.sha === null || !tree.ok) return
    const merged = await adapters.isAncestor(cwd, base.sha, round.commitSha)
    if (!merged.ok || !merged.ancestor) return
    const reference = referenceCommit(record, store.candidates(record.teamId, record.branch))
    const outside = await outsideCommits(cwd, reference, base.sha)
    if (outside === null) return
    store.insertCandidate({
      teamId: record.teamId, branch: record.branch, kind: 'increment', executionId: effect.executionId, change: effect.change,
      resultId: round.resultId, roundId: round.id, baselineSha: base.sha, commitSha: round.commitSha, treeSha: tree.stdout.trim(),
      outside: outside.length > 0 ? outside : null, state: 'verifying',
    })
    logger.info('plan_integration_candidate_verifying', { executionId: effect.executionId, change: effect.change, commit: round.commitSha })
  }
}

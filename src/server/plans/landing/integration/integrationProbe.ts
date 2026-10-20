// integrationProbe.ts - The integration branch rules (integration-candidates
// D2), added to direct's repository checks (git, a GitHub origin, gh auth
// and write permission, the floor map). Each failing rule is a
// `landing-ready` finding naming the branch:
// - it is not the default branch (`gh repo view`'s default branch);
// - it is not a change name of the plan (plan content);
// - it exists on `origin` only with this plan's record (`ls-remote`,
//   `plan_integration_branches`);
// - no other plan's record holds it (`plan_integration_branches`).
// `plan-validation`'s `branch-free` covers open plans at validation time;
// the record rule also covers closed plans, and reads `origin` at Start.
// Like the direct probe, it writes nothing: no fetch, no ref, no record.
// The base it returns is the integration branch's head on `origin`, or the
// default head while the branch is missing (D2).
import type { IntegrationBranchRecord } from '../../../../shared/planIntegration'
import { ghCommitTree, type GithubOutcome } from '../github'
import type { GhCommandOptions } from '../ghCommand'
import { lsRemoteHead } from '../gitRemote'
import { probeLanding, type ProbeFinding, type ProbeInput, type ProbeResult } from '../landingProbe'

export interface IntegrationProbeInput extends ProbeInput {
  teamId: string
  planId: string
  /** The plan's integration branch (C1's `landing.branch`). */
  branch: string
  /** The branch record, read from the integration store. */
  record: (teamId: string, branch: string) => IntegrationBranchRecord | null
}

/** D2's four rules over the direct probe's facts; the findings, and whether the branch exists on origin with its head. */
export async function integrationBranchFindings(
  input: IntegrationProbeInput,
  defaultBranch: string | null,
): Promise<{ findings: ProbeFinding[]; head: string | null }> {
  const findings: ProbeFinding[] = []
  const name = input.branch
  const finding = (message: string) => findings.push({ code: 'integration-branch', message })
  if (defaultBranch !== null && name === defaultBranch) {
    finding(`The integration branch "${name}" is the repository's default branch; name a branch of its own.`)
  }
  if (input.changes.includes(name)) {
    finding(`The integration branch "${name}" is also a change name of the plan; name it apart from the changes.`)
  }
  const record = input.record(input.teamId, name)
  if (record !== null && record.planId !== input.planId) {
    finding(`The integration branch "${name}" belongs to another plan (${record.planId}); name another branch.`)
  }
  const remote = await lsRemoteHead(input.main, `refs/heads/${name}`)
  if (!remote.ok) {
    finding(`The integration branch "${name}" could not be read on origin: ${remote.error.stderr.trim() || 'git ls-remote failed'}`)
    return { findings, head: null }
  }
  if (remote.sha !== null && record === null) {
    finding(`The integration branch "${name}" already exists on origin, and no execution of this plan created it; Kawai never adopts a branch it did not create.`)
  }
  return { findings, head: remote.sha }
}

/** The probe's GitHub-facing reads: direct's checks and a commit's tree (the development fixture passes its own). */
export interface IntegrationProbeReads {
  direct?: (input: ProbeInput, options: GhCommandOptions) => Promise<ProbeResult>
  commitTree?: (repo: string, sha: string, options: GhCommandOptions) => Promise<GithubOutcome<string>>
}

/**
 * The integration mechanism's probe (D2): direct's checks, then the branch
 * rules. The base becomes the integration branch at its head on origin, or
 * at the default head (and tree) while the branch is missing.
 */
export async function probeIntegrationLanding(input: IntegrationProbeInput, options: GhCommandOptions = {}, reads: IntegrationProbeReads = {}): Promise<ProbeResult> {
  const direct = await (reads.direct ?? probeLanding)(input, options)
  const defaultBase = direct.base
  const rules = await integrationBranchFindings(input, defaultBase?.branch ?? null)
  const findings = [...direct.findings, ...rules.findings]
  if (defaultBase === null) return { findings, repo: direct.repo, base: null }
  const integration = { branch: input.branch, target: defaultBase.branch, exists: rules.head !== null }
  if (rules.head === null) {
    return { findings, repo: direct.repo, base: { branch: input.branch, head: defaultBase.head, tree: defaultBase.tree }, integration }
  }
  // GitHub needs the repository; an injected reader (the fixture's) answers without one.
  const tree = direct.repo === null && reads.commitTree === undefined ? null
    : await (reads.commitTree ?? ghCommitTree)(direct.repo ?? '', rules.head, options)
  if (tree === null || !tree.ok) {
    findings.push({ code: 'base-branch', message: `The integration branch's tree could not be read${tree !== null && !tree.ok ? `: ${tree.error.message}` : '.'}` })
    return { findings, repo: direct.repo, base: null, integration }
  }
  return { findings, repo: direct.repo, base: { branch: input.branch, head: rules.head, tree: tree.data }, integration }
}

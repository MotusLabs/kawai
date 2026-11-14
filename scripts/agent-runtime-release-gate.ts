// Fail-closed local decision used by the package release workflow. This
// checks eligibility only; registry publication and acceptance are owner work.
export interface ReleaseInput {
  event: string
  ref: string
  sha: string
  version: string
  companionVersion: string
  changelog: string
  checks: string
  acceptedSha: string
  nativeSha: string
  authorizedSha: string
}

export function releaseErrors(input: ReleaseInput): string[] {
  const errors: string[] = []
  if (input.event !== 'push') errors.push('trusted tag push required')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version)) errors.push('stable semver required')
  if (input.ref !== `refs/tags/agent-runtime-v${input.version}`) errors.push('tag/version mismatch')
  if (input.companionVersion !== input.version) errors.push('companion/version mismatch')
  if (!input.changelog.split('\n').includes(`## ${input.version}`)) errors.push('exact changelog entry required')
  if (input.checks !== 'success') errors.push('current-commit checks must succeed')
  if (!/^[0-9a-f]{40}$/.test(input.sha)) errors.push('full source SHA required')
  for (const key of ['acceptedSha', 'nativeSha', 'authorizedSha'] as const) {
    if (input[key] !== input.sha) errors.push(`${key} must name this exact source commit`)
  }
  return errors
}

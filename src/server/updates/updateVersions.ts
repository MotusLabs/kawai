// updateVersions.ts - release-version comparison for update discovery.
// Every merge to master cuts a release, so "any newer tag" would fire
// constantly; discovery therefore compares only the MAJOR.MINOR.PATCH base
// and ignores the -<PR> build suffix (and the -dev marker of source runs).

/**
 * The `MAJOR.MINOR.PATCH` base of a version or tag, or null when it does not
 * parse. Accepts a leading `v` (tag form) and any `-suffix`.
 */
export function baseOf(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version.trim())
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

/**
 * Whether `latest` is a newer release than `running`, comparing bases only:
 * a newer PR build of the same base is not an update, and neither is a
 * running build at or ahead of the latest. Unparseable versions are never an
 * update (fail silent, like every other discovery error).
 */
export function isNewerBase(latest: string, running: string): boolean {
  const latestBase = baseOf(latest)
  const runningBase = baseOf(running)
  if (latestBase === null || runningBase === null) return false
  return compareBases(latestBase, runningBase) > 0
}

/** Segment-wise numeric compare: `1.10.0` sorts above `1.9.0`. */
function compareBases(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! - right[i]!
  }
  return 0
}

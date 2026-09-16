/**
 * src/server/version.ts
 *
 * The build version this process reports.
 *
 * `package.json` holds the plain `MAJOR.MINOR.PATCH` base, bumped by hand via
 * `bun run release:*`. CI appends the merged PR number as a prerelease
 * identifier so every merge into master gets its own tag — base `1.0.0` plus
 * PR 321 becomes `v1.0.0-321` — and the release build bakes that full version
 * into the binary with `bun build --define` (see
 * .github/workflows/release.yml).
 *
 * Nothing injects it for `bun run dev`, `bun start` or tests, so those fall
 * back to the base version marked `-dev`: local logs must never be mistakable
 * for a release build's.
 */
import packageJson from '../../package.json'

/** Plain semver base from package.json, with no CI suffix. */
export const BASE_VERSION: string = packageJson.version

/**
 * Resolve the version to report. `injected` is the `--define`-substituted
 * expression at build time and a real environment variable otherwise, which
 * also lets a developer pin a version locally without rebuilding.
 */
export function resolveBuildVersion(
  injected: string | undefined = process.env.KAWAI_BUILD_VERSION,
): string {
  const trimmed = injected?.trim()
  return trimmed ? trimmed : `${BASE_VERSION}-dev`
}

export const BUILD_VERSION: string = resolveBuildVersion()

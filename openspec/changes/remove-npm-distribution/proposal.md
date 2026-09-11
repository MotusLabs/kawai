## Why

`local-k8s-runner-workflows` removed npm and Homebrew publishing from CI — releases now go to GitHub Releases only — but the repo still carries the npm distribution scaffolding and README instructions that point users at channels that will never receive another version. The repo should not advertise install paths that no longer update.

## What Changes

- **BREAKING** (for fresh installs): README's Install section replaces the Homebrew and npm/npx instructions with GitHub Releases tarball downloads per platform; the npm version badge is removed. Already-published npm packages and the existing Homebrew formula keep working, frozen at their last versions.
- Delete the npm packaging scaffolding: the four `npm/agentboard-<platform>/` package stubs, the `bin/agentboard` platform-resolving launcher, and `scripts/update-optional-deps.js`.
- Clean `package.json`: remove `bin`, `files`, and `optionalDependencies` (which pin `@gbasin/agentboard-*@0.4.4` and are fetched from npm on every install); regenerate `bun.lock`. `name` and `version` stay — `create-release-tag.yml` reads `version`, and the release-branch helper depends on it.
- Remove the now-dead `optionalDependencies` sync block from `scripts/release.ts` (`bun run release:patch/minor/major` otherwise unchanged).
- Manual follow-up recorded as a task: delete the `HOMEBREW_TAP_TOKEN` secret in repo settings (not removable from the repo tree).

Assumptions:
- The package `name` (`@gbasin/agentboard`) stays as-is: it is inert metadata for an unpublished package, and renaming it would churn `bun.lock` for no behavior change.
- The README install section keeps a short note that npm/Homebrew distributions exist for versions ≤ 0.5.x, so existing users understand why `npm update` stops finding new versions.
- The `systemd/` and `launchd/` deployment docs need no changes — verified: they reference no npm/brew install of agentboard itself, only prereqs (bun, tmux).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
<!-- none: no system behavior changes. Distribution behavior is specified in the
     local-k8s-runner-workflows change (github-workflows capability); this change
     only removes dead repo scaffolding and corrects documentation. -->

(declared `skip_specs: true`)

## Impact

- Deleted: `npm/` (4 package stubs), `bin/agentboard`, `scripts/update-optional-deps.js`.
- Edited: `README.md` (badges, Install section), `package.json` (−3 fields), `bun.lock` (regenerated), `scripts/release.ts` (dead block removed).
- Not affected: CI/release workflows (already GitHub-Releases-only), `create-release-tag.yml` version flow, deployment docs, product code. The comment in `src/server/tmuxEnv.ts` referencing the launcher's NODE_ENV behavior stays — it documents why env scrubbing exists and remains true for existing npm installs.
- Consumers installing via `npm`/`brew` see no breakage; they simply stop receiving new versions (the breaking note above covers fresh installs only).

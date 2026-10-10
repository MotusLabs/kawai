# Design

## Context

See `proposal.md` for motivation. The constraints that shape the approach:

- **Versioning.** `src/server/version.ts` reports `BUILD_VERSION`, injected at compile time as `MAJOR.MINOR.PATCH-<PR>` (see `release.yml`), falling back to `<base>-dev` for source runs. Every merge to master cuts a tag and a full GitHub Release, so "is there anything newer" is almost always true and cannot be the notify condition.
- **Install layouts.** A release tarball is `bin/agentboard` + `dist/client`, run from its extracted directory (`staticDir` defaults to `./dist/client` relative to cwd). Services today wrap a source checkout (`bun run start` in `REPO_DIR`). `~/.agentboard/` is the data dir (db, logs, `chat-wire/`) and is not an install root.
- **Existing seams.** Compiled-binary detection already exists (`import.meta.url.includes('$bunfs')`). The header already receives `version` from `/api/server-info`. A toast system exists but is unused and is the wrong shape for a durable signal. Outbound HTTP from the server is currently limited to local Tailscale discovery.

## Goals / Non-Goals

**Goals:**
- One update feed, one update verb, for bare, systemd, launchd, and source-started servers.
- A replace-the-running-binary path that cannot leave a half-written install.
- Restart that works under each supervisor the product actually ships.

**Non-Goals:**
- Automatic unattended updates without a user action.
- Rollback if the new binary fails to boot after swap.
- Renaming release assets or the `agentboard` binary (the documented install one-liner depends on them).
- Updating from a git source by pulling and rebuilding.
- Publishing to npm or any registry other than GitHub Releases (already excluded by `github-workflows`).

## Decisions

### Notify on base-version bumps only
Compare `major.minor.patch` of the latest release tag against the running build's base; ignore the `-<PR>` prerelease suffix for the decision. Alternative: notify on any newer tag. Rejected — with a release per merge that fires constantly and trains users to ignore the chip. Alternative: notify when N builds behind. Rejected as a separate signal; it can be added later without changing this contract.

### Check from the server, not the browser
The server knows `BUILD_VERSION` without a round-trip, holds one ETag-cached response regardless of how many tabs are open, and is the process that must fetch a 25–37 MB tarball anyway. Client-side polling multiplies GitHub API calls (60/hour unauthenticated per IP) and fights CORS. The result is delivered to clients over the existing WebSocket/`server-info` surface.

### Source of truth is the GitHub Releases API of `MotusLabs/kawai`
`GET /repos/MotusLabs/kawai/releases/latest` is public and unauthenticated (verified). Alternative: a hand-maintained manifest file. Rejected — the release workflow already produces the truth; a second source drifts. The repo is a constant in one module so a fork can change it deliberately.

### L3 update with user-triggered restart
Download → extract to staging → verify SHA256 → atomic-rename over `bin/agentboard` and replace `dist/client` → restart. The running process keeps its inode through the rename, so a failed swap cannot kill a live dashboard mid-session; the old build serves until restart. Alternative: auto-restart with health-wait and rollback (L4). Deferred — rollback needs a staged "previous version" slot and boot probing, and only earns its keep after L2/L3 have shipped.

### Checksums are the trust anchor
Release assets currently ship with no hashes. `release.yml` will generate a SHA256 file over the four tarballs and upload it beside them; the installer verifies before any live path is touched. Alternative: boot-probe the staged binary and read its `startup_state` version (mirrors CI). Kept as a fallback if a checksum file is absent from older releases, but not the primary check — it executes a just-downloaded binary.

### Install root discovery
- Running compiled: root is `dirname(dirname(process.execPath))` when that layout is `.../bin/agentboard` and `dist/client` exists beside it. An unexpected layout refuses the update with a named error rather than guessing.
- Running from source: install fresh under `~/.agentboard/app/` (`bin/agentboard` + `dist/client`). The git tree is never read for writes. `~/.agentboard/` stays data-only in the running server's mind; `app/` is a sibling the installers and updater own.

### Restart verbs by supervisor
| Launched as | Restart |
|---|---|
| systemd (`$INVOCATION_ID` set) | `systemctl --user restart <unit>` |
| launchd (unit label known) | `launchctl kickstart -k gui/$uid/<label>` |
| bare | re-exec / spawn the new binary and exit |

Service unit policies change so this works: `Restart=always` (today `on-failure`, so a clean exit does not come back) and launchd `kickstart -k` (today `KeepAlive.SuccessfulExit: false`).

### Service installers retarget at the release binary
`systemd/install.sh` and `launchd/install.sh` stop pointing `ExecStart` at `$BUN_PATH run start` in the repo and instead install/point at the release binary under the install root. This collapses "service user" into "binary user" so self-update is one path. The wrappers in `~/.agentboard/bin/` (PATH, locale, logrotate) stay.

## Risks / Trade-offs

- [Replacing a running binary is high-stakes] → Stage outside the live root, verify checksum first, then a single atomic rename per path; refuse unknown layouts. Never write into the live root before verification passes.
- [Releases older than this change have no checksum file] → Treat missing checksums as a named, user-visible failure of the update action (not of discovery). Discovery keeps working so the chip still appears.
- [Self-restart under a supervisor can race the port bind] → Restart goes through the supervisor's own verb where one exists; bare re-exec binds only after the old process has released the port. If the new binary fails to start, the old files are already gone — v1 accepts that and surfaces the error; rollback is a follow-up.
- [PWA/service-worker cache can serve a stale UI after swap] → Invalidate or hard-reload the client bundle on reconnect following an update; call this out in the update panel so users know a reload may be needed.
- [GitHub API rate limit (60 unauth/hour per IP)] → Startup + one periodic check (6 hours), with an ETag conditional request so empty responses are nearly free.
- [Two GitHub orgs in the docs (`gbasin/agentboard` vs `MotusLabs/kawai`)] → The rewrite in this change makes the release feed and the docs agree; leaving them split would send the updater to the wrong releases page.

## Migration Plan

1. Ship checksums in `release.yml` first (or in the same release) so the first self-update has something to verify against. Until a checksum file exists, update attempts fail closed with a clear message.
2. Retarget service installers. Existing source-based units keep running until the operator re-runs the install script; no automatic migration of live units.
3. Roll out the checker + chip + updater. No data migration: update state is ephemeral and derived from the releases API and `BUILD_VERSION`.

Rollback: revert the application commit and restart. An already-swapped binary is rolled back by installing a chosen older release tarball the same way (the updater is not the only way to get bytes onto disk).

## Open Questions

- Should the update panel deep-link to the release notes for the target tag (`html_url` from the API is available)? Cheap to add once the chip exists; not load-bearing for this change.

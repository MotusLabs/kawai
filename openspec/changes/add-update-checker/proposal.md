# Proposal

## Why

Kawai ships as a standalone binary from GitHub Releases and is often left running for weeks (systemd/launchd), but a running instance never learns that a newer release exists. Discovering an update today means manually visiting the releases page; the only version surface in the product is a hover title in the header. Users sit on stale builds with no signal that the project has moved on.

## What Changes

- **Periodic update check.** The server polls `https://api.github.com/repos/MotusLabs/kawai/releases/latest` on startup and on a timer, and compares the latest release's *base* version (`MAJOR.MINOR.PATCH`) against the running build's base. A newer base is "an update available"; newer PR-suffixed builds of the same base are not — every merge to master cuts a release, so any-other comparison would nag constantly.
- **Persistent header chip.** When an update (or a first binary install) is available, a small persistent chip in the header shows the target version and opens an update panel. It is not a transient toast. It disappears once the running build's base is current.
- **L3 self-update.** The panel's primary action downloads the platform tarball, verifies its SHA256 against the published checksum file, atomically replaces `bin/agentboard` and `dist/client` in the discovered install root, and restarts the server (systemd unit, launchd agent, or in-place re-exec). Source checkouts get the same download path targeting `~/.agentboard/app/` — they are never rebuilt and the git tree is never touched.
- **Release checksums.** `release.yml` publishes a SHA256 checksum file alongside the four platform tarballs so the updater has something to verify against.
- **Service installers run the release binary.** `systemd/install.sh` and `launchd/install.sh` stop wrapping `bun run start` from a git checkout and instead install/point at the release binary, with restart policies that make in-place update + restart work (`Restart=always`, launchd `kickstart -k`).
- **Doc URL rewrite.** Replace remaining `gbasin/agentboard` repository URLs with `MotusLabs/kawai` in README and SECURITY.md. Release asset names (`agentboard-<platform>.tar.gz`) stay unchanged.

## Capabilities

### New Capabilities
- `app-updates`: Discovering newer kawai releases, surfacing them in the UI, and applying an update in place (download, verify, swap, restart) across bare, systemd, and launchd deployments.

### Modified Capabilities
- `github-workflows`: Release artifacts gain a published SHA256 checksum file that covers every platform tarball.

## Impact

- **Server:** new update-checker module (GitHub release fetch, semver base compare, ETag cache), update-installer module (download, checksum verify, atomic swap, restart), and routes/WebSocket messages to expose update state to the client.
- **Client:** header chip and update panel; `App.tsx` / `Header.tsx` wiring.
- **CI:** `.github/workflows/release.yml` generates and uploads checksums.
- **Deploy:** `systemd/install.sh`, `launchd/install.sh`, and their READMEs retarget at the release binary; restart policies change so L3 restart is reliable.
- **Docs:** `README.md`, `SECURITY.md` repository URLs.
- **Data:** install root discovery (`process.execPath`) and a fresh-install location (`~/.agentboard/app/`); the existing `~/.agentboard/` data dir is unchanged.
- **Non-breaking:** existing binary layouts keep working (update in place at whatever root is discovered); asset names and the install one-liner stay valid.

## Assumptions recorded from exploration

- `-dev` builds **do** receive the check. A source checkout's chip offers "Install release binary" into `~/.agentboard/app/`, reconciling "never rebuild a git tree" with "source users should be able to get the binary." Offline and API failures stay silent in every mode.
- Release asset names remain `agentboard-<platform>[.tar.gz]`; renaming them would break the documented install one-liner and is out of scope.
- Restart is user-triggered from the update panel (L3), not an unattended auto-restart loop; rollback-on-failed-boot is out of scope for this change.

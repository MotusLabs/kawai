# Tasks

## 1. Release checksums

- [x] 1.1 Generate a SHA256 checksum file over the four platform tarballs in `.github/workflows/release.yml` and upload it on the GitHub Release; verify the publish job fails when any tarball's checksum is missing, and that a successful run's release carries one matching entry per tarball.
- [x] 1.2 Document the checksum file alongside the install table in `README.md` (what it is, how to verify by hand); verify the rendered section names the file and the check command works against a real release asset.

## 2. Update discovery

- [x] 2.1 Add a pure base-version compare helper (running `BUILD_VERSION` vs latest tag, ignoring the `-<PR>` suffix) and verify unit tests cover: base bump is an update, same-base newer PR is not, running ahead is not, and `-dev` still compares against its base.
- [x] 2.2 Add a GitHub `releases/latest` client pinned to `MotusLabs/kawai` with ETag caching and fail-silent error handling; verify unit tests cover a successful fetch, an HTTP error, and an offline rejection, none of which throw into the UI path.
- [x] 2.3 Rewrite remaining `gbasin/agentboard` repository URLs to `MotusLabs/kawai` in `README.md` and `SECURITY.md`; verify `grep -rn "gbasin/agentboard" README.md SECURITY.md` returns nothing and every release/download link resolves to `MotusLabs/kawai`.
- [x] 2.4 Run the check on startup and on a periodic timer, exposing current update state to clients; verify unit tests show the timer drives a check, a silent failure leaves state unchanged, and a reported update appears in the server's client-facing payload.

## 3. Update surface

- [x] 3.1 Add a persistent header chip naming the target version when an update is available; verify component tests show the chip appears on update state, stays visible past any transient-toast timeout, and is absent when the running base is current.
- [x] 3.2 Add an update panel opened from the chip, with the target version and a primary update action; verify component tests cover open/dismiss and that the action is offered only while an update is reported.
- [x] 3.3 Wire the chip and panel to server update state through the existing client store/WebSocket path; verify an App-level test shows state changes toggle the chip without a page reload.

## 4. Update install

- [x] 4.1 Discover the install root from a compiled process (`bin/agentboard` + `dist/client` layout) and refuse unexpected layouts with a named error; verify unit tests cover a valid root and a refused partial layout.
- [x] 4.2 Download the platform tarball and verify its SHA256 against its entry in the release's published checksum file **before** extracting; verify unit tests cover a matching checksum proceeding to extract, a mismatch refusing before extract, and a missing checksum file or missing entry refusing with no fallback, each leaving the live install untouched.
- [x] 4.3 Swap `bin/agentboard` and `dist/client` all-or-restore after verification — move each live path aside, move its replacement in, and restore every aside copy if any step fails (note `dist/client` is a directory and cannot be renamed over a non-empty directory); verify unit tests cover both paths replaced on success, restore-to-unchanged when the second placement fails, and no writes into the live root before verification passes.
- [x] 4.4 When running from source, install the release binary and client bundle under `~/.agentboard/app/` without writing the git tree; verify unit tests cover the install target and that a source checkout's files are unchanged after the action.

## 5. Restart and service installers

- [x] 5.1 Implement restart-per-supervisor (systemd unit restart, launchd kickstart, bare re-exec) selected from how the process was launched; verify unit tests cover verb selection for each mode and that a failed restart surfaces an error instead of succeeding silently.
- [x] 5.2 Retarget `systemd/install.sh` and its README at the installed release binary, with a restart policy that brings the service back after a clean exit; verify the generated unit's start command is the binary and a restart of the unit serves the new process.
- [x] 5.3 Retarget `launchd/install.sh` and its README at the installed release binary, keeping the PATH/locale wrapper and logrotate; verify the generated plist's program is the binary and a kickstart reloads the agent.
- [x] 5.4 Cover the L3 update flow (download → verify tarball → extract → all-or-restore swap → restart) with an isolated integration test against a fake release server and a temp install root; verify the test asserts the new files landed, the restart verb was invoked, a checksum mismatch left the root unchanged, and a mid-swap failure restored both paths.

## 6. End-to-end verification

- [x] 6.1 Run `bun run lint && bun run typecheck && bun run test` and verify the suite is green with the new modules included.
- [x] 6.2 Manually drive the chip against a newer base version (pinned fake latest or a real release) and verify: chip appears, update applies, server restarts on the new build, chip clears.
- [x] 6.3 Verify a source-checkout server offers install-not-update, lands under `~/.agentboard/app/`, and leaves `git status` clean.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Sync `specs/app-updates` and `specs/github-workflows` on archive and verify the archived result.

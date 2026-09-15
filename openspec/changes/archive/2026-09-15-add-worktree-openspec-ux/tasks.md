> Audit 2026-09-12: checked tasks were implemented by the prior branch effort
> (6d06722..33b555e, carried into this worktree) and verified against its
> code and tests. Phase-2 items under section 10 were also found implemented.

## 1. Shared Workspace Contract

- [x] 1.1 Add shared repository, worktree, branch, OpenSpec-change, registry, section, snapshot, stale/error, and operation-result types plus additive client/server WebSocket messages, including create-session with an optional auto-start apply command; verify shared type tests and `bun run typecheck` pass.
- [x] 1.2 Add parsing/validation coverage for workspace snapshot, create-change-worktree, and auto-start-bearing create-session messages, including malformed and backward-compatible payloads; verify the focused shared and server validator tests pass.

## 2. Git Repository Discovery

- [x] 2.1 Create a focused server module that canonicalizes known local project paths, resolves their worktree/common Git directories, and deduplicates repositories; verify unit tests cover symlinks, deleted paths, nested repositories, non-Git paths, and duplicate seeds.
- [x] 2.2 Parse Git porcelain output into repository, worktree, local-branch, detached-HEAD, main-worktree, revision, and branch-assignment metadata; verify fixture-based unit tests cover linked and detached worktrees plus packed/local refs.
- [x] 2.3 Add bounded dirty-state discovery and deepest-worktree path matching; verify tests cover tracked/untracked changes, clean worktrees, path-boundary safety, and nested matches.
- [x] 2.4 Assemble deterministic repository snapshots from live, hibernating, recent-history, and on-demand project-path seeds while isolating per-repository failures; verify server discovery tests cover empty worktrees and last-valid stale results.

## 3. OpenSpec Change Registry and Discovery

- [x] 3.1 Add per-worktree `openspec list --json` discovery with timeouts, bounded output, missing-root handling, and defensive parsing of optional fields; verify tests cover active, archived, missing-progress, malformed, and failed results.
- [x] 3.2 Build the per-repository change registry from the main worktree's OpenSpec root and resolve each change's canonical source — the `.worktrees/<change-name>` copy when it exists, the registry entry otherwise; verify tests cover seeded-only changes, worktree-canonical progress, worktrees missing the change, and divergent main-worktree copies.
- [x] 3.3 Merge registry and per-worktree results into their originating repository snapshots without copying state between worktrees, retaining last-valid values on failure; verify tests use two worktrees with divergent change lists and progress.

## 4. Workspace Coordination

- [x] 4.1 Add a workspace discovery coordinator that caches snapshots, limits subprocess concurrency, refreshes affected repositories, and broadcasts only structural changes; verify coordinator tests cover deduplication, concurrent requests, error isolation, and unchanged snapshots.
- [x] 4.2 Seed the coordinator from registry and agent-session path changes and send the latest workspace snapshot to newly connected clients; verify isolated WebSocket handler tests cover initial connection, new repository discovery, and path removal.
- [x] 4.3 Keep workspace metadata current via debounced filesystem watches plus periodic full reconciliation with lifecycle cleanup; both were implemented by the prior branch work (`workspaceWatcher.ts`, coordinator reconciliation, e2e coverage) and are retained rather than deferred — verify watches and reconciliation still pass after the change-section rework.

## 5. Client Workspace State and View Model

- [x] 5.1 Add a Zustand workspace store for snapshots, per-worktree errors, operation state, and persisted collapse state; verify store tests cover reconnects, stale snapshots, collapse persistence, and operation results.
- [x] 5.2 Build pure selectors that associate active, hibernating, and historical sessions with the deepest worktree and produce change sections (with or without worktrees), unmatched-worktree sections including the main worktree, the `Workspace` section, remote groups, attention counts, and flattened visible navigation order; verify comprehensive selector tests cover filters and collapsed sections.
- [x] 5.3 Integrate workspace messages into `App.tsx` without changing existing session snapshot semantics and use the flattened section order for keyboard/terminal navigation; verify existing app, keyboard, filter, and selection tests remain green with new grouped cases.

## 6. Change-Section Navigator

- [x] 6.1 Extract section header components showing change name with progress for change sections, worktree name or branch for other sections, path, dirty/stale state, counts, collapse control, a new-session action, and accessible labels; verify component tests cover change, plain-worktree, main-worktree, `Workspace`, stale, collapsed, and hidden-permission states.
- [x] 6.2 Refactor `SessionList` to render live, hibernating, and historical rows inside sections ordered changes-first, then unmatched worktrees, then `Workspace`, then remote; verify component tests cover grouping, lifecycle actions, animations, filters, and empty sections.
- [x] 6.3 Constrain manual drag ordering to a section and preserve flattened cross-section keyboard navigation; verify drag and keyboard tests reject cross-section moves and retain current within-group behavior.
- [x] 6.4 Render change identity and progress from the canonical source in change sections, with a missing-in-worktree indication when the worktree lacks the change; verify accessible component tests cover progress, no-root, collapsed-count, and discovery-failure cases.
- [x] 6.5 Use the same grouped navigator in the mobile drawer and desktop sidebar; verify responsive component coverage and Playwright DOM assertions exercise selection and collapse on both layouts.

## 7. Change Worktree Creation and Seeding

- [x] 7.1 Extend the new-session modal with the prefilled worktree path and the auto-start option (default on only when opened from a change section's action), retaining manual path entry, recent paths, directory browsing, command presets, names, hosts, and focus behavior; verify modal and directory-browser regression tests pass.
- [x] 7.2 Implement the server create-change-worktree operation: argument-array `git worktree add .worktrees/<change-name>` using the existing local branch `<change-name>` when present and unassigned, otherwise `-b <change-name>` from the repository's current HEAD; copy `openspec/changes/<change-name>/` from the main worktree into it; commit the copy on the new branch; and append `.worktrees/` to `.gitignore` when absent; verify integration tests cover success, existing destination, concurrently assigned branch, missing artifacts, command failure, and injection-like inputs.
- [x] 7.3 Revalidate repository identity, destination nonexistence, and branch unassignment immediately before execution with no force flags, and refresh and broadcast the snapshot after each operation result; verify tests cover race windows and actionable error reporting.
- [x] 7.4 Route successful creation into the prefilled session form and show an actionable error when a selected worktree disappears before session creation; verify component and WebSocket handler tests assert the exact project path and existing session options.

## 8. Auto-Start Apply

- [x] 8.1 Store the pending auto-start command server-side, keyed to the new session, with a per-agent-type command map (Claude `/opsx:apply <change>`, Codex equivalent); verify unit tests cover mapping, persistence across client reloads, and discard with the session.
- [x] 8.2 Inject the pending command through the terminal-input path exactly once, the first time the session reports an idle status after creation; verify handler tests cover early idle, never-idle sessions, and double-trigger protection.
- [x] 8.3 Send nothing when the option is off or the agent type is unrecognized; verify tests cover option-off and unknown-agent sessions.

## 9. Regression and Acceptance Verification

- [x] 9.1 Add end-to-end coverage for external worktree creation, branch/ref changes, OpenSpec task progress changes, transient discovery failures, and periodic reconciliation without page reload; verify `bun run test:e2e` passes in the supported test environment.
- [x] 9.2 Exercise the completed desktop and mobile UX with the repository's browser-testing workflow, capture screenshots, and verify change-section grouping, seeding flow, auto-start injection, truncation, focus, keyboard access, and responsive layout against the specs.
- [x] 9.3 Run `bun run lint && bun run typecheck && bun run test`, resolve all regressions, and confirm the workspace-discovery process shuts down cleanly.

## 10. Phase 2 (implemented by prior branch work)

- [x] 10.1 Add a repository branch browser that shows local branches, their assigned worktrees, and only enables creation for unassigned branches; verify accessible component tests cover assigned, unassigned, detached, empty, and filtered branch lists.
- [x] 10.2 Add a general create-worktree form with a collision-resistant destination suggestion, editable absolute destination, exact confirmation summary, and optional follow-up session launch; verify form tests cover path editing, validation, cancellation, and launch choice.
- [x] 10.3 Implement the server create-worktree operation for arbitrary branches using argument-array Git invocation and immediate revalidation of repository identity, local branch assignment, and destination nonexistence, with no force flags; verify integration tests cover success, existing paths, concurrent assignment, invalid repositories, command failure, and injection-like inputs.
- [x] 10.4 Refresh and broadcast repository state after each phase-2 operation result and route successful optional launch through the normal session form/creation flow; verify an end-to-end test creates a worktree, observes its section, and starts a tmux session at its root.
- [x] 10.5 Add safe, debounced filesystem watches for Git and OpenSpec metadata plus periodic full reconciliation and lifecycle cleanup; verify fake-watcher/timer tests cover burst coalescing, missed-event recovery, newly created directories, and shutdown.

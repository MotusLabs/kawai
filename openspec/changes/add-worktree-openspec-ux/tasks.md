## 1. Shared Workspace Contract

- [x] 1.1 Add shared repository, worktree, branch, OpenSpec-change, snapshot, stale/error, and operation-result types plus additive client/server WebSocket messages; verify shared type tests and `bun run typecheck` pass.
- [x] 1.2 Add parsing/validation coverage for workspace snapshot and create-worktree messages, including malformed and backward-compatible payloads; verify the focused shared and server validator tests pass.

## 2. Git Repository Discovery

- [x] 2.1 Create a focused server module that canonicalizes known local project paths, resolves their worktree/common Git directories, and deduplicates repositories; verify unit tests cover symlinks, deleted paths, nested repositories, non-Git paths, and duplicate seeds.
- [x] 2.2 Parse Git porcelain output into repository, worktree, local-branch, detached-HEAD, main-worktree, revision, and branch-assignment metadata; verify fixture-based unit tests cover linked and detached worktrees plus packed/local refs.
- [x] 2.3 Add bounded dirty-state discovery and deepest-worktree path matching; verify tests cover tracked/untracked changes, clean worktrees, path-boundary safety, and nested matches.
- [x] 2.4 Assemble deterministic repository snapshots from live, hibernating, recent-history, and on-demand project-path seeds while isolating per-repository failures; verify server discovery tests cover empty worktrees and last-valid stale results.

## 3. OpenSpec Discovery

- [x] 3.1 Add per-worktree `openspec list --json` discovery with timeouts, bounded output, missing-root handling, and defensive parsing of optional fields; verify tests cover active, archived, missing-progress, malformed, and failed results.
- [x] 3.2 Merge OpenSpec results into their originating worktree snapshots without copying state between worktrees, retaining last-valid values on failure; verify tests use two worktrees with divergent change lists and progress.

## 4. Live Workspace Coordination

- [x] 4.1 Add a workspace discovery coordinator that caches snapshots, limits subprocess concurrency, refreshes affected repositories, and broadcasts only structural changes; verify coordinator tests cover deduplication, concurrent requests, error isolation, and unchanged snapshots.
- [x] 4.2 Seed the coordinator from registry and agent-session path changes and send the latest workspace snapshot to newly connected clients; verify isolated WebSocket handler tests cover initial connection, new repository discovery, and path removal.
- [x] 4.3 Add safe, debounced filesystem watches for Git and OpenSpec metadata plus periodic full reconciliation and lifecycle cleanup; verify fake-watcher/timer tests cover burst coalescing, missed-event recovery, newly created directories, and shutdown.

## 5. Client Workspace State and View Model

- [x] 5.1 Add a Zustand workspace store for snapshots, per-worktree errors, operation state, and persisted collapse state; verify store tests cover reconnects, stale snapshots, collapse persistence, and operation results.
- [x] 5.2 Build pure selectors that associate active, hibernating, and historical sessions with the deepest worktree and produce repository groups, local-ungrouped groups, remote groups, attention counts, and flattened visible navigation order; verify comprehensive selector tests cover filters and collapsed groups.
- [x] 5.3 Integrate workspace messages into `App.tsx` without changing existing session snapshot semantics and use the flattened grouped order for keyboard/terminal navigation; verify existing app, keyboard, filter, and selection tests remain green with new grouped cases.

## 6. Grouped Workspace Navigator

- [x] 6.1 Extract repository and worktree header components showing branch or detached revision, path, dirty/stale state, counts, collapse control, and accessible labels; verify component tests cover clean, dirty, detached, stale, collapsed, and hidden-permission states.
- [x] 6.2 Refactor `SessionList` to render live, hibernating, and historical rows inside worktree groups with explicit local-ungrouped and remote fallbacks; verify component tests cover grouping, lifecycle actions, animations, filters, and empty groups.
- [x] 6.3 Constrain manual drag ordering to a worktree group and preserve flattened cross-group keyboard navigation; verify drag and keyboard tests reject cross-group moves and retain current within-group behavior.
- [x] 6.4 Render compact OpenSpec change rows and progress within each worktree, including optional values and isolated stale/error presentation; verify accessible component tests cover progress, no-root, collapsed-count, and discovery-failure cases.
- [x] 6.5 Use the same grouped navigator in the mobile drawer and desktop sidebar; verify responsive component coverage and Playwright DOM assertions exercise selection and collapse on both layouts.

## 7. Worktree-Aware Session Creation

- [ ] 7.1 Extend the new-session modal with a compact discovered-worktree picker while retaining manual path entry, recent paths, directory browsing, command presets, names, hosts, and focus behavior; verify modal and directory-browser regression tests pass.
- [ ] 7.2 Add contextual new-session actions to worktree headers that preselect the worktree root and pass through the existing session creation path; verify component and WebSocket handler tests assert the exact project path and existing session options.
- [ ] 7.3 Refresh workspace metadata and show an actionable error when a selected worktree disappears before session creation; verify the server rejects the stale path and the client requests or receives a refreshed snapshot.

## 8. Branch Browser and Worktree Creation

- [ ] 8.1 Add a repository branch browser that shows local branches, their assigned worktrees, and only enables creation for unassigned branches; verify accessible component tests cover assigned, unassigned, detached, empty, and filtered branch lists.
- [ ] 8.2 Add a create-worktree form with a collision-resistant sibling-path suggestion, editable absolute destination, exact confirmation summary, and optional follow-up session launch; verify form tests cover path editing, validation, cancellation, and launch choice.
- [ ] 8.3 Implement the server create-worktree operation using argument-array Git invocation and immediate revalidation of repository identity, local branch assignment, and destination nonexistence, with no force flags; verify integration tests cover success, existing paths, concurrent assignment, invalid repositories, command failure, and injection-like inputs.
- [ ] 8.4 Refresh and broadcast repository state after each operation result and route successful optional launch through the normal session form/creation flow; verify an end-to-end test creates a worktree, observes its group, and starts a tmux session at its root.

## 9. Regression and Acceptance Verification

- [ ] 9.1 Add end-to-end coverage for external worktree creation, branch/ref changes, OpenSpec task progress changes, transient discovery failures, and automatic reconciliation without page reload; verify `bun run test:e2e` passes in the supported test environment.
- [ ] 9.2 Exercise the completed desktop and mobile UX with the repository's browser-testing workflow, capture screenshots, and verify grouping, truncation, focus, keyboard access, and responsive layout against the specs.
- [ ] 9.3 Run `bun run lint && bun run typecheck && bun run test`, resolve all regressions, and confirm the workspace-discovery and watcher processes shut down cleanly.

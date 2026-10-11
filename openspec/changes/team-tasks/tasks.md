# Tasks

## 1. Group settings and worktree identity

- [x] 1.1 Extend group frontmatter with `canCreateTasks` (boolean, default false), `max` (positive integer, default 1), `profile` (optional profile id), and `approval` (`manual` or `auto`, default manual); verify parser/catalog tests cover valid settings, defaults, malformed settings, and project-over-user layering.
- [x] 1.2 Add worktree-root resolution and task-target validation using the existing git worktree helpers: normalize main checkout and linked-worktree targets to listed roots, resolve members in subdirectories to their enclosing worktree, refresh the worktree list on a cache miss, and refuse other paths; verify temporary-repository tests cover both roots, subdirectories, symlinks, moved members, invalid targets, and removed worktrees, using `cleanGitEnv()` for every test git command.
- [x] 1.3 Add user-level `~/.kawai/teams.json` loading with the default spawn cap of 5, positive-integer global/per-repository settings, repository/worktree keys normalized to team identity, and startup/file-change reload; verify tests cover absent files, overrides, worktree keys, malformed JSON/settings reported with default fallback, and project files being unable to raise team caps.
- [x] 1.4 Document task-related group settings, user-level caps, worktree-root matching, and the absence of implicit worktree creation in the How It Works documentation; verify the examples match parser defaults and the loader's paths.

## 2. Durable task records

- [ ] 2.1 Add `team_tasks`, `team_task_revisions`, and `team_task_journal` tables per design D1, nullable `task_id` on `team_messages` and `chat_sessions`, and shared SDK-free task types; verify database migration tests preserve existing sessions/messages and round-trip task references, creator identity, optional parent/worktree/change, timestamps, and status.
- [ ] 2.2 Implement task-store create/get/list/detail operations with initial revision 1, team scoping, subtasks, and participants derived from associated sessions, messages, and journal authors; verify tests cover human/agent creators, team isolation, parent links, concurrent participants, and task persistence after database reopen and session archive/kill.
- [ ] 2.3 Implement atomic direction/acceptance amendments and numbered immutable revisions, plus append-only journal writes and status updates; verify tests retain earlier revisions, append author/time/text in order, increment revisions safely across competing amendments, and persist changes across reopening the store.
- [ ] 2.4 Document task/revision/journal durability and their relationship to sessions and OpenSpec; verify the documentation states that killing a creator preserves the task and that task status does not rewrite OpenSpec checkboxes.

## 3. Task service and agent tools

- [ ] 3.1 Add a sender-bound task service validating same-team task/parent references, target worktrees, and existing linked OpenSpec changes; read `canCreateTasks` from the caller's current group catalog and refuse creation by other agents; verify service tests cover permitted/default/no-group callers, fresh settings, invalid links, cross-team parents/tasks, and forged creator identity being ignored.
- [ ] 3.2 Enforce creator-or-human direction/acceptance amendments, any-member journal notes and `active`/`blocked` updates, creator-only agent `done`/`cancelled`, and human access to every status including reopening; verify a permission matrix includes human-created tasks, contributors, a killed creator, and refusal messages suggesting a note or message instead of unauthorized amendments.
- [ ] 3.3 Register `task_create`, `task_get`, `task_note`, `task_update_status`, `task_amend`, and `task_list` in the per-session in-process MCP server with validated inputs and bound identity; verify handler and driver tests cover each tool, permissions, full task retrieval, same-team listing, and the spawn-time tool registration.
- [ ] 3.4 Extend the agent mailbox/system-prompt note with task tools, creator ownership, journal contributions, and linked-change authority; verify prompt tests cover permitted creators, ordinary contributors, and sessions with no group, and document the tool contracts beside the task lifecycle rules.

## 4. Task context in messages

- [ ] 4.1 Accept optional `task_id` on send/reply/schedule, persist it on mailbox rows, inherit the original task on replies when omitted, and reject unknown/cross-team task ids; verify handler/store tests cover explicit overrides within the team, inheritance, scheduled persistence, ordinary messages without a task, and invalid references creating no mail.
- [ ] 4.2 Build task context at delivery from the latest revision: title, direction, acceptance criteria, revision, status, linked change, worktree, and a bounded excerpt of the last five journal entries, with full detail available through `task_get`; verify tests show amendments/notes made after enqueue appearing at delivery and linked-change artifacts named as authoritative.
- [ ] 4.3 Extend the fixed peer envelope and replayed/shared peer event with task context while retaining compatibility with existing envelopes, and persist the session's associated task for its header; verify format/parse, live delivery, restart/reconnect replay, no-task compatibility, and uncertain-retry duplicate notices retain the expected task context.
- [ ] 4.4 Document task inheritance and delivery-time context, including the bounded journal excerpt and linked OpenSpec authority; verify documented fields match the shared envelope and tool inputs.

## 5. Bounded worktree staffing

- [ ] 5.1 Filter task-targeted group mail by the member's current resolved worktree before atomic idle claim, retaining urgent/direct/oldest ordering and longest-idle pickup; verify dispatcher tests cover an idle matching member, a member in a subdirectory, an idle member elsewhere being skipped, and cwd moves changing eligibility.
- [ ] 5.2 Add a durable spawning reservation and atomic cap checks for group live-member `max`, team live-spawned-session caps, and one live non-archived spawned member of any group per resolved worktree; verify competing dispatch attempts cannot create duplicate writers or exceed caps, archived/killed sessions release slots, and a busy writer in a subdirectory still occupies its worktree slot.
- [ ] 5.3 Create a member programmatically in a valid target worktree when no idle matching member exists and all caps allow it, carrying group/profile/approval/task and delivering the message as the first turn; verify manager/dispatcher tests cover group settings, default profile/manual approval, associated task persistence, and first-turn delivery only once.
- [ ] 5.4 Release failed spawning reservations and requeue mail without bypassing receipt recovery, reconcile interrupted startup reservations, re-evaluate waiting mail when slots free or members become idle, and dead-letter queued task mail whose target worktree was removed; verify failure/restart/cap-release tests cover each path and confirm no git worktree is ever created implicitly.
- [ ] 5.5 Document staffing triggers, cap accounting, one spawned writer per worktree, and failure/removal behavior; verify the rules match dispatcher tests and distinguish ordinary manually created members from spawned-session cap accounting.

## 6. Human task connections

- [ ] 6.1 Add team-scoped task-list/detail subscriptions and authoritative snapshots/pushes for tasks, revisions, journal, subtasks, participants, and linked messages; verify connection tests cover open/change/close/disconnect, reconnect snapshots, delayed team resolution, and cross-team access refusal.
- [ ] 6.2 Add human create/amend/note/status actions through the UI connection path using the task service, including parent/worktree/change inputs; verify connection tests cover each action, invalid references, revision pushes, and reopening a task whose creator was killed.
- [ ] 6.3 Carry associated task and spawned-session identity through session persistence, snapshots, and navigator equality checks; flag spawned sessions with pending approvals/questions as needing attention and trigger the existing notification path; verify manager/connection tests cover restart, archive/restore, approval/question resolution, and a notification without an open task view.
- [ ] 6.4 Document the human task controls and needs-attention behavior; verify the documentation states that humans can amend and close tasks regardless of creator and that auto-spawn uses the configured approval policy.

## 7. Task UI

- [ ] 7.1 Add a per-team task store and task-list/create view showing title, status, creator, and participants, with team scope and optional parent/worktree/change inputs; verify component tests cover creation, listed participants, errors, and authoritative reconnect updates.
- [ ] 7.2 Add task detail showing current direction/acceptance, revision history, append-only journal, subtasks, and linked messages, plus human amend/note/status/reopen controls; verify component tests cover every section and action, retained old revisions, a missing creator, and disabled controls while disconnected.
- [ ] 7.3 Show the associated task in a chat's header, task context on peer-message rows, and spawned/task/needs-attention badges in the navigator under the current worktree; verify component tests cover live and replayed events, spawned sessions in subdirectories, pending approval/question flags, and flag removal after resolution.
- [ ] 7.4 Document where task creation, detail, history, message links, and spawned-session attention appear in the UI; verify documented labels/actions match the rendered components.

## 8. Integration

- [ ] 8.1 Add a headless fixture integration in one temporary repository with a linked worktree: a permitted lead creates/amends a task, sends worktree-targeted mail, a member is spawned within caps and receives current context, and its note/reply returns under the same task; verify the test passes, preserves the task across creator kill/restart, and uses `cleanGitEnv()` for git commands.
- [ ] 8.2 Walk task creation/detail/amendment/journal/status controls, worktree-targeted spawning, task/header/peer badges, cap-wait behavior, and needs-attention notification against the fixture using repository Playwright; verify DOM state and screenshots, including reload/reconnect restoration.
- [ ] 8.3 Run `bun run lint && bun run typecheck && bun run test` and OpenSpec validation, and verify the full suite is green with the task/worktree integration included.

## Workflow follow-up

- Review and archive `team-tasks`, syncing its capabilities into main specs.
- Continue with `profile-routing` after its implementation checklist is ready.
- Keep feature changes in separate incremental commits and branches; push only when requested. Preserve the merge order with `chat-session-spawned-subagents` before `agent-teams` and their dependent features.

# Tasks

Implement after `team-workspace-pages`, `durable-plans`, and `plan-supervision` and their prerequisites have landed. These tasks do not implement those changes. Follow design D1-D8 and specs/plan-workspace/spec.md. Keep modules focused and each file under 500 LOC; Git fixtures use the project's clean Git environment helpers.

## 1. Workspace contracts and metadata

- [ ] 1.1 Add `src/shared/planWorkspace.ts` types and defensive parsers for displayed version/execution, document references, checklist projections, passive health, conversation bindings and message context; verify malformed selectors, draft/revision discrimination and optional-field compatibility with unit tests.
- [ ] 1.2 Add migrations/stores for repository role bindings, document references and per-user-message context snapshots (UUID key, turn id only for grouping); verify fresh/old databases, restart retention, distinct role sessions and multiple messages within one turn with store tests.
- [ ] 1.3 Add team-scoped connections and message routing registration for workspace open/close, binding CAS and keyed reference add/remove; verify wrong-team ids, stale CAS, request-key replay/conflict and no writes on refusal in connection tests. Document these additive contracts beside the module.

## 2. OpenSpec work breakdown and document access

- [ ] 2.1 Implement canonical change/artifact resolution using workspace identity and OpenSpec metadata, including nested specs and unique archive resolution; verify main-only, convention-worktree, missing-in-worktree, archived and ambiguous cases using isolated repository fixtures.
- [ ] 2.2 Implement Markdown task AST projection with headings, nesting, checked state and source/hash links; verify mixed lists, fenced checkbox examples, duplicate numbering, no tasks artifact and changed source identities with parser tests.
- [ ] 2.3 Implement bounded Markdown/image reads and a scoped asset route with regular-file/type checks and containment checks against traversal/symlink races; verify permitted relative links, external URL non-fetching, invalid UTF-8, unsupported types, oversized content and escaped paths through reader/route tests.
- [ ] 2.4 Add hash/provenance metadata and selected-document/expanded-checklist invalidation via watcher plus reconciliation; verify external edits, source deletion, stale last-valid content and execution-pin match/mismatch/unknown without cross-worktree fallback. Document supported formats and source rules in the workspace module.

## 3. Runtime projection and passive health

- [ ] 3.1 Compose plan-supervision outcomes with linked tasks and outstanding assignment claims for the selected execution; verify parallel holders, unclaimed groups, handoffs, outside-version work and all-checkboxes-checked/in-review remain distinguishable with read-model tests.
- [ ] 3.2 Add passive read/subscription access to available session context and profile quota without attaching or refreshing workers; verify open/close and health inspection call no start/restore/send/poll methods and expose only same-team relevant sessions.
- [ ] 3.3 Implement D5 health derivation and explanations with thresholds, approximation, applicability and freshness; verify red/yellow/green/gray boundaries, missing readings, shared quota, passed reset, gateway/host-account mismatch and disconnected state using a controlled clock. Document the display thresholds and 15-minute freshness policy.
- [ ] 3.4 Wire coalesced workspace snapshots and incremental source invalidation to plan/task/assignment/session/usage changes; verify unsubscribe cleanup, reason-only changes and reconnect restoring fresh facts without loading all document bodies or starting chats.

## 4. Durable contextual chat delivery

- [ ] 4.1 Extend `chat-send` with optional workspace context, validating bound session/team, exact plan version/hash, change, execution and document identities before starting/sending; verify ordinary unscoped chat compatibility, wrong-team refusal and stale-draft/document refusal with manager/connection tests.
- [ ] 4.2 Extend the driver user-message path with stable message UUIDs, immutable context persistence and a separate SDK `pasted_content` context entry; verify metadata storage precedes enqueue, storage failure sends nothing, literal slash commands remain recognized, and two messages in an active turn retain different contexts.
- [ ] 4.3 Carry attachment metadata through live events, persistence, snapshots and SDK transcript reconstruction keyed by message UUID; verify restart/replay, changing plan titles/files, command-output turns, and legacy events without context with history/driver tests. Document that attachments do not set task association or authorize execution.

## 5. Dependency workspace and document reader UI

- [ ] 5.1 Mount the workspace within the Plans tab, retaining plan intent/review/validation/history/decision/report sections and existing action gates; verify empty-state planning and unavailable prerequisites do not fabricate plans or execution state using component/route tests.
- [ ] 5.2 Build the deterministic WBS/dependency table with depth columns, edges, expansion, selection, active/blocked filters and textual dependency alternatives; verify parallel A/B joining C, cycle fallback, version switching and change-level ownership/count separation with layout/component tests.
- [ ] 5.3 Add the document reader and scoped Markdown link/image resolvers while preserving chat Markdown defaults; add reference add/remove controls and provenance/broken/unsupported states. Verify nested relative navigation, rendered architecture/image mockups, current-vs-pinned labels and unchanged chat link behavior in component tests.
- [ ] 5.4 Add agent health dots with keyboard-accessible explanations and clock-driven freshness; verify partial telemetry, quota sharing, text equivalents and returning from a worker chat preserve workspace selection. Add user-facing workspace instructions to AGENTS.md for maps, checklists and documents.

## 6. Repository conversation panel

- [ ] 6.1 Extract the shared chat surface for full-screen and embedded hosts without changing existing behavior; verify streaming, approvals/questions, Stop, slash menu, notifications, background tasks, archive/restore, per-session drafts and attach/detach ownership using existing chat tests plus focused host tests.
- [ ] 6.2 Add Architect/Lead role selection, same-team session binding, normal-session creation for empty roles and unavailable/archive states; verify existing Lead identity/history reuse, distinct roles, reload retention and CAS-safe replacement without inferring or granting authority. Show configured group/profile/policy and Lead-role mismatch.
- [ ] 6.3 Add visible plan/version attachments and captured draft scope with explicit replacement; verify switching plan/version/change does not retarget a nonempty draft, switching roles retains each draft, stale refusal retains text, no-plan exploration is unscoped and full-screen chat uses the same transcript.
- [ ] 6.4 Integrate local `/clear`, `/reset`, `/new` replacement with successful repository binding transfer; verify creation failure, missing group cloning, approval/profile carryover, concurrent binding replacement and preservation of the other role with reset-flow tests. Document Architect planning and Lead coordination session behavior in AGENTS.md.

## 7. Navigation, accessibility and integration verification

- [ ] 7.1 Extend Plans route parse/format for plan/version/execution/change/document/role selectors and view-state retention; verify reload/Back/Forward, invalid links, full-screen chat return and unchanged legacy Team routes with route and browser tests.
- [ ] 7.2 Add desktop pane sizing/expansion and narrow-screen Map/Documents/Conversation navigation with explicit return paths; verify keyboard resize, focus order, non-color status labels and mobile selection preservation with accessibility/component checks.
- [ ] 7.3 Add `tests/e2e/plan-workspace.spec.ts` using an isolated server/database/repository: parallel plan branches, checklist refresh, checked-but-in-review work, holder/health updates, Markdown/mockup reading, distinct repository chats reused across two plans, plan-scoped messages, pending question resolution, reconnect/reload and preserved workspace on chat return. Register it in the fixture CI invocation and verify the walkthrough passes.
- [ ] 7.4 Exercise a 100-change/2,000-item fixture; verify changes start collapsed, only expanded checklists/selected documents load, map selection and typing remain responsive, and workspace observation starts no worker processes; record the measured result in the change handoff.
- [ ] 7.5 Run `bun run lint && bun run typecheck && bun run test` and the isolated Plan workspace browser walkthrough after implementation; record outcomes and any limitations without substituting checkbox completion for verified execution success.

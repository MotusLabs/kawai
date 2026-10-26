# Design

## Context

See proposal.md for motivation and specs/plan-workspace/spec.md for behavior.

Observed today:
- `TeamWorkspaceView.tsx` hosts repository-scoped views; `teamLocation.ts` reserves `plans` but does not render it.
- `src/server/workspace/openspecDiscovery.ts` supplies change summaries, not individual task items or document content. `changeRegistry.ts` prefers the convention worktree's change once that worktree exists; missing files must not silently fall back to main.
- `TeamTask.openspecChange` links to a change, not a checkbox. Assignment history and outstanding claims identify responsibility; being in a worktree alone does not establish ownership.
- `ChatView.tsx` owns chat attachment and currently sends `{type: 'chat-send', sessionId, text}`. `ChatConnections` starts agents on attach; `ChatSessionManager.send` forwards text to `ChatSessionDriver.send`, which emits the user event and enqueues the SDK message. Merely observing workers through ChatView would start them.
- `ChatContextUsage` includes used tokens, threshold, percentage, measurement time and approximation. `ChatUsageReport` is per profile, ephemeral, and distinguishes provider quota from host-account SDK pulls. `Markdown.tsx` supports GFM but opens links externally and does not resolve repository assets.
- Existing fixture browser tests use isolated servers and databases. `team-page.spec.ts` provides a suitable setup pattern; the fixture suite is explicitly listed in CI.

Pending contracts, not current implementation:
- `durable-plans` owns plan records/revisions/drafts, approval, task-plan links and the initial Plans detail.
- `plan-execution` owns execution attempts and pinned inputs; `plan-supervision` owns change outcomes, stage holders, named waits and reports.
- `team-workspace-pages` owns the repository Team host. This change follows these changes and enriches their UI/read models without changing their authority. It does not edit their artifacts.

## Goals / Non-Goals

**Goals:** compose existing authorities into a coherent planning/execution surface; retain ordinary chat identity and behavior; make provenance and unknown states visible; keep subscriptions and file reads bounded.

**Non-Goals:** a second plan database, a scheduler, a generic repository editor, assignment to checkbox ids, new agent permissions, automatic process replacement, or historical file reconstruction. The existing plan review/approval controls and reports remain reachable from the workspace.

## Decisions

### D1. One workspace capability, consuming existing plan contracts

Add `src/shared/planWorkspace.ts` for the workspace snapshot, document references, health and message-context contracts, and `src/server/plans/workspace/` for composition, file reads, bindings and connections. Extend the landed plan subscription with a separate `team-plan-workspace-open/close` projection rather than adding document bodies to every ordinary plan snapshot. Every message goes through `TeamScopes` and `CHAT_CONNECTION_TYPES` registration.

The snapshot names team, selected plan/version, selected execution, source availability, linked assignments, and health, with independent generation/measurement timestamps. Subscribe to plan/task/assignment/session/context/quota changes and the existing workspace watcher; coalesce pushes and revalidate on reconnect. Only read detailed checklists for expanded changes and document content for the selected reader. Unsubscribe on close. No new provider polling.

Alternative: put everything into the workspace navigator snapshot. Rejected because documents, plan drafts and transcripts have different lifetimes and would inflate unrelated navigation updates.

### D2. A WBS tree aligned with a deterministic dependency map

Use a shared ordered list of visible rows: plan, change, expanded task sections/items. Changes have dependency depth `0` for roots, otherwise `1 + max(parent depth)`; plan order breaks ties. A change's map cell occupies its depth column and edges connect prerequisites. Expanded checklist rows sit beneath it; they do not create execution nodes or artificial dependencies. This produces a Gantt-like table with parallel columns, not a calendar or free-form graph editor. Render with HTML/CSS and a small SVG edge overlay; no graph dependency is required. Provide a text list of prerequisites and dependents for keyboard/screen-reader access.

Default to the approved revision, otherwise the latest draft/in-review content. The version picker always labels what is displayed. The execution picker defaults to the latest execution and displays its pinned revision independently. Overlay runtime state only by matching change identity and clearly identify the execution revision; new or modified proposed changes must not appear executed under their proposed definition. Keep running work outside the displayed version in a separate section. Invalid dependency data produces a diagnostic/list fallback, never an infinite layout loop. Selecting a node focuses the reader; pan/scroll/fit and row expansion change only view state.

Alternative: a calendar Gantt requires estimates the project does not have. A free-form graph would make nested task/document reading harder and adds layout state without improving the agreed first version.

### D3. Checklists are a read projection, not Kawai tasks

Parse GFM task-list nodes and enclosing headings from the source Markdown AST, ignoring fenced-code examples. Retain text, nesting, checked state, source line/anchor and source content hash; never use task numbers as durable assignment ids. Per-document row keys are local to its hash and position. On file replacement retain change selection and reconcile headings when possible; discard obsolete item selection with a visible notice.

Checkbox totals come from this projection; show the existing OpenSpec summary separately if it differs, rather than merging snapshots from different sources. The authoritative runtime outcome remains the supervision result. A change can show `12/12 items checked`, `In review`, and `Reviewer: …` simultaneously. Assignment holders come from outstanding work/claims associated with linked tasks and selected execution. Queued groups are not agent identities; former holders are history; active independent tasks can expose multiple current holders. No worktree-based guessing.

Alternative: import every checkbox as a task. Rejected because it invents a second completion/assignment system and requires stable item identity outside the agreed scope.

### D4. Scoped source resolution and document reader

Resolve OpenSpec artifact paths from the chosen change's canonical worktree and CLI artifact metadata (`status`), rather than assuming only proposal/design/tasks exist. Enumerate nested spec artifacts in returned metadata. Use the same canonical-source rule as discovery; if a convention worktree exists but lacks the change, report missing. Preserve plan nodes even when the active navigator registry no longer lists their change. For archived changes, resolve a unique CLI-recognized archive location in that source worktree; ambiguity/missing content is explicit. Do not search arbitrary worktrees or substitute another copy.

For every document return worktree id, relative path, content hash, size, modification time, and availability. Label current files as current; compare hashes to execution pins only when the pin contract provides the corresponding identity. Where it does not, state `Execution match unknown`. This change does not promise to reconstruct historical files.

Supporting references live in additive `plan_document_refs` rows: id, team_id, plan_id, optional change_name, label, kind (`local`/`external`), worktree_id and relative_path or URL, created_at. Validate plan/change scope before insert. Human add/remove commands are keyed/idempotent; removing a reference never deletes a file. Plan changes that remove a referenced change leave the reference inspectable as outside the displayed version. References are supporting metadata, not approved plan content or execution inputs. Explicitly attach architecture Markdown and image mockups through a labelled path/link form; offer normal document navigation, not a generic filesystem browser.

Local types: UTF-8 `.md`/`.markdown` up to 1 MiB; PNG/JPEG/WebP/GIF up to 10 MiB. HTML and SVG are not embedded in v1. Larger/unsupported files show an explanation and path, not truncated content that appears complete. Authorize repository and worktree membership before read; normalize relative paths, resolve symlinks and verify containment, and open only regular files with a race-safe containment check. Reject absolute paths, network paths and escapes. A repository-scoped asset endpoint applies the same checks and safe content type/response headers.

Extend Markdown with optional reader-specific link/image resolvers; preserve existing chat rendering defaults. Resolve relative links against the displayed document's directory, including `..` only when the final path remains in the permitted worktree. Relative Markdown links open in the reader; permitted images use the scoped asset endpoint. External HTTPS references open separately with noopener/noreferrer; remote images are shown as external links, and the server does not fetch URLs. File, script and other executable schemes are refused. Watch selected documents, invalidate cached hashes after writes and periodically reconcile; deleted references show a broken state. Stale last-valid content is explicitly labelled.

Alternative: external editor links alone lose the in-place planning experience. An unrestricted file-serving endpoint would expose unrelated workspace files.

### D5. Passive health with explicit partial coverage

Add read-only manager accessors/subscriptions for already held context and quota facts; do not use `chat-attach` for map agents. Reads never call start, restore, send, or usage refresh. Include only sessions relevant to linked work and the two conversation roles, filtering by team server-side. Existing profile quota refreshes continue under their own rules.

Proposed display defaults (UI policy, not model safety guarantees): context below 70% green, 70% to below 90% yellow, 90% and above red. Quota `warning` or a known window at 80% to below 100% is yellow; `limited` or a window at 100% is red; an allowed report below these thresholds is green. Measurements older than 15 minutes, or quota whose required reset already passed, become unknown. Known red wins, then yellow; green requires fresh green context and applicable quota, otherwise gray. Show partial facts even when the combined dot is gray. An approximate threshold remains approximate in the details and accessible label; the dot never predicts failure or controls dispatch. Recompute freshness on a client clock at least once a minute. On disconnect all readings are stale regardless of age.

Show context and quota independently in the popover, including source and timestamps. SDK host-account quota must be labelled as that account's allowance, not asserted to constrain a gateway provider. Keep an unrelated host-account reading inspectable but exclude it from provider-capacity aggregation when routing differs and applicability is unconfirmed. Missing telemetry for terminal sessions or unsupported providers is unknown, never zero. This is a presentation policy, separate from any existing staffing/limit decisions.

Alternative: one unexplained color hides whether pressure is per session or shared by profile. Attaching every session would cause process startup and unnecessary transcripts.

### D6. Repository roles are durable pointers to ordinary chats

Add `plan_workspace_chats(team_id, role, session_id, version)` with primary key `(team_id, role)` and unique `(team_id, session_id)`; role is `architect` or `lead`. Persist selection by human-only CAS commands so two tabs cannot silently overwrite a binding. Resolve team identity via common git directory, consistent with existing teams, rather than directory spelling. Validate chat kind and same-team identity on every bind and contextual send. Between refreshes, clients keep one lazy team-scoped bindings subscription (`team-plan-workspace-bindings-open`/`-close`, addressed by team path) that pushes on open, reconnect, and after every committed bind, replacement, or reset transfer, reconciling into a single per-team bindings slot by CAS version so the panel and any per-plan snapshot cannot diverge. Use the existing session picker; do not infer a Lead from name, group, activity or task creator. Create missing roles through the normal New Session dialog, then bind only after success. The human selects configured groups/profiles normally; the role label is not a permission grant and does not override a session's group prompt.

Archived sessions stay bound and read-only until ordinary Restore. Killed sessions leave a visible unavailable binding; only explicit replacement changes it. A successful local `/clear`, `/reset`, or `/new` uses the existing creation/group/profile/policy/archive flow, then CAS-transfers this repository role from the old session to the new same-team session. Creation failure leaves binding/history untouched. If a concurrent role replacement wins, do not overwrite it; show the newly created chat and explain the binding conflict. Never rebind the other role.

Architect work can introduce plans and edit artifacts only through its existing tools/rights (`canCreatePlans` where required). Lead dispatch and decisions remain existing tools. Binding a repository Lead is a UI conversation choice, distinct from the plan's execution `leadGroup`; warn when they differ and retain actual execution ownership and decision routing. No automatic synchronization of private chat histories is introduced; durable plans, artifacts and explicit references are the shared record.

Alternative: per-plan chats fragment today's single coordination session. A hidden special Lead process would lose existing identity and duplicate coordination.

### D7. Shared chat surface and captured message scope

Refactor the reusable transcript/composer/request portion of `ChatView` into a host-independent surface with optional workspace context, leaving normal full-screen ChatView as a wrapper. Preserve its existing components and controls. Use one mounted active conversation surface per host and reference-count attachment subscriptions per connection/session if multiple surfaces request the same chat. An inactive Architect/Lead is detached without interrupting its work. Preserve drafts by session as today, with an optional captured context beside the text; drafts remain client-local under existing reload semantics. Do not attach the other role just to display its tab.

Use an additive `chat-send.workspaceContext` envelope:

```text
team identity + plan id
version: revision number + content hash OR draft id + draft hash
optional selected execution id + its revision
optional change name + document reference/hash
```

The composer displays the attachment even before typing. Capture it when the draft first becomes nonempty; later selection changes do not mutate it. On a mismatch explain `Message is attached to Plan A` and offer an explicit replace action; sending the still-visible original scope is permitted. Switching roles uses that session's own draft. With no plan record (initial exploration), show `Repository planning; no plan selected` and send ordinary repository chat; once a plan is selected workspace messages require its attachment.

Before starting or sending a turn, resolve the bound session, plan, immutable revision or current draft/hash, change membership, execution and document references. Refuse stale draft/document hashes and wrong-team references, leaving the draft intact. A contextual send may carry a client-minted bounded `requestId`, which every refusal echoes with the session id — malformed context, unknown or archived session, stale hash, wrong team — so the client restores the exact original draft and attachment only on that correlation, never resends automatically, and sends without the field keep today's error shape; an accepted send answers with one acceptance on the sending connection alone, once the manager accepts, and it is never a ChatEvent. Immutable historical revisions remain valid and explicitly labelled even if approval changes. No ambient `current plan` variable lives on the session or server. Local slash reset commands are handled before envelope delivery. The installed SDK user-message type supports `uuid` and `pasted_content`: send the literal typed text as `message.content` and the explicit plan-context text as a separate `pasted_content` entry. This avoids prepending scope to a slash command or setting `client_composed` (which disables slash dispatch). Verify ordinary commands and local command output against the host CLI; a locally handled command records its attachment but need not invoke a model. Context is per message, never a mutable session-wide hook variable.

Store an immutable accepted envelope snapshot in `chat_workspace_turn_context(session_id, message_uuid, turn_id, context_json)` (primary key session/message UUID) and add optional metadata to the persisted `user_message` event. Snapshot plan title, version/hash and selected refs so killed plans/changed files do not rewrite past context. The driver allocates a user-message UUID independently of its turn id (multiple user messages can share an active turn), stores context with the visible user event before enqueueing, and sends the agent an explicit context block identifying the exact version and how to read it. Plain user text remains plain in the bubble; attachment metadata renders separately. On replay, join by the supplied user-message UUID and preserve metadata across live events, persisted events and SDK transcript reconstruction; carry that UUID in the SDK message and visible event for reconciliation. Retain turn id only for grouping, never as the unique attachment key. Never attribute an old turn using today's selected plan. Failure to validate/store metadata sends no contextual prompt. This adds no new automatic resend: reconnect restores history, not sends. This remains discussion scope, not a change to `session.task_id`, usage attribution, or authorization to execute.

Alternative: implicitly updating a session's active plan allows shared chats and queued drafts to be misattributed. A client-only chip would disappear from replay and would never ground the agent.

### D8. Navigation, panes and ordinary plan controls

Extend the Plans hash route to `#/team/<key>/plans/<plan-id>` with encoded query fields for view identity, execution, change, document and active role. Existing routes retain their current parse/format behavior. Validate selectors against loaded data; missing selections fall back with notices rather than silently selecting another record. Draft URLs identify a draft, not a mutable claim that it is the approved plan.

Use per-team/plan view state for expansions, filters, map scroll/zoom and reader state, and per-team role/pane sizes. Desktop uses a WBS/map region, a resizable reader region and an optional right chat panel. Each reader/chat can expand; keyboard resize controls match pointer behavior. Narrow screens show an accessible dependency list and explicit Map/Documents/Conversation navigation with Back restoring selection. Expose existing plan intent, review, validation, history, decisions, reports and actions as workspace sections; never remove the human approval affordance in favor of chat. Offline keeps last-valid content visibly stale and disables sends, reference/binding edits and plan mutations.

Alternative: overloading the global selected-session state would navigate away from Team and destroy workspace continuity.

## Risks / Trade-offs

- Pending plan services can change before landing -> implement after the named prerequisites; reconcile concrete module APIs against their landed contracts without weakening this behavior.
- Dense plans overwhelm a static dependency table -> collapse changes by default, lazy-load checklists, filter active/blocked work and retain a dependency text view; measure a 100-change/2,000-item fixture.
- Context age is a coarse health signal -> expose timestamps, approximation and unknown coverage; dots never change dispatch eligibility.
- Current files differ from approved/runtime inputs -> identify source and hashes; never label a current document as a historical snapshot without evidence.
- Reusing chat UI can disturb slash/reset/replay behavior -> preserve full-screen tests, add panel equivalence and contextual-command coverage; context goes through the same driver event path.
- Role labels can be mistaken for configured authority -> show group/profile/policy and any Lead-group mismatch; bindings grant no rights.

## Migration Plan

1. Land the prerequisite plan and workspace changes, then add nullable event metadata and the three additive metadata tables. Do not invent bindings, references, contexts or plans for existing data.
2. Ship server/read-model and protocol support before exposing workspace context controls. Older clients keep ordinary chat-send behavior; missing new event fields read as absent.
3. Expose the workspace in the existing Plans tab, retaining existing plan sections/actions. The human explicitly binds the current Lead and a distinct Architect.
4. Roll back the client to the prior Plans view if needed; metadata tables can remain unused. Preserve stored event/context records so later upgrades retain historical attachments. No migration rewrites task status, approvals or source artifacts.

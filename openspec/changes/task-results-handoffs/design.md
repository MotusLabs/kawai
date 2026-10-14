# Design

## Context

- `TaskStore` owns the durable task schema (`team_tasks`, `team_task_revisions`, `team_task_journal`); participants are derived, never stored, and nothing deletes a row. `TaskService` is the policy layer: only the creator or the human amends; only the creator sets `done`/`cancelled`, the human any status; notes are open to every member. These rights are the closing rules acceptance must ride, not replace.
- `task-assignment` (landed before this change implements) adds `team_task_assignments` — one row per dispatch with target, role, instruction, creator, `request_key` unique per team, claim, and supersession — plus a dispatch that inserts the row and enqueues the instruction mail in one transaction, client-minted request keys for replay idempotency, worktree routing through the existing staffing rules, and a read-time derived assignment state. Assignment history is visible in task detail.
- `team-member-release` (unmerged; lands before this change implements) adds the release primitive: `team_member_releases` rows, readiness (`idle && !pendingRequest`, no claimed or parked mail, no due queued direct mail — the dispatcher's own `MailRecipient` view), archive through an injected `archive(sessionId)` (never kill), the `system` journal author rendered "Kawai", `release_member` for groups setting `canReleaseMembers`, and `worktreeScoped` for groups whose members never live in task worktrees. Its proposal defers the human-facing **Release worktree and hand off** action and its review dispatch to later work, naming `team-workspace`; this change takes that deferred action and builds it on the primitive.
- `ChatSessionManager.archive` is the safe stop: interrupt the turn, settle pending requests and recipient claims, kill the process, keep the record, conversation, and protocol log; restore resumes. `chat_sessions.spawned` + the pinned `task_id` ("live spawned members of task T") is a stable query.
- `team-waiting-reasons` renders why queued mail waits, including worktree occupancy by a spawned member — exactly what a review handoff queued behind the developer shows (E07).
- `taskTools.ts` binds every task tool to the calling session; joining `TASK_TOOL_NAMES` puts a tool in `TEAM_ALLOWED_TOOLS`, so it needs no approval card. Human actions ride `taskConnections.ts`'s `act()` switch and must be listed in `CHAT_CONNECTION_TYPES` in `src/server/chat/chatConnectionTypes.ts` (which `ws/messageRouter.ts` consults).
- Strategy revision 2 (approved): landing is acceptance (P5), a clean reviewer verdict is part of the check floor (P6), records survive replaced sessions (P9), trustworthy results outrank throughput (P10). Test outcomes and verdicts reported by agents are claims; independence comes from who reported them, not from the transport.

## Goals / Non-Goals

**Goals:** one durable result record per submission with claim-labeled evidence; handoffs as ordinary assignments to a role; findings that cannot drift onto a newer commit; acceptance that closes only through the existing rights with the unresolved work shown first; the needs-re-evaluation label as a pure derivation; release-and-hand-off composed from the two landed primitives (assignment dispatch + member release) with no new lifecycle.

**Non-Goals** (beyond the proposal's): verifying claimed tests server-side; workflow-stage labels and the attention queue (`team-workspace`); publication, notification, or acknowledgement of revisions (`task-revision-publication`); read-only reviewers or overlapping staffing; an agent-side release composition (agents use `release_member` + `task_handoff`); changing closing, amendment, or staffing rules.

## Decisions

### D1. Two new tables; handoff columns on `team_task_assignments`

```sql
team_task_results (
  id TEXT PRIMARY KEY,             -- 'result-<uuid>'
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_ref TEXT, diff_ref TEXT,  -- at least one required at submission
  worktree TEXT,                   -- pinned from the task at submission
  tests TEXT NOT NULL,             -- JSON [{description, outcome}], [] allowed
  limitations TEXT,
  task_revision INTEGER NOT NULL,  -- pinned at submission; drives D6
  submitted_by_kind TEXT NOT NULL, -- 'agent' in this change
  submitted_by_session TEXT NOT NULL,
  supersedes_result_id TEXT,       -- the prior outstanding result, if any
  accepted_by_kind TEXT, accepted_by_session TEXT, accepted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX team_task_results_task ON team_task_results (task_id, created_at);

team_task_findings (
  id TEXT PRIMARY KEY,             -- 'findings-<uuid>'
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result_id TEXT NOT NULL,         -- the exact result examined (D4)
  handoff_id TEXT,                 -- the handoff answered, when there was one
  kind TEXT NOT NULL,              -- 'review' | 'qa'
  verdict TEXT NOT NULL,           -- 'pass' | 'fail'
  findings TEXT NOT NULL,
  author_kind TEXT NOT NULL, author_session TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

The **outstanding result** of a task is the newest result nothing supersedes; submission sets `supersedes_result_id` to the previous outstanding one in the insert transaction, so there is never more than one and earlier results stay readable (UX §5 "each attempt and result has a separate identity"). Acceptance marks the row it accepted. Actor columns reuse the shared `TeamActor` vocabulary; the `system` author from `team-member-release` stays journal-only, so a result's submitter and acceptor are always real actors. A handoff is an assignment: `team_task_assignments` gains nullable `handoff_kind` ('review' | 'qa' | 'fix'), `result_id`, and `expected_response` columns here — the table is `task-assignment`'s, the columns are this change's, and D4's payload comparison extends to them. *Why not a third table for handoffs:* task-assignment's record already is "one row per dispatch with target, role, instruction, idempotency, claim, supersession"; a parallel table would duplicate all of it and fork the dispatch path.

### D2. Submission is open, pinned server-side, and changes no status

`task_submit_result` (input: `task_id`, `summary`, `commit?`, `diff?`, `tests?` as `[{description, outcome}]`, `limitations?`; at least one of commit/diff) is callable by any member of the task's team — the same openness as journal notes, justified by the cooperative trust model (strategy P4) and gated where it matters: acceptance. The server pins `task_revision` (the task's current revision) and `worktree` (the task's worktree, else the submitting session's resolved worktree) at submission, never the client. Submission appends one journal entry authored by the submitter (`Submitted result <id>: <summary>`), which is what carries result news into the five-entry journal excerpt every task-mail recipient sees — no new mail is sent. Task status is untouched: a submitted result is not a finished task (UX §1 "do not infer that a task is done from a finished agent turn"; same ruling as task-assignment D9). "Claimed" is a display rule over every test-outcome field, not a stored flag — nothing in the record ever says verified.

### D3. Handoff dispatch reuses task-assignment wholesale; one agent tool

A handoff dispatch is `AssignmentService.dispatch` (or the dispatch method `task-assignment` lands on `TaskService`) with the handoff columns set: kind, `result_id` of the referenced result, and `expected_response`. The handoff fields join that change's dispatch payload identity (its design D4): `handoff_kind`, `result_id`, and `expected_response` take part in the request-key comparison when set, at both sites its implementation owns — `payloadDiff` in `assignmentStore.ts` and the payload build in `AssignmentService.ts` on `feat/task-assignment`. Without the extension, a **Request review** on result A under key K whose retry after a reconnect carries result B would compare only target and instruction and return the review-of-A assignment as the replay outcome; with it, the replay is refused naming the changed field. `task-assignment` merges first; this change makes the extension during its own implementation. Human path: **Request review** / **Request QA** / **Return for fixes** in task detail open a small form (role group, instructions, expected response), mint one client request key per intent, and dispatch through the existing transaction — reconnects and double clicks return the prior assignment (E01-style idempotency for free). Agent path: `task_handoff` (`task_id`, `kind`, `result_id`, `target` group, `instructions`, `expected_response?`) validates task and result of the caller's team, group in the catalog, non-empty instructions, then checks for an outstanding equivalent handoff — same task, result, and kind — and returns it with a duplicate notice instead of dispatching again (a transport-level tool retry must not produce two assignments and two instruction mails); with none outstanding it dispatches with a fresh server-minted key per call. *Why standing-based dedupe rather than a tool replay key:* the tuple names the intent — while an equivalent handoff stands, a second identical instruction is a retry, and a dead-lettered one loses standing (task-assignment D5) so a genuine re-request still dispatches. The duplicate notice names the outstanding handoff and its dispatcher, so a caller whose instructions differ can wait, journal, or escalate instead of silently overrunning. Request keys stay a UI mechanism for reconnects and double clicks the user cannot see; `send_message` offers no such dedup either, and the mailbox's claim-once delivery remains the delivery guarantee. Worktree routing, spawning, and the occupancy waiting reason all apply unchanged because the instruction is ordinary task mail; a review handoff queued behind the developer in the worktree is exactly E07's occupancy assertion, owned by `team-waiting-reasons`. Every handoff supersedes the task's outstanding assignment as its next stage through task-assignment's **stop** branch, with no notify/stop choice and no reassignment note — an instruction still queued or awaiting a request is cancelled so a superseded stage never delivers later — and the human key replay and the agent's outstanding-equivalent check run before it, so a retry never supersedes its own handoff.

### D4. Findings bind to `result_id`; verdicts are the floor's input

`task_submit_findings` (`task_id`, `result_id`, `kind` 'review'|'qa', `verdict` 'pass'|'fail', `findings` text) is open to any member; the record names its author, so independence is visible, not enforced — reviewer role enforcement is the Wave C staffing question. The binding is the whole rule: findings attach to one result, render beside it with that result's commit reference, and a newer result simply has none. "Later commits never inherit approval" (E07, R14) falls out of the identity — there is no task-level approval field to go stale. `handoff_id` is stored when the findings answer a handoff (attempt identity, UX §5), read off the calling session's outstanding handoff assignment for the task; findings without a handoff are allowed. The check floor (strategy P6) reads `verdict = 'pass'` findings; like test outcomes they remain an agent's report — their weight comes from the author being someone other than the submitter, which the UI shows by naming both.

### D5. Acceptance marks the result and closes through `setStatus`

**Accept result** (human always; agent only the task's creator — the same rights as `done`) evaluates the closing right *first*, under the exact rule `TaskService.setStatus` enforces (`TaskService.ts`: only the creator or the human sets `done`), and a refusal writes nothing — no `accepted_*`, no journal entry, no status change. An authorized acceptance then commits `accepted_*` on the result, the acceptor's journal entry, and the `done` status in one transaction, so every closing right, refusal message, and reopen rule stays exactly `team-tasks`' — no second closing path exists to grant or leak (E10: a contributor is refused with nothing written). Guardrails, enforced server-side: when the accepted result is labeled Needs re-evaluation (D6), or the task has child tasks not `done`/`cancelled`, a non-empty `reason` is required and journaled (`Accepted result <id> despite <flag>: <reason>`). The task's acceptance criteria are displayed in the accept confirmation (the system cannot resolve free-text criteria; it shows them and the result's findings so the human decides with eyes open). Accepting a child's result never touches the parent — acceptance is per-task, and nothing walks the `parent_id` graph. *Rejected alternative:* an acceptance that only marks the record without closing — UX §5 makes acceptance the closing act, and a marked-but-open task has no distinct meaning at this baseline.

### D6. Needs re-evaluation: the revision-published contract's row rule, derived at read

Bound to `task-revision-publication`'s contract (its design D8), not invented here: the durable fact is the `team_task_revisions` row (revision, previous = revision − 1, author, rationale, `created_at`); ordering is the revision number; a consumer that missed events recomputes by comparing a result's input revision with `team_tasks.revision`. That comparison — `result.task_revision < task.revision`, at read time — is this change's whole mechanism: no stored flag to mutate, nothing to backfill, and no subscription to `TaskService.onRevisionPublished`, because there is nothing to mark; a derivation over the durable rows has no missed-event window at all (the event exists for consumers that must react — the label only has to be true when read, and a revision bump already republishes task snapshots through `TaskStore.changed`). Agent `task_amend` publishes immediately under the contract, so agent-driven amendments flag results exactly as plain `team-tasks` behavior does today; human drafts create no revision row and flag nothing until published. Every result pinned below the current revision is labeled, permanently — history keeps the label because the mismatch is a fact about the record, and clearing it would fabricate re-examination; the *way back* is a new result (which supersedes, D1). Their D8 leaves the label and its rules to this change and blocks on nothing here, so the two changes impose no landing order on each other.

### D7. Release-and-hand-off: validate, readiness-check, archive, dispatch — in that order

A human action in task detail (offered when the task has a worktree and an outstanding result), composing the two landed primitives; it is *not* the deferred pending-release path of `team-member-release` (that one waits; E08 wants an immediate actionable refusal, like their D6 ruling for `release_member`). Sequence:

1. Validate the review request (target group exists, instructions non-empty) — refuse before anything is touched.
2. Collect the task's live spawned members (`spawned = 1`, `task_id` = the task — the same stable query `team-member-release` uses) and readiness-check each with their D3 rule (which includes no live background workers — `ChatWorker.live`, `src/shared/chat.ts`; `MailRecipient.idle` is only `status === 'waiting'`), every member checked before any is archived: one not-ready member refuses the whole release, naming the member and the blocking fact (mid-turn, awaiting an approval or answer, holds claimed/parked mail, live background worker) — actionable, nothing archived, nothing dispatched (E08).
3. Only when every member is ready, archive each through `ChatSessionManager.archive` (never kill); append `team-member-release`'s system-authored journal entry with this action's reason ("worktree released for review at the human's request"), extending their entry builder's reason list, not its shape.
4. Dispatch the review handoff (D3) referencing the outstanding result; a dispatch failure here is surfaced with the release already done and an inline pointer to **Request review**, which retries the dispatch without re-archiving — archive is the human's explicit intent and is never rolled back to "make" the dispatch transactional. The freed writer slot lets the reviewer spawn in the same pass. When a review handoff of the outstanding result already stands (D3's equivalence — not superseded, not failed), typically queued behind the occupied worktree, release frees its slot and returns that review instead of dispatching a second; a resend with no member left returns it again.

The confirmation dialog shows every session to be archived and every other live session resolved in the worktree (manual sessions are invisible to the spawned-writer cap; UX §6 "do not claim the existing cap prevents all concurrent edits"). Release is human-only at this baseline: agents compose `release_member` (their group opt-in) + `task_handoff` themselves, which is the same sequence with existing tools. *Rejected alternative:* automatic release on result submission — dispatching review while the developer still holds the worktree recreates the occupancy stall this exists to remove, and pre-empts the human's right to inspect first.

### D8. Surfaces: detail-first, summary presence, protocol rides existing messages

`TeamTaskDetail` gains a Results section (a new `TaskResultsSection.tsx`; the component is at the top of its size class already) — newest result first as the outstanding one, superseded results kept readable beneath, each showing its evidence with the **claimed** label, the needs-re-evaluation badge, its findings with kind/verdict/author, and the per-result actions (**Accept result** where rights allow, else a disabled control naming why; handoff actions on the outstanding result). `TeamTaskSummary` gains the outstanding result's id and flag so list rows can badge a submitted/flagged result. Wire: `team-task-handoff`, `team-task-accept-result`, `team-task-release` client messages (all through `taskConnections.act()` as the human caller, answers via `team-task-result`, listed in `CHAT_CONNECTION_TYPES` in `src/server/chat/chatConnectionTypes.ts` — which `ws/messageRouter.ts` consults), with results and findings riding the existing `team-tasks-snapshot`/`team-task-detail` shapes additively. `task_get` returns results and findings (a fixer or reviewer reading the task sees what it is answering); republishing reuses the existing task-change and task-mail republish paths, which a result write touches through its journal entry.

## Risks / Trade-offs

- [`team-member-release` is unmerged] → hard dependency: it lands first; a conflict with its proposal is reported to the lead rather than edited around. Its journal-entry reason list grows by one string (D7.3) — noted here for its implementer.
- [Review handoff queues forever when no reviewer can be staffed] → correct and visible: the waiting reason names it (`team-waiting-reasons`); the human reassigns or spawns by hand. Not this change's rules.
- [Archive succeeds, dispatch fails] → the worktree is released (the human's primary intent), the inline error points at **Request review**, which retries the dispatch without re-archiving; a second release attempt finds no live spawned member and refuses with exactly that reason.
- [Two agents submit results concurrently] → both insert; the later `created_at` wins the supersession chain and the earlier stays readable — last-writer-outstanding is acceptable at this baseline; assignment claims already serialize who works a task.
- [Open submission lets an agent spam results or findings] → the journal is the visible rate; acceptance gates meaning; kill and journal archaeology cover abuse, as with notes today.
- [Free-text tests and verdicts stay unverifiable] → inherent to the baseline: labels claim, findings name their author, acceptance is human/creator. Server-side verification is explicitly out of scope.

## Migration Plan

Additive only: `team_task_results` and `team_task_findings` tables and the nullable `handoff_kind`/`result_id`/`expected_response` columns on `team_task_assignments` (PRAGMA-check pattern), no backfill — pre-existing tasks simply have no results. Existing assignments read with null handoff fields as plain dispatches. Rollback: drop the two tables and the three columns; nothing else references them.

## Decisions (delegated by the lead, 2026-10-14)

The human delegated Wave B2 decisions to the lead; the lead's direction delegated these to this change, each decided above with rationale:

- One new capability `task-results`, no modified capabilities (proposal).
- Submission, findings, and handoff tools open to any team member; rights gate acceptance only (D2, D3, D4).
- Agent tool calls take no replay key; only human UI actions carry request keys (D3).
- Acceptance closes the task; reason required for flagged results and open child work (D5).
- Needs re-evaluation derived at read from the revision-published contract's row rule, never cleared (D6).
- Release-and-hand-off is human-only, immediate (refuses rather than defers), archive-then-dispatch (D7).

None remain open; nothing here is judged genuinely the human's call.

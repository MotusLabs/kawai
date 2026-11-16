# Design

## Context

All observations below are pinned to `714cf8da`. This is a proposal, not implementation approval. See proposal.md for the split and historical size provenance; no current latency measurement exists.

| Current path | Observed composition / implication |
| --- | --- |
| src/server/team/taskTools.ts | task_get → TaskJournalReads.agentGet → agentDetail → applySeal; schema currently accepts journal/revision arguments only |
| src/server/team/taskJournalWindow.ts | Synchronous read transaction; SQL journal/100-child/50-message limits; full child summaries, bodies, results, assignments, publications and acks still materialized |
| src/server/team/taskListWindow.ts | AgentTaskRow projection with same derived assignee/result; currently private row method, to share without selecting directions |
| src/server/team/taskRevisionWindow.ts | Existing 50-row revision window, identityOf and rationale previews; selected revisionText; publicationRevisions currently unbounded |
| src/server/team/taskStore.ts | summary includes current instruction and derived outstanding result; detail/humanDetail stay whole |
| src/server/team/taskResultStore.ts; TaskResultService.ts | Outstanding derivation, immutable submission pin; applySeal covers coverage, reviewer maps, comparisons and check outcomes based on current handoff |
| src/server/team/mailboxStore.ts; assignmentStore.ts; taskAcknowledgements.ts; taskNotices.ts | Current full histories; publications synthesize recipients from holders and distinguish delivery from acknowledgement |
| src/server/team/mailboxTools.ts | teamToolTable registers shared schemas/handlers/descriptions; Claude adapter JSON.stringify serializes returned detail |
| src/server/chat/ChatSessionManager.ts | Actual runtime construction passes teamToolTable to both runtimes; Codex resumes retain their original tools |
| src/server/__tests__/codexTeamPath.integration.test.ts | Exact task_get inputSchema keys at line 342; update for every new argument while preserving resume-without-registration and current guidance assertions |
| src/server/__tests__/teamTaskService.test.ts | Exact registered MCP tool list at lines 325–327; update for task_result_diff_read and preserve allowed-without-cards assertions |
| src/server/__tests__/teamEnvelope.test.ts; taskEnvelopeCompatibility.test.ts; taskEnvelopeV2Compatibility.test.ts | Real envelope/notice and generation 1/2 compatibility consumers for H9; preserve old bytes and receipt identity |
| src/server/team/teamPrompt.ts; taskContext.ts | Task guidance; delivery-time current revision/contract and versioned mail header; old recorded header bytes must keep parsing |
| src/shared/teamTasks.ts | AgentTaskDetail currently inherits human result/history types; introduce explicit agent projections without weakening HumanTaskDetail |
| src/server/team/taskConnections.ts; src/client/stores/teamTaskStore.ts; src/client/components/team/TeamTaskDetail.tsx | Human WebSocket path uses humanDetail and full snapshots; preserve this independent consumer |
| docs/architecture/tasks.md; docs/architecture/mailbox.md | Existing task tool, publication, result/seal and versioned mail contracts |

Relevant existing tests: taskJournalWindow, taskJournalRead, taskJournalTools (both real adapters), taskRevisionWindow, taskListTools, taskResultCoverageSeal, taskGetLedger, teamPrompt and taskResultConnections under src/server/__tests__. These are baselines, not evidence that future behavior exists. Read-only planning adds no runtime tests. Legacy G6–G8 are already implemented and retained as regression rows, not reimplementation tasks.

## Goals / Non-Goals

Complete only missing task-read work; preserve task_list, journal/revision reads, seals, current identity and human detail. No metrics/report changes, adoption of held branches, new recovery mechanism, schema migration or write semantics.

## Decisions

The task-only legacy D5–D8a mechanism below is proposed intact. SQL applies limits and byte projections before JavaScript; do not fetch every historical result to slice later. New helpers `taskReadWindows.ts` and `taskResultDiffRead.ts` separate bounded histories/results and chunks, keeping files under 500 lines. Extract the compact child projection from taskListWindow into `taskAgentRow.ts`; both task_list and child reads call it. Existing summary/derived internals may still inspect history; do not claim constant query cost for all derivations. Query instrumentation must distinguish projection from derivation.

### D5 — Subtasks as `AgentTaskRow`, with an anchor

`agentDetail` maps subtask ids through `bounded-task-list`'s compact
projection (one helper, shared with `task_list`, so both readers derive
`assignee` and `result` the same way). That covers hazard "several readers
disagreeing on derived state".

`subtasks_before` resolves an anchor `(created_at, rowid)` among
`team_tasks WHERE parent_id = task`. An unknown id, or an id that is not a
subtask of the task, is refused as
`Unknown subtask of this task: <id>`. The window query adds the
strictly-older predicate that the journal uses.

`bounds.subtasks` gains `nextBefore`: the oldest returned id when more remain.

### D6 — Message bodies as byte previews, with an anchor

`forTaskNewest` gains an anchor and a preview projection. It selects
`length(CAST(body AS BLOB))` and `substr(CAST(body AS BLOB), 1, 2000)`, and
passes them through the journal's `journalPreview`. The result: `body` is the
preview text (null when it is not exact UTF-8), and the message gains
`bodyBytes` and `bodyCut`. Every other `TeamMessage` field is unchanged.

`messages_before` anchors on a message whose `task_id` is the task; any
other id is refused as `Unknown message of this task: <id>`.
`bounds.messages` gains `nextBefore`.

`full_messages: boolean` (zod `z.boolean().optional()`, default false) selects
the whole body in the same query, in place of the `substr` projection. It is
still decoded through the same exact-UTF-8 check, so text is null only for
bytes that are not exact UTF-8. `bodyBytes` is the stored length, and
`bodyCut` is false. Only the projection changes: the window of 50, its
`(created_at, rowid)` order, `messages_before`, and `bounds.messages` are
the same as in the default read. So a walk with `full_messages` returns the
same messages, page by page, as the walk without it. The flag touches no
other section. With it, the response is bounded by message count, not
bytes, which is why it defaults to false.

*Alternative considered:* a per-message argument (`message_id`) returning one
body whole. Rejected for now: the flag is simpler to describe and to use
alongside the existing window, and an agent that wants one long body can
pair it with `messages_before` set just after that message.

*Alternative considered:* the 300-character cut that `list_mailbox` uses.
Rejected: task mail carries instructions, and the 2,000-byte journal bound
is the established agent read size.

### D7 — Revisions: a window of rows, and a `revision` argument

Each revision becomes
`{ revision, identity, contractHash, author, createdAt, notify, directionBytes, acceptanceBytes, rationale, rationaleBytes, rationaleCut }`.
The byte lengths come from SQL. `identity` is the `r<N>#<hash12>` the store
already reports (`contractHash.ts`: the contract hash, else the text hash),
so an agent can tell whether an older revision changed the text without
reading it. SQLite cannot hash, so the statement selects direction and
acceptance for the windowed rows only (after `LIMIT`); JavaScript hashes
them and drops them, and no row carries text. `rationale` is a 2,000-byte preview, projected
in SQL like a journal entry (`substr(CAST(rationale AS BLOB), 1, 2000)`) and
passed through `journalPreview`. Rationales have no length limit at
submission (`taskTools.ts:41`), so they cannot be assumed short.

The list is the newest 50 by revision number, returned oldest first, with
`bounds.revisions: { total, returned, truncated, nextBefore }`. `nextBefore`
is the oldest returned revision number while older ones remain.
`revisions_before: n` must be an integer in `2..task.revision`; otherwise
it is refused as `Unknown revision of this task: <n>`. With it, the list
holds the 50 revisions below `n`. Revision numbers are dense and unique per
task, so the anchor needs no tie-break.

`revision: n` must be an integer in `1..task.revision`, else it is refused
in the same way. When valid, the detail gains
`revisionText: { revision, direction, acceptance, rationale }`, all whole.

### D8 — Results: the outstanding one whole, a window of rows

`results` keeps its order: the outstanding result first, whole, and then the
other results newest first by `(created_at, rowid)`, as rows. There are at
most 50 rows, with
`bounds.results: { total, returned, truncated, nextBefore }`, where `total`
counts the non-outstanding results. A row is:
`{ id, commit, taskRevision, submittedBy, supersededBy, acceptedAt, reviewVerdict, createdAt, summary, summaryBytes, summaryCut }`.
`summary` is a 2,000-byte preview: summaries are only trimmed at submission
(`TaskResultService.ts:143`).

The outstanding result is never counted in the window or used as its anchor.
It appears in every read, whatever `results_before` says.
`results_before` names a non-outstanding result of the task. Any other id,
including the outstanding result's, is refused as
`Unknown result of this task: <id>`.

`result_id` names any result of the task, else it is refused the same way.
It also returns that result whole, as `resultDetail`. Its summary, findings,
tests, and maps are whole.

In every whole result, `diff` becomes an 8,192-byte preview with
`diffBytes`, `diffCut`, and `diffResumeOffsetBytes` (0 when the preview is
not exact UTF-8), using a preview helper parameterized by the byte cap (2,000 for
journal/message/rationale/summary previews, 8,192 for diffs). The current
`journalPreview` hard-codes 2,000; do not reuse its cut calculation for diffs.
Preserve its exact-UTF-8 trim and zero resume offset for null text. A result may
carry a diff and no commit (`TaskResultService.ts:147` refuses only a result
with neither), so the diff can be the only record of the change. D8a makes
every byte of it readable.

The seal: every whole result passes through the existing
`TaskResultService.applySeal`, the one implementation behind every agent
reader. That covers the outstanding result and `resultDetail`, which goes
through as a one-element list. Rows carry no coverage, maps, checks, or
findings, so they have nothing to seal. Diff bytes are not sealed today, and
D8a does not change that.

### D8a — `task_result_diff_read`, a lossless diff reader

A new read-only tool, `task_result_diff_read { task_id, result_id, offset_bytes? }`,
mirrors `task_journal_read` (bounded-log-reads-and-task-get D6) for a
result's diff. Its result is
`{ resultId, offsetBytes, totalBytes, returnedBytes, dataBase64, text, nextOffsetBytes }`.
One statement selects `length(CAST(diff AS BLOB))` and
`substr(CAST(diff AS BLOB), offset + 1, 8192)` for the result, and only when
the result belongs to the task. The chunk is trimmed back to a whole
character unless it ends the diff. Bytes that are not exact UTF-8 are
returned untrimmed, with null text. `dataBase64` is authoritative.

Refusals:
- `offset_bytes` must be a safe non-negative integer no larger than the
  total; otherwise it is refused, naming it.
- At exactly the total, the tool returns zero bytes and a null next offset.
  A result with no diff has total 0.
- Caller and team rules are `TaskJournalReads.readable`'s: a system caller
  is refused, and a foreign team's task, or a result of another task, is
  refused as not found.

A whole result's `diffResumeOffsetBytes` is where the reader continues, as
a journal preview's `resumeOffsetBytes` is for `task_journal_read`.

*Alternative considered:* a `diff_offset_bytes` argument on `task_get`.
Rejected: it would give `task_get` a second result shape. A separate reader
already exists as a pattern, so agents learn one paging style.

*Alternative considered:* relying on the commit. Rejected: diff-only results
are valid, and their diff is the evidence a reviewer judges.

### D9 — Remaining histories (explicit owner-review refinement)

Legacy 3.5 caps these histories but supplies no agent continuation. Propose `assignments_before` as assignment id, `publications_before` as revision >= 2, and `acknowledgements_before` as `{session_id, revision}` (existing unique acknowledgement key; never invent a synthetic stored id). Resolve each anchor under task_id, refuse missing/foreign/malformed values, then SQL-select the newest 50 older rows. Assignments/acks use `(created_at, rowid)`, publications revision number; return oldest first. Each bounds entry has total (all rows), returned, truncated (older remaining), nextBefore (oldest returned key or null). These are current-row walks, not snapshot tokens. Assignment rows omit instruction; publication rationales use 2,000-byte previews with rationaleBytes/rationaleCut, full rationale through `revision`. Recipients keep their current derived states; nested recipient count is not capped by this slice. Acknowledgements preserve session/revision/assignment identity. No new whole-history bypass is added.

### D10 — Current identity, ordering and seal

Validate caller/team before record lookup; validate every provided anchor even when another valid argument is present. One synchronous read transaction covers task identity, current assignment, outstanding id, selected record, windows and counts. Seal default whole results and resultDetail through the same existing projection; evaluate the handoff predicate against the same synchronous read state (move projection into the transaction callback if needed, no awaited work inside it). Rows never include coverage/maps/checks/findings. Selected result equal to outstanding may appear in both fields but must have identical sealing. Do not mutate or reinterpret a stored taskRevision when current direction changes.

Between calls no frozen snapshot is promised: inserts newer than the anchor do not enter older pages, totals can change, mutable derived verdict/notice state can refresh. Supersession can move the former outstanding result into history; a history anchor that is now outstanding is refused. Re-read from default for a refreshed history walk after such mutation. This preserves write ordering and revision pins without adding epochs or recovery state.

### D11 — Guidance and compatibility

Update task schemas/handlers/descriptions, teamPrompt task note and TASK_JOURNAL_GUIDANCE, plus architecture. Name every old and new argument, all bounds/preview fields and full routes. Old Codex catalogues cannot discover new arguments/readers: stop before conclusions requiring omitted data and request a fresh thread; never use DB/log/shell bypass. Do not promise universal response byte bounds: current task direction/acceptance/instruction, outstanding/selected whole results apart from diff, full_messages, recipients, participants and current derived fields can be large. Count bounds and preview bounds are specific.

Preserve taskContext header generation 1/2 renderers byte-for-byte. Retain existing delivered header wording: it already routes journal paging correctly; new section routes belong in descriptions and prompt guidance. Old receipts must still reconcile. Do not silently edit generation 2 strings. No client types or human UI read may adopt agent projections.

## Risks / Trade-offs

Breaking agent output → owner review before implementation, fresh-thread guidance and both-adapter tests. Whole records remain potentially large → explicit exceptions and deterministic size fixture, not an invented global latency/byte SLA. Invalid UTF-8 → authoritative bytes via diff reader; full_messages keeps null body for invalid bytes exactly as legacy proposes (no new lossless mail API). Nested recipient lists and current task participants remain whole → disclose this limit; do not silently widen into mailbox redesign.

## Acceptance oracles

All rows and properties here are PLANNED. Commit the tables verbatim as data-driven tests through production readers/registered runtime adapters. Existing G6–G8 tests are regressions. G fixture: 1,993 journal entries, 163 children, 114 messages, 8 revisions, 5 results, 70 assignments, 70 acknowledgements, and 7 publications (revisions 2–8); clustered timestamps. The 70 acknowledgement identities are distinct (session, revision) pairs from nine sessions: eight sessions acknowledge revisions 1–8 and the ninth acknowledges revisions 1–6, with each acknowledgement assignmentId null. The 70 assignments form a supersession history with one current holder, providing the one recipient per publication. This obeys the existing (task_id, session_id, revision) primary key. H1 uses separate fixtures: a publication count N needs N+1 revisions, so its 70-publication case has 71 revisions; do not add those revisions/publications to the G16 size fixture. For the size row fix current direction/acceptance/instruction and each child title to 128 ASCII bytes, each journal/message/rationale/summary to 32 bytes, each diff to 307,200 bytes, one recipient per publication, one short finding/test per result, empty maps/checks. Store fixture source and byte-count assertion; do not claim it reproduces current live data.

| id | call | result |
| --- | --- | --- |
| G1 | default | subtasks are `AgentTaskRow`s with no `direction` key; `bounds.subtasks` total 163, truncated, `nextBefore` = oldest returned |
| G2 | `subtasks_before` = a task of another parent, an unknown id | refused `Unknown subtask of this task: <id>` |
| G3 | a message body of 6,000 ASCII bytes | body = first 2,000 bytes, `bodyCut` true, `bodyBytes` 6,000 |
| G4 | a body whose 4-byte character straddles byte 2,000 | body ends before it; `bodyBytes` exact |
| G5 | `messages_before` = a message of another task | refused `Unknown message of this task: <id>` |
| G5a | `full_messages: true` on the G3 task | body all 6,000 bytes, `bodyCut` false, `bodyBytes` 6,000; every other section deep-equal to the default read's |
| G5b | `full_messages: true` with `messages_before` walk | same message ids per page as the walk without it; each body equals the stored body |
| G5c | `full_messages` `"yes"`, `1`, `null` | refused, naming `full_messages` as a boolean |
| G6 | default | 8 revision rows with no `direction`/`acceptance` keys; byte lengths equal the stored ones; each row's `identity` and `contractHash` equal the store's `TaskRevision` for that revision (a contract revision and a text-only revision both present) |
| G6a | a 70-revision task, default | newest 50 rows (21–70) oldest first, total 70, truncated, `nextBefore` 21 |
| G6b | `revisions_before: 21` on the same task | rows 1–20, not truncated, `nextBefore` null |
| G6c | `revisions_before` 0, 1, 71, 1.5 | refused `Unknown revision of this task: <n>` |
| G6d | a 5,000-byte ASCII rationale | row `rationale` = first 2,000 bytes, `rationaleCut` true, `rationaleBytes` 5,000; `revision` on it returns it whole |
| G7 | `revision: 3` | `revisionText` equals revision 3's stored direction, acceptance, and rationale |
| G8 | `revision` 0, 9, 1.5 | refused `Unknown revision of this task: <n>` |
| G9 | default | `results[0]` whole; 4 rows without `findings`, `coverage`, `reviewerMaps`, or `diff` |
| G9a | 1 outstanding + 70 superseded results, default | outstanding whole first; 50 newest rows; `bounds.results` total 70, truncated |
| G9b | `results_before` = the last row's id | the outstanding result whole again, then the 20 oldest rows, `nextBefore` null |
| G9c | `results_before` = the outstanding result, another task's result, an unknown id | refused `Unknown result of this task: <id>` |
| G9d | a 5,000-byte summary on a superseded result | row `summary` 2,000 bytes, `summaryCut` true, `summaryBytes` 5,000 |
| G10 | `result_id` of a superseded result | `resultDetail` whole, equal to the authorized reader view apart from the diff preview |
| G11 | sealed reviewer: default, and `result_id` = the handoff result | submitter coverage withheld in both; own maps only |
| G12 | `result_id` of another task's result, an unknown id | refused `Unknown result of this task: <id>` |
| G13 | a 300 KB diff | `diff` 8,192 bytes or fewer, whole characters, `diffCut` true, `diffBytes` 307,200 |
| G13g | diffs of 2,001 and 8,192 ASCII bytes | whole preview, `diffCut` false; resume offset equals total |
| G13a | `task_result_diff_read` walked from offset 0 on a diff-only result with a 300 KB diff | concatenated `dataBase64` bytes equal the stored diff; last `nextOffsetBytes` null |
| G13b | read from the whole result's `diffResumeOffsetBytes` | first chunk starts at the byte after the preview |
| G13c | `offset_bytes` −1, 1.5, total + 1 | refused, naming the offset |
| G13c2 | `offset_bytes` = total | 0 bytes, null next |
| G13d | a result with a commit and no diff | total 0, empty data, null next |
| G13e | a stored diff whose bytes are not exact UTF-8 at a chunk edge | `text` null, `dataBase64` untrimmed |
| G13f | result of another task; task of another team; a system caller | refused as not found (first two), refused as a system read (third) |
| G14 | default | no assignment row has `instruction`; `task.assignment.instruction` whole |
| G15 | default | acknowledgements: 50 newest, total 70, truncated |
| G16 | default, serialized | < 256 KB (deterministic fixture above; not a live measurement) |
| G17 | the human's detail of the same task | unchanged: every section whole, compared with the pre-change detail fixture |

| ID | Input | Observable outcome |
| --- | --- | --- |
| H1 | 0/1/49/50/51/70 assignments, publications, acks; tied times; full walk | newest 50, correct total and anchors; every row once; no instruction in history; rationale bounded |
| H2 | missing/foreign/wrong-type anchors, including one bad among valid args | named refusal, no data from other task/team, no writes |
| H3 | revision amended between reads; new result supersedes old; handoff/map changes | current identity advances; submission pins stable; new outstanding whole; each whole result sealed by current predicate |
| H4 | new mail/ack/publication after first page | next page strictly older, current total; no promised frozen snapshot |
| H5 | selected result equals outstanding, sealed/unsealed | both fields identical, including redacted comparisons/check outcomes |
| H6 | stored invalid body/diff/summary; BOM/NUL; 1,999/2,000/2,001 and 8,191/8,192/8,193 byte boundaries | exact byte metadata; null for invalid text; diff resume 0 if unreadable; no replacement decoding |
| H7 | task without outstanding result | results contains only bounded rows, selected read still works, total excludes nothing |
| H8 | default/full_messages/result_id/revision through each runtime | same semantics and refusal envelopes, descriptions name full routes and old catalogue limitation |
| H9 | generation 1 and 2 envelopes, unknown version | old bytes/receipt identity preserved; current header parses; unknown refused |

Completeness: G/H tables partition successful reads by section and boundary and refusals by caller, membership, argument type/range and anchor membership. H3–H5 partition inter-call mutations; one call is synchronous and has no internal await. A “foreign valid anchor” is unreachable by definition: foreign membership always refuses. No read creates a durable state machine or recovery boundary. For write-order regressions schedule real existing amend/submit/ack/handoff calls before/after reads; restarting between calls must change no stored rows. Crash-in-read is a read rollback, not a new recovery mechanism.

Properties (no dependencies; use propertyCases for >=50 cases):
- P3/I1: seed 0x5AB7, 200 histories of 0–400 rows with tied times; production windows; every unchanged section pages exactly once in its defined order; outstanding never consumes history capacity. Include all H1 histories. Kill non-strict anchor, missing rowid tie-break, JS-only slicing, duplicate compact derivation.
- P4/I2: seed 0xC0DE, 200 fixtures with valid/refused reads; hash task/revision/message/result/assignment/publication/ack stored bytes before/after, compare humanDetail whole against baseline. Kill writeback or compaction in shared human path.
- P5/I3: seed 0xD1FF, 300 arbitrary 0–40,000 byte diffs with BOM/NUL and invalid edges; actual reader; concatenate base64 exactly, non-null text re-encodes exactly. Kill off-by-one, wrong 2,000-byte threshold or replacement decoding.
- P6/I4: seed 0x5EA1, 200 sequences of amend/submit/handoff/map/read through real services; stored submission pins immutable, default and selected whole results get the same seal. Kill current revision substituted for pin or unsealed resultDetail/check comparison.

### Planned test allocation and scenario coverage

Every scenario in specs/team-tasks/spec.md must get an exact @covers annotation in implementation. Families by requirement: compact subtasks G1/G2/P3; message previews G3–G5/P3/H6; full bodies G5a–c/H8; result rows G9–G9d/P3/H7; selected result G10–G13g/H5; diff reader G13a–f/P5; history compact G14/G15/H1; continuation H1/H2; identities H3/H4/P6; bounds G16/G17; guidance H8/H9. The three modified original bounds scenarios remain covered with their existing titles/updated expectations; preserved small task, journal byte bounds, revision identities, owner and human detail must also retain regression assertions. No scenarios are deferred inside this slice; legacy metric/report scenarios and already-landed revision implementation are outside it.

Planned files: `taskReadWindows.test.ts` for G1–G5c/G9–G15/H1–H7/P3/P4/P6; `taskResultDiffRead.test.ts` for G13a–f/P5; extend `taskJournalTools.test.ts` for H2/H8 through both adapters and real TaskResultService seal; `teamPrompt.test.ts` for guidance; update `codexTeamPath.integration.test.ts` for the exact task_get schema argument list and `teamTaskService.test.ts` for the exact registered task_result_diff_read catalogue; use `teamEnvelope.test.ts` plus the existing `taskEnvelopeCompatibility.test.ts` and `taskEnvelopeV2Compatibility.test.ts` for H9; preserve `taskRevisionWindow.test.ts`, `taskJournalRead.test.ts`, `taskListTools.test.ts`, `taskResultCoverageSeal.test.ts`, `taskGetLedger.test.ts`, `taskResultConnections.test.ts`. Future literal titles must be written before result citation preflight, not cited as if already present.

## Migration and readiness

Owner explicitly reviews breaking shapes, H1 continuation refinement, publication preview, fixture-only size qualification and retained header compatibility before implementation registration. Legacy disposition stays an owner decision. Before any sync/archive, the owner must resolve the archive-order conflict: this delta and `bounded-metrics-and-task-get/specs/team-tasks/spec.md` both MODIFY “task_get bounds its growing lists” and “Agents are told task_get is bounded”. The landed PR #396 revision-row/whole-revision requirements and scenarios still live only in the legacy delta, not the main team-tasks spec. Archiving this slice first would leave main-spec references to revision paging without those defining requirements and stale overlapping legacy MODIFIED blocks. The owner must select a separate spec-reconciliation/archive order that gives the landed revision contract a main-spec home and re-derives the overlapping legacy blocks before either archive proceeds. This proposal does not authorize or perform that reconciliation, edit the legacy change, or reimplement landed revision reads. No schema migration, backfill or held-branch adoption. Rollback returns old projections without rewriting stored rows; already-created new threads may need restart. Before expansion demonstrate a registered task_get/default + one foreign-anchor failure through production composition; then complete both runtime adapters, seal, human WebSocket regression and exact-head full check. No live DB or native campaign required.

## Implementation contract

### Acceptance
- A1: Compact child/message/result/history sections implement G1–G5c, G9–G17 and H1/H2/H6/H7 with SQL limits, exact byte metadata, totals and continuation anchors.
- A2: Explicit whole-message/selected-result/revision/diff routes recover the promised data with G10–G13g and H5/H8; diff bytes round-trip losslessly.
- A3: Guidance names compact sections, every route, exceptions and catalogue limitations; versioned delivered headers preserve old parsing and receipts (H8/H9).
### Invariants
- I1: Unchanged histories page exactly once in their defined order; current task identity and outstanding result remain available (P3).
- I2: Reads never change stored records or the human detail/WebSocket payload, journal/revision/list baseline, or delivery/ack distinction (P4).
- I3: Diff chunks and previews preserve exact stored bytes and valid UTF-8 boundaries, with no implicit lossy decoding (P5).
- I4: Every whole result obeys the existing current blind-first seal; result revision pins never advance with current task revision (P6).
### Scope
- src/server/team/task*.ts
- src/server/team/TaskResultService.ts
- src/server/team/mailboxStore.ts
- src/server/team/assignmentStore.ts
- src/server/team/teamPrompt.ts
- src/shared/teamTasks.ts
- src/server/__tests__/task*.ts
- src/server/__tests__/teamEnvelope.test.ts
- src/server/__tests__/codexTeamPath.integration.test.ts
- src/server/__tests__/teamTaskService.test.ts
- src/server/__tests__/teamPrompt.test.ts
- docs/architecture/tasks.md
- docs/architecture/mailbox.md
### Verification
- V1: Commit every G/H row as automated acceptance and map each scenario/oracle to literal tests and killed mutants; P3–P6 pass fixed seeds and declared cases.
- V2: Both registered tool runtimes exercise success and refusal plus real sealing; human connection and existing revision/journal/list/ledger regressions pass; clean committed full check and result verifier evidence are recorded.
### Excluded
- X1: No metrics/report/drill API, storage migration, held branch adoption, legacy artifact edits, write authorization, client UI or human detail compaction.

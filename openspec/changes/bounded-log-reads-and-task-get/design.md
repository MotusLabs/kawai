# Design

## Context

See proposal.md, Why. The relevant code at base `0bff6f6f`:

- **Collectors.** `collectLogEntryBatch` and `collectLogEntriesForPaths` (`src/server/logPollData.ts`) call `enrichLogEntry` on every selected log and apply `isExcludedChatLog` to its result. The batch collector selects the newest `maxLogs` by mtime first.
- **Other worker content paths.** `buildOrphanEntries` (`src/server/logMatchWorker.ts`) reads head helpers and calls `getLogTokenCount` on DB orphan candidates without any exclusion. `buildLastMessageEntries` adds backfill candidates after the collectors, and `attachLastUserMessage` then reads each entry's last messages. Neither checks exclusion, so a chat transcript once recorded as a session (a contaminated DB row) is read and can reappear in worker output.
- **Token count.** For an unknown log, `getLogTokenCount` (`src/server/logmatch/logText.ts`) reads the whole file with `readFileSync`, slices the decoded string to 204,800 UTF-16 units and 2,000 lines without dropping the partial first line, and, when that tail holds no message text, scans the whole copy from the head. Its zero-token cache is keyed by path and size only.
- **Gates.** `MIN_LOG_TOKENS_FOR_INSERT` is 1. Three gates reject a count below it:
  - `getEntriesNeedingMatch` (`src/server/logMatchGate.ts`, where `-1` means "known session, enrichment skipped");
  - the orphan gate in `buildOrphanEntries`;
  - the insert gate in `logPoller.ts`.

  The worker gates take a `minTokens` that may be 0 (disabled).
- **Poller `emptyLogCache`** (path → size), three sites in `logPoller.ts`:
  - It is checked before the insert gate, and `cachedSize >= size` skips the log unconditionally (818–820).
  - It is written for a log with no session id yet (833–836).
  - It is written for every token rejection (907–909).
- **Reader `zeroTokenLogCache`** in `logText.ts` (path → size) returns 0 for an equal size.
- **Head identity reads.** `parseLogHeadEntries` (`src/server/logDiscovery.ts`) reads 64 KiB, and while the last line is truncated re-reads 256 KiB and then 1 MiB: at most offset 1 MiB, at most 1,344 KiB read per parse. `extractSessionId`, `extractProjectPath`, and `extractSlug` each parse again; `isCodexSubagent` and `isCodexExec` read 64 KiB each. All are bounded independent of file size.
- **Exact matching.** `candidateSearch.ts` runs `rg` over candidate files and progressively expanded tails. It is not changed here.
- **`readLogTail`** drops a complete first line when its offset lands exactly on a line start, and decodes the whole allocation after a short read.
- **`task_get`** (`taskTools.ts` → `TaskService.get` → `taskStore.detail` → `TaskResultService.applySeal`) loads the whole journal (`journal(id)` without a limit), every subtask summary, every message (`mailboxStore.forTask`), and every other section. `taskStore.journal(id, limit)` already has a newest-N window.
- **Tool adapters.** One `teamToolTable` serves both runtimes. The Claude adapter (`createMailboxServer`) validates with the SDK against the Zod shape and returns `isError` text for a handler throw. The Codex adapter (`dispatchTeamToolCall`) answers `Invalid arguments for <tool>: …` for schema failures and `success: false` with the message for a throw. The two envelopes differ.
- **The human's `team-task-detail`** is built by `taskStore.humanDetail` over the unbounded `detail` and is out of scope.
- **Journal text.** `team_task_journal.text` is TEXT. `TaskService.note` accepts embedded NUL today, so existing entries may contain it. SQLite's `length()` of TEXT stops at the first NUL; `length()` of a BLOB counts bytes.

## Goals / Non-Goals

**Goals:**
- The poller's token enrichment reads at most fixed windows of any log, independent of its size, and never uses a whole-file read API.
- No byte of an excluded chat transcript beyond its head identity parse is read by any worker path, and excluded logs never appear in worker output.
- Terminal sessions the current code would match stay eligible for matching. Bounded reads may lose the count, never the eligibility.
- `task_get` hydrates bounded rows for its three growing lists and at most 2,000 journal bytes per entry into JavaScript, with the limits applied in SQL.
- Every byte of every journal entry stays retrievable through a supported agent tool.

**Non-Goals:**
- A whole-response byte bound for `task_get`, or a native SQLite memory bound per entry. No new storage, incremental-blob API, or migration.
- Bounding exact `rg` matching, last-message extraction, head identity parsing, Codex history replay, or mail-receipt reads.
- Shrinking existing rollouts, transcripts, or journal entries. Old entries are append-only evidence and are never rewritten.
- Bounding `task_list`, the human UI, or delivered task-mail headers.
- Changing the memory cgroup, `memory.oom.group`, or suite-run budgets, or stating any RSS threshold.

## Decisions

### D1 — Staged exclusion before every worker content path

**Invariant I-X:** no positively excluded identity survives any collector, worker, backfill, or content path. Being known is never an exclusion bypass.

A single function decides exclusion from three identity observations, read in order and evaluated only until the first hit:
- **F** — the file-name thread id (`rollout-…-<uuid>.jsonl`).
- **R** — the stored record or session id: the known session's id, or an orphan or backfill record's `sessionId`.
- **H** — the head session id from the existing `extractSessionId` parse, keeping the 64 → 256 → 1,024 KiB expansion.

"Hit" means a positively known member of the exclude set, never absence of evidence.

| row | F | R | H | outcome |
|-----|---|---|---|---------|
| X0 | hit | not evaluated | not evaluated | drop; zero identity or content opens |
| X1 | miss | hit | not evaluated | drop; zero identity or content opens |
| X2 | miss | miss or absent | hit | drop after the bounded identity reads only; no token or last-message read; absent from entries, matches, and final attachment |
| X3 | miss | miss or absent | resolved, no hit | not excluded by this rule; existing metadata, orphan, and matching eligibility apply |
| X4 | miss | miss or absent | unresolved within the bounded head | no exclusion inferred; no identity is fabricated and no non-chat proof claimed; known stored metadata is kept; missing or unreadable keeps its existing nonthrowing path |

Each row applies alike to every candidate class:
- new and known logs in both collectors;
- orphan records;
- backfill records;
- the final list before last-message reads.

A known log whose stored id A is not excluded, while its head now names an excluded id B, is X2 for every class.

The check runs:
- in both collectors, after the batch collector's newest-`maxLogs` slice (excluded logs still take slots, as today), before any other helper or token read;
- in `buildOrphanEntries`, before `isCodexSubagent` and the token read;
- in `buildLastMessageEntries`;
- again on the final entry list before `attachLastUserMessage`, so nothing excluded is read or returned.

An absent or empty exclude set disables this filter, while existing metadata eligibility still applies. Unexcluded terminal logs keep their metadata and matching unchanged. Every identity in a file cannot be discovered beyond the bounded metadata head, and none is claimed to be.

*Alternative considered:* recognize rollouts by path prefix (`~/.codex/sessions`). Rejected: terminal Codex sessions also write rollouts there.

### D2 — Bounded token reads through one descriptor

The token reader opens one descriptor and `fstat`s it, recording the generation (device, inode, size, mtime, and change time at the highest available precision). Then it reads, with `readSync` at explicit offsets:
- **Head window:** bytes `[0, min(size, 200 KiB))`.
- **Tail window:** bytes `[max(0, size − 200 KiB), size)`, plus one lookbehind byte at `start − 1` when `start > 0`, so a tail that starts exactly at a line start keeps its first line.
- When the windows overlap or `size ≤ 200 KiB`, the overlapping bytes are read once.

It then `fstat`s again and closes the descriptor in `finally`. The aggregate read is at most 409,601 bytes. No whole-file API (`readFileSync`, streams, `Bun.file`) is used on this path, including for small or growing files.

Only complete lines are decoded and parsed: a line whose start and terminating newline both fall inside a window, or a final unterminated line at the file's end that parses as JSON. Splitting on `\n` is UTF-8 safe. The tail applies the existing 2,000-line limit.

The reader honors the actual `bytesRead`. A short read, or a generation change between the two `fstat`s, makes the evidence `P(n)` (D3). There is no finishing scan for a line that straddles a window.

### D3 — Token evidence, gates, and empty caches

**Invariants:**
- **I-E:** a bounded observation is not a complete count unless its logical coverage and stable generation are proved. Incompleteness overrides a previously observed positive.
- **I-C:** an empty cache stores only a complete, stable zero, never a threshold rejection or missing metadata. A cache hit is evidence evaluated under the current gate, not permission to skip.

**Evidence**, taken after exclusion on an eligible source:
- **K** — the existing known-session evidence, tagged and semantically separate, replacing the `-1` sentinel. It is used only when new enrichment is legitimately skipped. No unknown log is tagged K. A DB orphan record whose path is re-enriched for tokens is not K merely because it is recorded.
- **U** — missing, unreadable, or unusable source. It never throws.
- **C(n)** — a complete, stable observation of the whole logical input for the selected agent, mode, and options, with an exact non-negative count `n`. All of the following must hold:
  - the pre and post `fstat` generations agree;
  - every requested byte is read;
  - the windows cover the whole file without gap or duplicate;
  - every relevant record is accounted for under the declared parser rules, with no discarded partial line or character and no early exit or count truncation (for example a first-message fallback or a hit line limit).

  Reading every byte alone does not certify C. A mode that cannot establish an exact whole-input count never produces C.
- **P(n)** — an incomplete bounded observation. `n ≥ 0` is a lower bound only. It covers a gap between the windows, a short read, a shrink, growth or generation change, a cut giant line, a partial record, and an early exit.

Priority:
1. K, when new enrichment is legitimately skipped.
2. Otherwise U for an unusable source.
3. Otherwise P(n) when any completeness predicate fails.
4. C(n) only when all of them hold.

So a positive observed before a later short read or generation change is P(n), never C(n).

**Token gate rows.** Existing metadata, orphan, window, skip-pattern, and exclusion prerequisites still apply independently. A passing token predicate is not a promise to insert an otherwise ineligible row.

| row | evidence | minimum | token predicate | empty-cache write |
|-----|----------|---------|-----------------|-------------------|
| G0 | U | any | cannot create eligibility; existing unavailable path skips, no insert | none |
| G1 | K | any | existing known behavior | none |
| G2 | P(n) | any | not rejected on this count, whatever n; eligible for matching and poller insert; never marked validated | none |
| G3 | C(n) | ≤ 0 | filter disabled: passes for n = 0 or positive | per admission rule |
| G4 | C(n) | > 0, n ≥ minimum | passes | none |
| G5 | C(0) | > 0 | rejected as proven empty | per admission rule |
| G6 | C(n) | > 0, 0 < n < minimum | rejected as complete below threshold, never called empty | none |

G6 is reachable at a generic minimum of 2 with `C(1)`. It is unreachable at the fixed production insert minimum of 1 with integral counts. If an implementation cannot produce C for an input, G2 applies.

**Cache admission:** only `C(0)` with a valid, stable identity, generation, agent, mode, and options may be stored as empty. Admission does not depend on the threshold. K, U, P, and `C(n > 0)` are never admitted. So a cached true zero rejects at minimum 1 but passes the token predicate at minimum 0. A complete positive rejected at minimum 2 is not cached, and the same unchanged positive passes at minimum 1.

**Cache reuse:**
- Requires the same file identity and generation, plus the same agent, mode, and read options.
- Generation evidence is device, inode, size, and mtime at the highest available stat precision, plus the change time, so a same-size rewrite, a replacement, or a restored mtime is detected.
- Size alone, and `cachedSize >= size`, are never sufficient.
- When the platform or input cannot establish generation validity, the entry is neither cached nor reused; a bounded re-read is the fallback.
- Stat checks are evidence, not an atomic filesystem snapshot or a defense against undetectable ABA or TOCTOU changes.

The worker carries the evidence kind and the generation facts across its boundary; the current snapshot's mtime, size, and bare count are not sufficient alone.

**Source composition:**
- `zeroTokenLogCache` (`logText.ts`) admits only `C(0)` under the reuse key above.
- `logPoller.ts` 818–820: the unconditional size-cache `continue` is removed. After the mandatory exclusion and metadata prerequisites, a valid hit yields `C(0)` evidence for the current gate.
- `logPoller.ts` 833–836: the no-session-id branch never writes the cache. A missing id is not a token-count proof; the log is skipped by metadata policy and reconsidered on later discovery.
- `logPoller.ts` 907–909: the low-token branch admits only `C(0)`, not every token rejection.
- Both worker gates (`getEntriesNeedingMatch` and the orphan gate in `buildOrphanEntries`) and the poller insert gate consume the evidence contract.

*Trade-off:* a large log with no message text in either window is now `P(0)` and stays eligible every poll. It costs one bounded read plus the unchanged matching attempt, and may now be inserted where the old token gate rejected it. An inserted record may have `currentWindow: null`; incomplete token evidence must not cause an empty rejection.

*Alternative considered:* a bounded forward scan that finishes a straddling line up to 16 MiB. Rejected: a valid line over 16 MiB before a short user message still loses the session, and no finite exact-negative scan can tell two logs apart that differ only in an unread middle message.

### D4 — `task_get` bounds its growing lists in SQL

The agent path gets its own service method (`TaskService.agentGet`) with an optional window `{ journalBefore?, journalLimit? }`, returning `AgentTaskDetail`; `TaskService.get` and the human path are unchanged. After the awaited caller and team checks, one synchronous read transaction (no `await` inside) runs, in this order:
1. the anchor check (D5);
2. **journal window:** `SELECT id, author_kind, author_session, created_at, rowid, length(CAST(text AS BLOB)) AS total_bytes, substr(CAST(text AS BLOB), 1, 2000) AS preview … ORDER BY created_at DESC, rowid DESC LIMIT n + 1`;
3. **subtask window:** the newest 100 child rows by `(created_at, rowid)`, then their summaries;
4. **message window:** the newest 50 task messages by `(created_at, rowid)` in `mailboxStore`, any state, as `forTask` selects them;
5. `COUNT(*)` for each of the three lists.

Each list is returned oldest first. No full `detail()`, unlimited `journal()`, or `forTask()` load runs on this path.

**Journal entries** carry:
- `previewBytes` — the preview trimmed back to a complete UTF-8 character, so 1,997–2,000 bytes when cut;
- `text` — the preview's text when it is valid UTF-8, else `null`;
- `totalBytes`;
- `cut` — `totalBytes > 2,000`;
- `resumeOffsetBytes` — the byte offset `task_journal_read` resumes from: `previewBytes`, or `0` when `text` is `null`.

The marker is metadata beside the text, never appended to it.

**Preview partition (I-P).** The readable-preview promise holds only when the established fatal UTF-8 round-trip succeeds. Raw bytes stay recoverable without mutation.
- **T-small:** the raw length is ≤ 2,000 bytes and the complete projection decodes. The preview is whole and readable, not cut, and resumes at its exact byte length.
- **T-invalid:** the projection fails to decode, at any length, including a one-byte historical `FF` entry. The preview has `text: null` and `resumeOffsetBytes: 0`; the raw byte length and `cut` stay honest. `task_journal_read` returns the bytes as authoritative base64. Such an entry is never "small whole".
- **T-large-readable:** the raw length is over 2,000 bytes and the trimmed prefix decodes. The ≤ 2,000-byte prefix is trimmed to a valid boundary, and the resume offset is exact.

This partition introduces no second decoder. Existing NUL, byte-order-mark, multi-byte, and historical rows are never rewritten or banned to satisfy a preview.

**Bounds** carry `journal: { total, returned, olderRemaining, nextBefore }` and `{ total, returned, truncated }` for subtasks and messages.

**Units and residuals:**
- A preview is at most 2,000 raw stored bytes. JSON escaping can expand it up to six times (`\u00XX` per control byte), so at most 12,000 JSON characters per preview plus metadata. That is 600,000 at the default 50 and 2.4 million at 200.
- SQLite still reads each stored value natively to project it; the bound applies to what reaches JavaScript.
- The task, revisions, assignments, publications, acknowledgements, results (with checks, coverage, and the existing blind-first seal applied after), message bodies, and subtask summaries stay whole. So no whole-response bound is claimed.
- The human's `team-task-detail` keeps calling the unbounded `humanDetail`.

*Alternative considered:* slicing the full detail in the handler, or cutting text in a JavaScript function after loading. Rejected: both still hydrate every row and every whole text.

### D5 — Journal paging

The `task_get` Zod schema adds:
- `journal_before`: a non-empty string, optional;
- `journal_limit`: an integer from 1 to 200, optional, default 50. One explicit message naming the range 1–200 covers its minimum, maximum, and integer failures, so both adapters' refusals name the range.

The anchor must be an entry of this task (`SELECT created_at, rowid … WHERE id = ? AND task_id = ?`). Otherwise the call is refused with `Unknown journal entry for this task: <id>`.

The window takes rows strictly older than the anchor: `created_at < a` or `created_at = a AND rowid < r`. `olderRemaining` is true when the `n + 1`-th row exists, and `nextBefore` is then the oldest returned id. `total` is the task's whole entry count.

Paging from the newest window until `olderRemaining` is false returns every entry of a fixed journal exactly once, in `(created_at, rowid)` order. Nothing is promised for an entry appended between calls: one sorting after every returned entry appears in a fresh newest window, but one whose `created_at` falls inside an already-paged range (a backdated insert or a backward clock step) may appear in no window already taken.

### D6 — `task_journal_read`

A new additive, read-only tool takes `{ task_id, entry_id, offset_bytes? }`. `offset_bytes` is a safe non-negative integer, default 0. The service:
1. applies `task_get`'s caller and team rules;
2. verifies that the entry belongs to the task (`Unknown journal entry for this task: <id>` otherwise);
3. runs one statement: `SELECT length(CAST(text AS BLOB)) AS total, substr(CAST(text AS BLOB), ? + 1, 8192) AS chunk`.

Rules:
- An offset beyond `total` is refused, naming the offset and the total.
- An offset equal to `total` returns `{ returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null }`, which also covers an empty entry.
- Otherwise:
  - When the chunk is not the end of the entry, the reader trims at most three trailing bytes that are the valid start of a UTF-8 character cut short. An invalid lead byte (`C0`, `C1`, `F5`–`FF`) or an impossible prefix (`E0 80`, `ED A0`, `F0 80`, `F4 90`, and the like) is not trimmed, so such a chunk is returned whole with `text: null`. The 2,000-byte preview trims the same way, so such a preview is T-invalid.
  - If the remaining bytes decode as valid UTF-8 with a fatal decoder that keeps a byte-order mark, `text` is that string. The NUL character and a byte-order mark are kept, so the UTF-8 encoding of `text` equals the returned bytes.
  - Otherwise the untrimmed chunk is returned with `text: null`.
- `dataBase64` is always authoritative.
- `nextOffsetBytes` is `offset + returnedBytes`, or `null` at the end. Every call before the end returns at least one byte.

The result also carries `entryId`, `offsetBytes`, `totalBytes`, and `returnedBytes`. Concatenating the decoded chunks from offset 0 reproduces the stored bytes exactly, including any suffix after a NUL. A chunk is at most 8,192 raw bytes, which is 10,924 base64 characters.

Stored entries are never rewritten, and new notes are not restricted. No database-copy fallback is needed or authorized.

### D7 — Agent-facing text and sequencing

The following are updated together with D4–D6, in the Lead's integration order after the architecture split:
- the `task_get` and new `task_journal_read` descriptions and registration (`TASK_TOOL_NAMES`, schemas, handlers — one table, so both runtimes get them);
- the task note in `teamPrompt.ts`;
- the delivered header line in `taskContext.ts` that says "task_get has the full journal";
- the task-tools facts in `docs/architecture/tasks.md`, where the architecture split moved the former `AGENTS.md` bullet (no root `AGENTS.md` expansion);
- enumeration tests over the tool names.

The new name must compose with later tool-metrics normalization without an import cycle.

**Task-header generations (C1).** `parseEnvelope` strips a task header by rebuilding it with `formatTaskHeader` and requiring an exact prefix, and the receipt extractors and transcript replay depend on that parse. Changing the journal line would make every task envelope recorded with a non-empty journal unparseable: replay would show it as raw user text, and `reconcileMailbox` would read its receipt as absent and requeue pushed, unreceipted mail. So the header is versioned:
- The envelope metadata gains an additive `taskHeaderVersion`. Absent means the legacy generation 1; generation 2 is the bounded wording. Known values are 1 and 2.
- The legacy renderer keeps the exact old journal literal and every other task-context line. Generation 2 differs only in a fixed journal line naming the bounded `task_get` and `task_journal_read`.
- `formatEnvelope` and `parseEnvelope` pick the renderer from the recorded version, never by trying both or by pattern. A parsed legacy envelope keeps the version absent, so it round-trips unchanged.
- An unknown or non-integer version, or a version on an envelope without a task, does not parse. Metadata, wrapper, handoff, duplicate, and thread checks are not weakened.
- No database migration or transcript rewrite. Older binaries are not claimed to read generation 2 after a downgrade.

Newly delivered task envelopes select generation 2 only in the registration commit below.

**Sequencing.** D1–D3 are the first production path and land first. D4–D7 follow under a later task revision, in two steps:
1. An unwired checkpoint: `taskJournalWindow.ts` (the window and anchor SQL, the entry reader, and the shared exact UTF-8 helper), `TaskStore.agentDetail`, `TaskService.agentGet` and `journalRead`, `mailboxStore.forTaskNewest`, the generic seal, and the shared types, with their store and service tests. No tool, prompt, header, or envelope changes; the live `task_get` is untouched. Legacy envelope fixtures (rows V1–V2) may be added here, but they do not fix C1.
2. One atomic registration commit: the `task_get` arguments, `task_journal_read`, the D7 texts, header generation 2 with its parser, and rows V3–V7. A bounded `task_get` never ships without the lossless reader.

### Acceptance oracles

**WX — exclusion (D1)**, through the real match-worker request handler, over temp logs, with an observer on every file-open and content-read API.

Every row is run for each candidate class:
- a new log in the batch collector (`collectLogEntryBatch`);
- a new log in the paths collector (`collectLogEntriesForPaths`);
- a known log in each collector;
- an orphan record;
- a backfill record.

Each run asserts presence or absence in entries, orphan matches, and the final list read by `attachLastUserMessage`.

| id | stage reached | opens of the file | content reads | in entries, matches, final attachment |
|----|---------------|-------------------|---------------|----------------------------------------|
| X0 | F hit | 0 | none | absent |
| X1 | F miss, R hit | 0 | none | absent |
| X2 | F miss, R miss or absent, H hit | identity parse only (offset ≤ 1 MiB) | no token or last-message read | absent |
| X3 | F miss, R miss or absent, H resolved without hit | as today | as today | present per existing eligibility |
| X4 | F miss, R miss or absent, H unresolved (missing or malformed identity) | identity parse only for a new log | as today | present per existing eligibility; no identity fabricated; known stored metadata kept |

Named witness: a known log, and equally an orphan or backfill record, whose stored id A is not excluded while its head names an excluded id B is X2. No class returns it.

Controls:
- An absent or empty exclude set changes nothing.
- With `maxLogs = k` and excluded logs among the newest k, excluded logs take slots and only unexcluded logs among the newest k appear.
- Unexcluded real Claude and Codex logs keep their metadata and matching.

**WE — token evidence (D2/D3)**, through the token reader with the all-API observer and an independent generator ground truth:

| id | input | evidence |
|----|-------|----------|
| E1 | ≤ 200 KiB, stable full read, every record parsed, message text present | C(n), n the exact count |
| E2 | ≤ 200 KiB, stable full read, every record parsed, no message text | C(0) |
| E3 | > 200 KiB, message text in the tail | P(n ≥ 1) |
| E4 | > 200 KiB, message text in the head only | P(n ≥ 1) |
| E5 | > 200 KiB, no message text in either window | P(0) |
| E6 | short read or generation change, nothing observed | P(0) |
| E7 | a positive observed, then a short read or generation change | P(n), never C(n) |
| E8 | ≤ 200 KiB but a logical gap: the 2,000-line limit reached, an early exit, or an unparseable unterminated final line | P(n) |
| E9 | tail starting exactly at a line start that holds the only message | that line counts; P(n ≥ 1) |
| E10 | missing or unreadable | U |
| E11 | known session, enrichment skipped | K, no content read |

**WG — token gates (D3 rows G0–G6)**, through `getEntriesNeedingMatch`, the orphan gate, and the poller insert gate. Each row asserts the predicate and the state of both empty caches.

| id | evidence, minimum | predicate | both caches afterwards |
|----|-------------------|-----------|------------------------|
| WG0 | U, any | no insert this poll | no entry |
| WG1 | K, any | as today | no entry |
| WG2 | P(0) and P(1), minimum 1 and 2 | eligible, reaches exact matching and insert | no entry |
| WG3 | C(0) and C(1), minimum 0 | passes | C(0): admitted; C(1): no entry |
| WG4 | C(1), minimum 1 | passes | no entry |
| WG5 | C(0), minimum 1 | rejected as empty | admitted |
| WG6 | C(1), minimum 2 (generic) | rejected below threshold | no entry; the same unchanged file then passes at minimum 1 |

G6 has no production-minimum row: at the fixed insert minimum of 1 it is unreachable.

**WC — cache composition**, through the real poller and reader. Each row asserts the cache state itself, independent of a helper's return value.

| id | input | outcome |
|----|-------|---------|
| WC1 | a log with no session id yet and partial or non-empty content | no `emptyLogCache` write; after the id appears (appended content), the log is reconsidered |
| WC2 | a cached C(0), then a same-size rewrite with the mtime restored | the change time differs; re-read, no reuse |
| WC3 | a cached C(0), then a replacement at the same path | the identity differs; re-read |
| WC4 | a cached C(0), read in another mode or with other options | not reused |
| WC5 | a cached C(0) at minimum 0 | the token predicate passes; no unconditional skip |
| WC6 | C(1) rejected at minimum 2, and any P(n) | neither cache holds the path |
| WC7 | generation validity not establishable (test seam) | neither cached nor reused; bounded re-read |

**Old-positive witnesses**, through the real worker and the poller, each generated with bounded writes:
- **O1:** a > 200 KiB first user message and a > 200 KiB echo line. The old count is > 0. Literal and short-trailer forms stay eligible, reach unchanged exact matching, insert, and remain in neither empty cache. Pin the existing outcomes: the literal form has `currentWindow: null`; the trailer form binds the expected window.
- **O2:** small session metadata, a valid > 16 MiB non-message line, a short user message, then a 300 KiB non-message echo. The same must hold.

**`task_get` (D4/D5)**, through both the Claude and the Codex adapters. *Returned* is oldest first. T1 and T16 are the WP preview witnesses (T-small and T-invalid); T8 and T9 are T-large-readable.

| id | input | outcome |
|----|-------|---------|
| T1 | 3 entries each ≤ 2,000 bytes and valid UTF-8 (T-small), 0 subtasks, 1 message | all whole and readable; nothing truncated or cut |
| T2 | 1,198 entries, defaults | newest 50; total 1,198; `olderRemaining`; `nextBefore` = oldest returned |
| T3 | `journal_before` = entry k (k ≥ 100), limit 100 | entries k−100…k−1; `olderRemaining` = (k − 100 > 0) |
| T4 | `journal_before` = entry 30, limit 100 | entries 0…29; `olderRemaining` false; `nextBefore` null |
| T5 | another task's entry id | refused naming the id, in each adapter's envelope |
| T6 | limit 0, 201, or 1.5 | refused naming 1–200, in each adapter's envelope |
| T7 | unknown id | refused naming the id, in each adapter's envelope |
| T8 | a 5,000-byte ASCII entry | 2,000-byte preview; `cut`; `totalBytes` 5,000; `resumeOffsetBytes` 2,000 |
| T9 | a 4-byte character straddling byte 2,000 | preview ends before it; `resumeOffsetBytes` = `previewBytes` |
| T10 | invalid UTF-8 within the first 2,000 bytes of a longer entry (T-invalid) | `text` null; `resumeOffsetBytes` 0 |
| T11 | 149 subtasks, 60 messages | newest 100 and 50; totals; truncated |
| T12 | limit 1, limit 200, empty journal | exact windows; empty gives `[]`, total 0, no older |
| T13 | entries sharing `created_at` | order by `rowid`; no duplicates across pages |
| T14 | > 50 results and revisions; an outstanding review handoff | all whole; the seal projection unchanged |
| T15 | the human detail of T2's task | the whole journal, subtasks, and messages |
| T16 | a one-byte `FF` entry beside a valid small entry (T-invalid) | `FF`: `text` null, `resumeOffsetBytes` 0, `totalBytes` 1, not cut; `task_journal_read` returns its byte exactly; the valid sibling stays whole |

**`task_journal_read` (D6)**, through both adapters:

| id | input | outcome |
|----|-------|---------|
| R1 | 20,000-byte ASCII entry, offset 0 | 8,192 bytes; exact text; next 8,192 |
| R2 | a multi-byte character straddling the chunk end | trimmed before it; next = offset + returned |
| R3 | offset = total; an empty entry at 0 | 0 bytes, `''`, `''`, next null |
| R4 | offset > total | refused naming offset and total |
| R5 | offset negative, fractional, or > `MAX_SAFE_INTEGER` | refused by the schema |
| R6 | another task's entry, unknown id | refused naming the id |
| R7 | `"a\u0000SUFFIX…"` | `totalBytes` counts every byte; reconstruction includes the suffix |
| R8 | leading byte-order mark | `text` keeps U+FEFF |
| R9 | invalid UTF-8, or an offset inside a character | `text` null; base64 of the raw bytes; ≥ 1 byte |
| R10 | a caller from another team | refused as not found, as `task_get` |

**Delivered task headers (D7 C1)**, through the real `parseEnvelope`, the Claude and Codex receipt extractors, transcript replay, and `reconcileMailbox`'s receipt path. Legacy fixtures are raw envelopes in the format of base `567ec21e`, frozen as literal bytes with independently written expected ids and bodies, never produced by a renderer under test. Synthetic data only.

| id | input | outcome |
|----|-------|---------|
| V1 | a legacy task envelope with a non-empty journal, no version | parses; the body is the peer content; both receipt extractors find its id; replay yields a peer message, not raw user text; reconcile completes it as delivered and never requeues it |
| V2 | legacy controls: an empty-journal task envelope, a no-task envelope | parse unchanged |
| V3 | explicit version 1, and an absent version | the legacy renderer round-trips; absence stays absent |
| V4 | a current task envelope | carries version 2 and the generation 2 header; round-trips |
| V5 | version 2 metadata with the legacy header, or version 1 or absent with the generation 2 header | does not parse |
| V6 | version 3, 1.5, `"2"`, or a version without a task | does not parse |
| V7 | a tampered header, an ordinary tag mention; plan, execution, handoff, revision notice, possible duplicate | tampering and mentions do not parse; the other fields survive both generations |

**Properties:**
- **P1, bounded token reads.**
  - Generator: seed `0x6b617761`, 200 cases. Valid JSONL is written in chunks (never a whole-file string), up to 64 MiB, with message lines at random offsets and separately generated giant lines. A sparse 1 MiB / 1 GiB pair with equal head and tail is also used, for size independence only.
  - Seam: an observer over every content API.
  - Properties:
    - bytes read ≤ 409,601;
    - no whole-file API is called;
    - the evidence equals a reference classification of the two windows;
    - the sparse pair yields equal reads and equal evidence.
- **P2, eligibility preserved.** Over P1's cases, whenever the generator placed message text anywhere in the file, the evidence is `C(n > 0)` or `P(n)`, never `C(0)`, and the gates at minimum 1 keep the log eligible.
- **P3, lossless paging.** Seed `0x7461736b`, 200 cases. Journals of 0–600 entries, some sharing a `created_at`, paged with random limits from 1 to 200 until `olderRemaining` is false, yield every id exactly once in store order. Seam: an in-memory `schemaDb()`.
- **P4, lossless entries.** Seed `0x6a726e6c`, 200 cases. Entries of 0–40,000 bytes with NUL, byte-order marks, emoji, CJK, and invalid bytes, read from random start offsets:
  - every call before the end returns 1–8,192 bytes;
  - the chunks from offset 0 concatenate to the stored bytes exactly;
  - every non-null `text` encodes to its chunk's bytes.

**Planned mutants (at most five):**
- **M1:** exclusion moved back after enrichment. X0 and X1 open the file, and X2 (including the known A / head B witness) reads tokens or appears in output.
- **M2:** a whole-file read restored in the token reader. The P1 observer fails.
- **M3:** `P(n)` classified as `C(n)` or admitted to an empty cache. O1, O2, E7, WG2, WC6, and P2 fail.
- **M4:** the `task_get` windows taken from a full `detail()`/`forTask()` load. The query observer sees one of the three list statements (journal, subtasks, messages) without its limit or returning more rows than the limit plus one, or an unlimited `journal()`, `detail()`, or `forTask()` load during the agent call. The participant summary query, contractually whole, and the human detail are outside its scope.
- **M5:** the whole entry text projected and cut in JavaScript. The observer sees a journal-window preview column over 2,000 raw bytes, before any JavaScript trim. Results, revisions, and message bodies stay whole and are outside its scope.

The query observer is a test-side wrapper over `prepare` that records each executed statement, its returned rows before projection, and the byte size of each returned column. It shows what reaches JavaScript, not native SQLite memory.

## Risks / Trade-offs

- **[Agents that relied on the full journal]** → Totals, `olderRemaining`, and the cut metadata make the gap visible. `task_journal_read` returns every byte, and the prompt, descriptions, and header name both.
- **[Large message-free logs stay eligible]** → Accepted in D3. A bounded token read and the unchanged matching and insertion paths per poll; window binding may remain unknown.
- **[Native SQLite reads whole values]** → Accepted. Previews and chunks bound JavaScript hydration and the response, not SQLite's per-value work. A true per-entry native bound would need new storage, which is out of scope.
- **[Whole sections can still be large]** → Accepted and stated: results, revisions, assignments, message bodies, and subtask summaries stay whole.
- **[Concurrent journal appends while paging]** → `journal_before` anchors on an entry id, so new entries never shift an older page. An entry stamped after every returned one appears in a fresh newest window; a backdated one may appear in none (D5).
- **[Envelopes recorded before the header change]** → The header is versioned (D7, C1); legacy envelopes keep parsing and their receipts stay found.
- **[Existing huge rollouts still load on attach or replay]** → A non-goal here. Bounded by user action, not by a timer.

## Migration Plan

- No schema migration. Deploy is the usual build swap.
- Rollback restores whole reads. That is safe but reintroduces the memory risk.
- After deploy, live Leads should start fresh Codex chats, so their oversized rollouts stop growing the attach and replay cost.

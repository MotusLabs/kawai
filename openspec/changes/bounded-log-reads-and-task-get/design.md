# Design

## Context

See proposal.md, Why. The relevant code at base `0bff6f6f`:

- **Collectors.** `collectLogEntryBatch` and `collectLogEntriesForPaths` (`src/server/logPollData.ts`) call `enrichLogEntry` on every selected log and apply `isExcludedChatLog` to its result. The batch collector selects the newest `maxLogs` by mtime first.
- **Other worker content paths.** `buildOrphanEntries` (`src/server/logMatchWorker.ts`) reads head helpers and calls `getLogTokenCount` on DB orphan candidates without any exclusion. `buildLastMessageEntries` adds backfill candidates after the collectors, and `attachLastUserMessage` then reads each entry's last messages. Neither checks exclusion, so a chat transcript once recorded as a session (a contaminated DB row) is read and can reappear in worker output.
- **Token count.** For an unknown log, `getLogTokenCount` (`src/server/logmatch/logText.ts`) reads the whole file with `readFileSync`, slices the decoded string to 204,800 UTF-16 units and 2,000 lines without dropping the partial first line, and, when that tail holds no message text, scans the whole copy from the head. Its zero-token cache is keyed by path and size only.
- **Gates.** `MIN_LOG_TOKENS_FOR_INSERT` is 1. Three gates reject a count below it: `getEntriesNeedingMatch` (`src/server/logMatchGate.ts`, where `-1` means "known session, enrichment skipped"), the orphan gate in `buildOrphanEntries`, and the insert gate in `logPoller.ts`, which also stores the log in `emptyLogCache`.
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

### D1 — One exclusion check before every worker content path

A single function decides exclusion from identity facts, in this order:
1. **File-name thread id** (`rollout-…-<uuid>.jsonl`). A hit drops the log with zero opens.
2. **Known or candidate record id** (the known session's id, or an orphan/backfill record's `sessionId`). A hit drops the log with zero opens.
3. **Head session id** from the existing `extractSessionId` parse (64 → 256 → 1,024 KiB expansion kept). A hit drops the log before any other helper or token read.

It runs:
- in both collectors, after the batch collector's newest-`maxLogs` slice (excluded logs still take slots, as today);
- in `buildOrphanEntries` before `isCodexSubagent` and the token read;
- in `buildLastMessageEntries`, and again on the final entry list before `attachLastUserMessage`, so nothing excluded is read or returned.

An absent or empty exclude set leaves every path as today. Unexcluded terminal logs keep their metadata and matching unchanged.

*Alternative considered:* recognize rollouts by path prefix (`~/.codex/sessions`). Rejected: terminal Codex sessions also write rollouts there.

### D2 — Bounded token reads through one descriptor

The token reader opens one descriptor and `fstat`s it, recording the generation (device, inode, size, mtime). Then it reads, with `readSync` at explicit offsets:
- **Head window:** bytes `[0, min(size, 200 KiB))`.
- **Tail window:** bytes `[max(0, size − 200 KiB), size)`, plus one lookbehind byte at `start − 1` when `start > 0`, so a tail that starts exactly at a line start keeps its first line.
- When the windows overlap or `size ≤ 200 KiB`, the overlapping bytes are read once.

It then `fstat`s again and closes the descriptor in `finally`. The aggregate read is at most 409,601 bytes. No whole-file API (`readFileSync`, streams, `Bun.file`) is used on this path, including for small or growing files.

Only complete lines are decoded and parsed: a line whose start and terminating newline both fall inside a window, or a final unterminated line at the file's end that parses as JSON. Splitting on `\n` is UTF-8 safe. The tail applies the existing 2,000-line limit.

The reader honors the actual `bytesRead`. A short read, or a generation change between the two `fstat`s, makes the read incomplete. There is no finishing scan for a line that straddles a window.

### D3 — Token evidence and gates

The reader returns one of:
- **`positive(n)`** — some complete line in a window has message text. `n` counts the tail's message text, or else the head's first message. It is a lower bound, not an exact whole-file count.
- **`empty`** (proven empty) — no message text, the head window covered the whole file (`size ≤ 200 KiB`), the read was full, and the generation did not change.
- **`incomplete`** — no message text was observed, but the windows did not cover the whole file, or the read was short, or the file changed.
- **`unavailable`** — stat, open, or read failed (missing or unreadable). It never throws.

A known session keeps a separately named `known` evidence, replacing the `-1` sentinel, which is never used for an unknown log.

The gates (`getEntriesNeedingMatch`, the orphan gate, and the insert gate) reject on token grounds only when the evidence is complete and below the minimum: `empty`, or a `positive(n)` from a wholly covered file with `n < minTokens`.
- `incomplete` evidence stays eligible and reaches the existing exact matching. If that matching inserts it, the insert proceeds as for a positive log.
- `unavailable` evidence is not inserted this poll, as today, and is not cached.
- Only `empty` evidence enters the reader's cache or the poller's `emptyLogCache`. The cache key is device, inode, size, mtime, text mode, and read options, so a same-size edit, a replacement, or another mode re-reads.

*Trade-off:* a large log with no message text in either window is now `incomplete` and stays eligible every poll. It costs one bounded read per poll plus an exact-matching attempt, and may now be inserted when `rg` matches it, where the old code rejected it. This is accepted in exchange for never losing a real terminal session to a bounded read.

*Alternative considered:* a bounded forward scan that finishes a straddling line up to 16 MiB. Rejected: a valid line over 16 MiB before a short user message still loses the session, and no finite exact-negative scan can tell two logs apart that differ only in an unread middle message.

### D4 — `task_get` bounds its growing lists in SQL

`TaskService.get` gains an optional window `{ journalBefore?, journalLimit? }` for the agent path and returns `AgentTaskDetail`. One synchronous read transaction (no `await` inside) runs, in this order:
1. the anchor check (D5);
2. **journal window:** `SELECT id, author_kind, author_session, created_at, rowid, length(CAST(text AS BLOB)) AS total_bytes, substr(CAST(text AS BLOB), 1, 2000) AS preview … ORDER BY created_at DESC, rowid DESC LIMIT n + 1`;
3. **subtask window:** the newest 100 child rows by `(created_at, rowid)`, then their summaries;
4. **message window:** the newest 50 task messages by `(created_at, rowid)` in `mailboxStore`;
5. `COUNT(*)` for each of the three lists.

Each list is returned oldest first. No full `detail()`, unlimited `journal()`, or `forTask()` load runs on this path.

**Journal entries** carry:
- `previewBytes` — the preview trimmed back to a complete UTF-8 character, so 1,997–2,000 bytes when cut;
- `text` — the preview's text when it is valid UTF-8, else `null`;
- `totalBytes`;
- `cut`;
- `resumeOffsetBytes` — the byte offset `task_journal_read` resumes from: `previewBytes`, or `0` when `text` is `null`.

The marker is metadata beside the text, never appended to it.

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
- `journal_limit`: an integer from 1 to 200, optional, default 50.

The anchor must be an entry of this task (`SELECT created_at, rowid … WHERE id = ? AND task_id = ?`). Otherwise the call is refused with `Unknown journal entry for this task: <id>`.

The window takes rows strictly older than the anchor: `created_at < a` or `created_at = a AND rowid < r`. `olderRemaining` is true when the `n + 1`-th row exists, and `nextBefore` is then the oldest returned id. `total` is the task's whole entry count.

Paging from the newest window until `olderRemaining` is false returns every entry of a fixed journal exactly once. Entries appended between calls appear in a fresh newest window and are never promised to an older page.

### D6 — `task_journal_read`

A new additive, read-only tool takes `{ task_id, entry_id, offset_bytes? }`. `offset_bytes` is a safe non-negative integer, default 0. The service:
1. applies `task_get`'s caller and team rules;
2. verifies that the entry belongs to the task (`Unknown journal entry for this task: <id>` otherwise);
3. runs one statement: `SELECT length(CAST(text AS BLOB)) AS total, substr(CAST(text AS BLOB), ? + 1, 8192) AS chunk`.

Rules:
- An offset beyond `total` is refused, naming the offset and the total.
- An offset equal to `total` returns `{ returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null }`, which also covers an empty entry.
- Otherwise:
  - When the chunk is not the end of the entry, the reader trims at most three trailing bytes that begin an incomplete UTF-8 character.
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
- the task-tools bullet in `AGENTS.md`;
- enumeration tests over the tool names.

The new name must compose with later tool-metrics normalization without an import cycle.

D1–D3 are the first production path and land first. D4–D7 follow under a later task revision.

### Acceptance oracles

**Exclusion (D1)**, through the real match-worker request handler, over temp logs, with an observer on every file-open and content-read API. *Path* is batch (`collectLogEntryBatch`), paths (`collectLogEntriesForPaths`), orphan, or backfill. *Opens* counts opens of that file.

| id | path | file-name id excluded | known/record id excluded | head id excluded | opens | in output |
|----|------|-----------------------|--------------------------|------------------|-------|-----------|
| X1 | batch, paths | yes | * | * | 0 | no |
| X2 | batch, paths (unknown) | no | — | yes | head identity parse only (offset ≤ 1 MiB) | no |
| X3 | batch, paths (unknown, session id and agent type present, not subagent) | no | — | no | head parses + token windows | yes |
| X4 | batch, paths (known) | no | no | * | no token read | yes, `known` evidence |
| X5 | batch, paths (known) | yes | * | * | 0 | no |
| X6 | batch, paths (known) | no | yes | * | 0 | no |
| X7 | orphan | yes, or record id yes | | * | 0 | not in orphan entries or matches |
| X8 | backfill | yes, or record id yes | | * | 0 | not in entries; no last-message read |
| X9 | any | exclude set absent or empty | | | as today | as today |
| X10 | batch, `maxLogs = k` with excluded logs among the newest k | | | | excluded take slots | unexcluded among newest k only |
| X11 | batch, paths (unknown, no or malformed identity) | no | — | — | head parses only, no token read | yes, `sessionId` null |
| X12 | orphan, backfill (not excluded) | no | no | no | as today | as today |

Unreachable: none. X5/X6 are the contaminated chat-row cases and must stay excluded.

**Token evidence (D2/D3)**, through the token reader with the all-API observer:

| id | file | stable full read | message text in a complete window line | evidence | cached empty |
|----|------|------------------|----------------------------------------|----------|--------------|
| E1 | ≤ 200 KiB | yes | yes | positive | no |
| E2 | ≤ 200 KiB | yes | no | empty | yes |
| E3 | > 200 KiB | yes | in tail | positive | no |
| E4 | > 200 KiB | yes | head only | positive | no |
| E5 | > 200 KiB | yes | no | incomplete | no |
| E6 | * | no (short read or generation change) | no | incomplete | no |
| E7 | missing or unreadable | — | — | unavailable | no |
| E8 | cached empty, same device/inode/size/mtime/mode/options | — | — | empty with no content read; any key part differing re-reads | — |
| E9 | tail start exactly at a line start | yes | only on that first tail line | positive | no |

**Gates (D3)**, through `getEntriesNeedingMatch`, the orphan gate, and the poller's insert gate:

| id | evidence | outcome |
|----|----------|---------|
| G1 | positive, n ≥ minTokens | eligible |
| G2 | empty, or positive below minTokens over a wholly covered file | rejected; insert gate caches empty |
| G3 | incomplete | eligible; never cached |
| G4 | unavailable | not inserted this poll; not cached |
| G5 | known | as today |

**Old-positive witnesses**, through the real worker and the poller, each generated with bounded writes:
- **O1:** a > 200 KiB first user message and a > 200 KiB echo line. The old count is > 0. The log must stay eligible and be inserted on an exact match.
- **O2:** small session metadata, a valid > 16 MiB non-message line, a short user message, then a 300 KiB non-message echo. The same must hold.

**`task_get` (D4/D5)**, through both the Claude and the Codex adapters. *Returned* is oldest first.

| id | input | outcome |
|----|-------|---------|
| T1 | 3 entries each ≤ 2,000 bytes, 0 subtasks, 1 message | all whole; nothing truncated or cut |
| T2 | 1,198 entries, defaults | newest 50; total 1,198; `olderRemaining`; `nextBefore` = oldest returned |
| T3 | `journal_before` = entry k (k ≥ 100), limit 100 | entries k−100…k−1; `olderRemaining` = (k − 100 > 0) |
| T4 | `journal_before` = entry 30, limit 100 | entries 0…29; `olderRemaining` false; `nextBefore` null |
| T5 | another task's entry id | refused naming the id, in each adapter's envelope |
| T6 | limit 0, 201, or 1.5 | refused naming 1–200, in each adapter's envelope |
| T7 | unknown id | refused naming the id, in each adapter's envelope |
| T8 | a 5,000-byte ASCII entry | 2,000-byte preview; `cut`; `totalBytes` 5,000; `resumeOffsetBytes` 2,000 |
| T9 | a 4-byte character straddling byte 2,000 | preview ends before it; `resumeOffsetBytes` = `previewBytes` |
| T10 | invalid UTF-8 within the first 2,000 bytes | `text` null; `resumeOffsetBytes` 0 |
| T11 | 149 subtasks, 60 messages | newest 100 and 50; totals; truncated |
| T12 | limit 1, limit 200, empty journal | exact windows; empty gives `[]`, total 0, no older |
| T13 | entries sharing `created_at` | order by `rowid`; no duplicates across pages |
| T14 | > 50 results and revisions; an outstanding review handoff | all whole; the seal projection unchanged |
| T15 | the human detail of T2's task | the whole journal, subtasks, and messages |

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

**Properties:**
- **P1, bounded token reads.**
  - Generator: seed `0x6b617761`, 200 cases. Valid JSONL is written in chunks (never a whole-file string), up to 64 MiB, with message lines at random offsets and separately generated giant lines. A sparse 1 MiB / 1 GiB pair with equal head and tail is also used, for size independence only.
  - Seam: an observer over every content API.
  - Properties:
    - bytes read ≤ 409,601;
    - no whole-file API is called;
    - the evidence equals a reference classification of the two windows;
    - the sparse pair yields equal reads and equal evidence.
- **P2, eligibility preserved.** Over P1's cases, whenever the generator placed message text anywhere in the file, the evidence is `positive` or `incomplete`, never `empty`, and the gates keep the log eligible.
- **P3, lossless paging.** Seed `0x7461736b`, 200 cases. Journals of 0–600 entries, some sharing a `created_at`, paged with random limits from 1 to 200 until `olderRemaining` is false, yield every id exactly once in store order. Seam: an in-memory `schemaDb()`.
- **P4, lossless entries.** Seed `0x6a726e6c`, 200 cases. Entries of 0–40,000 bytes with NUL, byte-order marks, emoji, CJK, and invalid bytes, read from random start offsets:
  - every call before the end returns 1–8,192 bytes;
  - the chunks from offset 0 concatenate to the stored bytes exactly;
  - every non-null `text` encodes to its chunk's bytes.

**Planned mutants (at most five):**
- **M1:** exclusion moved back after enrichment. X1, X2, and X6 read past the head.
- **M2:** a whole-file read restored in the token reader. The P1 observer fails.
- **M3:** `incomplete` classified or cached as `empty`. O1, O2, G3, and P2 fail.
- **M4:** the `task_get` windows taken from a full `detail()`/`forTask()` load. The query observer sees an unlimited statement, or more rows than the limit plus one.
- **M5:** the whole entry text projected and cut in JavaScript. The observer sees a journal text value over 2,000 bytes.

The query observer is a test-side wrapper over `prepare` that records each executed statement and the byte size of each returned column. It shows what reaches JavaScript, not native SQLite memory.

## Risks / Trade-offs

- **[Agents that relied on the full journal]** → Totals, `olderRemaining`, and the cut metadata make the gap visible. `task_journal_read` returns every byte, and the prompt, descriptions, and header name both.
- **[Large message-free logs stay eligible]** → Accepted in D3. A bounded read and an exact-matching attempt per poll, and a possible insert on an exact match.
- **[Native SQLite reads whole values]** → Accepted. Previews and chunks bound JavaScript hydration and the response, not SQLite's per-value work. A true per-entry native bound would need new storage, which is out of scope.
- **[Whole sections can still be large]** → Accepted and stated: results, revisions, assignments, message bodies, and subtask summaries stay whole.
- **[Concurrent journal appends while paging]** → `journal_before` anchors on an entry id, so new entries never shift an older page; they appear in a fresh newest window.
- **[Existing huge rollouts still load on attach or replay]** → A non-goal here. Bounded by user action, not by a timer.

## Migration Plan

- No schema migration. Deploy is the usual build swap.
- Rollback restores whole reads. That is safe but reintroduces the memory risk.
- After deploy, live Leads should start fresh Codex chats, so their oversized rollouts stop growing the attach and replay cost.

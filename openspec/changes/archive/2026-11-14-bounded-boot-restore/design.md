# Design

## Context

See proposal.md, Why. Boot restore (`ChatSessionManager.restorePersisted`)
runs `restoreRow` for every `chat_sessions` row. Before this change, each
row called `findTranscriptPathAsync`, which walks
`<CLAUDE_CONFIG_DIR>/projects` to depth 3, and then
`readTranscriptMetaAsync`, which reads the file into one string and runs
`parseTranscriptContent` over every line. Two facts were wanted:

- `title`: the last `custom-title` row if any exists (a user-set title is
  terminal), else the last `ai-title`.
- `cwd`: the last non-empty `cwd`, or `attachment.snapshot.workingDirectory`,
  of a valid object record that is not `isMeta`, not `isSidechain`, and not
  a title row.

The async-transcript-parsing change (archived 2026-10-12) moved this work off
the synchronous path but kept both costs per row. Separately,
`startBlocker` calls the synchronous `findTranscriptPath` for each live
candidate on every mailbox pass.

Measured on the 2026-10-28 workspace:

| Item | Value |
|---|---|
| Persisted chat rows | 589 (12 live, 577 archived) |
| Projects tree | 920 directories, 750 `*.jsonl` files, 3.1 GB |
| Largest transcript | 552 MB |
| Stall per boot | 15–20 min |
| Peak RSS | up to 10 GB |

## Goals / Non-Goals

**Goals:**

- Boot restore costs one directory walk. The event loop never blocks for
  longer than one chunk's work, and memory stays bounded by the chunk size
  and the longest cwd-candidate line, not by the file.
- The title and cwd are exactly what the full parse gives, for any
  transcript.
- Live rows keep their current guarantee: their facts are adopted before
  `whenRestored()` resolves.

**Non-Goals:**

- Transcript replay for attach, search, history pages, and mail receipts:
  these still parse whole files when a chat is opened.
- The log poller's reads (see the active `bounded-log-reads-and-task-get`
  change).
- Persisting a title/cwd cache across restarts.
- Pruning old transcripts.

## Decisions

### D1 — One index walk per boot

`indexTranscripts(root)` (`transcriptLocator.ts`) walks the tree once,
asynchronously, with the same depth limit as `findTranscriptPath`. It maps
`<sdk id>.jsonl` to a path, and it stats only file names it finds more than
once. Rule for duplicates: the newest mtime wins; on a tie, the copy found
first stays. That is the rule `findTranscriptPath` applies, so the index
gives the same answer for every id (table L). `restorePersisted` builds the
index at the first row that has an SDK id, not before the loop. Rows ahead
of that point, and tests that read the registry right after construction,
still register synchronously.

*Alternatives:*

- Keep a lookup per row with a memoized directory listing. That still costs
  a stat per lookup and is more code.
- Derive the project directory from the row's `projectPath`. Subagent
  layouts and moved worktrees break that mapping.

### D2 — Streaming meta scan instead of a full parse

`scanTranscriptMeta(file)` (`transcriptMeta.ts`) reads the file in 1 MiB
chunks and splits each chunk on `\n`.

- A line containing `"ai-title"` or `"custom-title"` is decoded and passed to
  `parseTranscriptTitleLine`. A row that parses as a title applies the title
  precedence and then is not a cwd candidate.
- A line containing `"cwd"` or `"workingDirectory"` is recorded as a byte
  range.
- No other line is decoded.
- After the scan, candidates are re-read newest first. Each is JSON-parsed
  and filtered by the full parse's rules (an object, not meta, not
  sidechain). `recordCwd` then extracts the cwd; it is the same function the
  full parse now calls. The first hit wins.
- The partial line at the end of a chunk is copied, because the read buffer
  is reused.
- An unreadable file answers `{ title: null, cwd: null }`, as the old path
  did.

*Alternatives:*

- Read the file backwards for the cwd. Titles still need a forward pass,
  because a manual title anywhere is terminal, and backward line splitting
  doubles the boundary cases.
- Use a worker thread. That moves the gigabytes off the event loop but does
  not reduce them.

### D3 — Archived rows catch up after restore

`restoreRow(row, index, catchUp)` scans only when `catchUp` is true, which is
the case for non-archived rows. Archived rows register with their stored
name and path. After the loop, `catchUpArchived` processes them one
transcript at a time. It skips a row whose record object is no longer the
one that was registered: `applyPatch` replaces the object on every change,
so a rename, restore, kill, or status change all count. Its writes go
through `applyTranscriptTitle` and `applyPatch`, the same paths live updates
use, so `nameSource: 'manual'` protects user-set names. The pass stops at
shutdown, and a failure is logged as `chat_archived_catch_up_failed`.

*Alternative:* skip archived rows entirely. Rejected, because an archived
chat's title would then stay a placeholder until it is restored, which
contradicts "A generated title replaces a placeholder name".

### D4 — A path cache for the start blocker

`TranscriptPathCache.existing(id)` returns a remembered path while
`existsSync` holds for it. Otherwise it walks once with
`findTranscriptPath` and remembers what it finds. A miss is never cached.
Boot seeds the cache from the index (`remember`). The check only asks
whether *a* transcript exists, so reusing a copy that is not the newest
cannot change its answer.

## Acceptance oracles

All tables are observable results of the public functions, or of a real
`ChatSessionManager` over a real database and a temporary
`CLAUDE_CONFIG_DIR` (hazard M1: no hand-built harness).

### Table T — title (`scanTranscriptMeta(f).title`, equal to `parseTranscriptContent(c).title`)

| id | manual title rows | auto title rows | result |
|---|---|---|---|
| T1 | none | none | `null` |
| T2 | none | ≥1 | last auto row, `source: 'auto'` |
| T3 | ≥1 | * (before or after) | last manual row, `source: 'manual'` |
| T4 | a row with marker text only in a message body | * | that row is not a title; result as T1–T3 over the real title rows |
| T5 | a title row starting within 10 bytes before a chunk boundary | * | read whole; result as T1–T3 |

### Table C — cwd (`scanTranscriptMeta(f).cwd`, equal to `parseTranscriptContent(c).cwd`)

Each line is either a candidate or not. The result is the newest candidate,
or `null` when there is none.

| id | line | candidate? |
|---|---|---|
| C1 | object, not meta, not sidechain, non-empty `cwd` | yes |
| C2 | object with `attachment.snapshot.workingDirectory` | yes |
| C3 | `isMeta: true` | no |
| C4 | `isSidechain: true` | no |
| C5 | torn JSON, or valid JSON that is not an object (`[1,2]`) | no |
| C6 | marker text only in a message body, no cwd field | no |
| C7 | a line split across a chunk boundary, or a final line without `\n` | as C1–C6 for the whole line |
| C8 | `\r\n` line endings, multibyte text | as C1–C6 |

Unreachable: a title row cannot be a candidate. The scan returns before the
cwd check for any line that parses as a title, and the full parse excludes
title rows.

| id | file | result |
|---|---|---|
| C9 | missing, or a directory | `{ title: null, cwd: null }` |

### Table L — index (`indexTranscripts().get(name)`, equal to `findTranscriptPath(id)`)

| id | copies of `<id>.jsonl` | result |
|---|---|---|
| L1 | one, at depth ≤ 3 (including `<sdk>/subagents/`) | that path |
| L2 | several with different mtimes, newest in either walk order | the newest |
| L3 | several with the same mtime | the first found in walk order |
| L4 | only below depth 3 | absent (`null`) |
| L5 | a non-`.jsonl` file | absent |
| L6 | no projects root | empty index |

### Table K — start-blocker cache (`TranscriptPathCache.existing`)

| id | remembered | remembered exists | walk finds | result | walks |
|---|---|---|---|---|---|
| K1 | yes | yes | * | remembered path | 0 |
| K2 | yes | no | P | P, now remembered | 1 |
| K3 | no | — | nothing | `null`, nothing remembered | 1 per call |
| K4 | no | — | P (after K3) | P, now remembered | 1 |

### Table B — boot restore (real manager)

| id | row | transcript | observable result |
|---|---|---|---|
| B1 | live, auto name | newer title + cwd | both adopted before `whenRestored()`; cwd persisted |
| B2 | archived, auto name | newer title + cwd | listed at `whenRestored()` with the stored name; later the newer title and cwd; cwd persisted; still archived |
| B3 | live or archived, manual name | generated title | name unchanged after both passes; cwd still adopted |
| B4 | archived, changed before its catch-up (renamed, restored) | newer title + cwd | the catch-up writes nothing for it |
| B5 | live, path known from the index | — | start-blocker checks read no directory; after deletion the check reports "transcript is missing" |
| B6 | any, no SDK id or not indexed | — | registers with stored values; no scan |

### Properties

- **P1 — scan parity.** For any transcript content,
  `scanTranscriptMeta(write(c))` equals
  `{ title, cwd } of parseTranscriptContent(c)`.
  - Generator: 1–40 lines drawn from twelve pieces (cwd users, meta,
    sidechain, attachments, both title kinds, marker text in bodies, torn
    JSON, arrays, blank lines, 10 B or 300 KB bodies), joined by `\n` or
    `\r\n`.
  - Seams: the real file system.
  - Seed `0x5eed`, 60 cases.
- **P2 — index parity.** For any generated projects tree, every id's
  `indexTranscripts().get` equals `findTranscriptPath`.
  - Generator: up to 30 files over 1–4 levels, names drawn from 6 ids, mtimes
    from 3 values (ties included), plus non-jsonl files.
  - Seams: the real file system under a temporary `CLAUDE_CONFIG_DIR`.
  - Seed `0x1de5`, 40 cases.

### Evidence outside the suite

Recorded 2026-10-28 against a copy of the live database and the real
projects tree. These are not repeatable in CI.

| Measure | Result |
|---|---|
| Index of 750 files | 19 ms |
| Scan of 555 indexed rows | 4.5 s |
| Peak RSS | 105 MB |
| Longest event-loop stall | 11 ms |
| Parity on real transcripts | identical title and cwd on 749 of 749 (the 552 MB file skipped) |

## Risks / Trade-offs

- [Archived chats show a stale generated title or path for a short time
  after boot] → The window is seconds, and both values were already correct
  as of the last live update.
- [A line holding a cwd key that the markers miss, for example an escaped
  key] → Real records write keys literally, and P1 plus the 749-file parity
  run guard the equivalence. A miss falls back to the stored path, never to
  a wrong one.
- [The index is a snapshot taken at boot] → It is used only for restore and
  to seed the cache. The cache re-checks existence on every call.
- [A pathological single line, such as a multi-hundred-MB tool result that
  carries `"cwd"`] → Only one candidate line is held at a time. Its memory
  is bounded by that line, a cost the old path paid for the whole file.

## Migration Plan

No data migration. Ship it with the next release; the reboot after
`kawai update` takes effect at once. To roll back, reinstall the previous
release. No schema or stored data changed.

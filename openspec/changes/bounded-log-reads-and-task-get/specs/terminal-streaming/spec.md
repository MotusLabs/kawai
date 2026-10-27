# Spec Delta

## ADDED Requirements

### Requirement: Log discovery excludes chat transcripts before reading their content
Before any token or last-message read, the match worker SHALL check identities in order: the file-name thread id and the stored record or session id without opening the file, then the head session id from the bounded identity parse. The first excluded hit SHALL drop the log; being known never skips a stage. This SHALL hold for new, known, orphan, and backfill candidates in both collectors and the final list, after the newest-`maxLogs` selection.

#### Scenario: Rollout excluded by file name
- **WHEN** a poll selects a rollout whose file-name thread id belongs to a chat session
- **THEN** the file is never opened and is absent from the entries

#### Scenario: Chat record excluded without a read
- **WHEN** a known session's id, or an orphan or backfill record's session id, belongs to a chat session
- **THEN** the file is never opened, and it is absent from entries, orphan matches, and last-message results

#### Scenario: Excluded head id on any candidate
- **WHEN** a new, known, orphan, or backfill candidate's file-name and stored ids are not excluded, but its head session id belongs to a chat session
- **THEN** only the head identity parse reads it, no token or last-message read runs, and it is absent from entries, matches, and final attachment

#### Scenario: Unresolved head identity
- **WHEN** no excluded id is found and the bounded head yields no session id
- **THEN** no exclusion is inferred, no identity is fabricated, and the log keeps its existing eligibility and stored metadata

#### Scenario: Unexcluded logs unchanged
- **WHEN** a log's identity matches no excluded id, or no exclude set is given
- **THEN** it is enriched, gated, and matched as before

### Requirement: Token enrichment reads bounded windows
Token enrichment SHALL read at most a 200 KiB head window and a 200 KiB tail window of a log through one file descriptor, plus one lookbehind byte before the tail, and SHALL use no whole-file read. Only complete lines count. The tail SHALL keep its first line when it starts at a line start. Head identity parsing (up to 1 MiB) and exact matching are unchanged.

#### Scenario: Large log read in windows
- **WHEN** enrichment reads an unknown 700 MiB log
- **THEN** it reads at most 409,601 bytes of that file for the token evidence

#### Scenario: Size independence
- **WHEN** a 1 MiB log and a 1 GiB log share the same head and tail windows
- **THEN** both reads return the same number of bytes and the same evidence

#### Scenario: Tail starting at a line boundary
- **WHEN** the tail window starts exactly at the start of a line that holds message text
- **THEN** that line counts

### Requirement: Token evidence distinguishes complete from partial observations
Enrichment SHALL report known, unavailable, complete with an exact count, or partial with a lower bound. Complete SHALL require matching generations before and after the read, every requested byte read, the whole file covered, and every record accounted for without a partial line, early exit, or count limit. Any failed condition SHALL yield partial, even after an observed positive. A missing or unreadable log SHALL be unavailable.

#### Scenario: Small log read completely
- **WHEN** a stable log within 200 KiB is read fully and every record parses
- **THEN** its evidence is complete with the exact count, zero included

#### Scenario: Message only outside the windows
- **WHEN** a large log's only message text lies between the head and tail windows
- **THEN** its evidence is partial with count 0

#### Scenario: Positive then change
- **WHEN** message text is observed and the file then changes between the two stats, or a read returns fewer bytes than requested
- **THEN** the evidence is partial, never complete

#### Scenario: Missing log
- **WHEN** the log cannot be opened or read
- **THEN** the evidence is unavailable and it is not inserted this poll

### Requirement: Token gates and empty caches act only on complete evidence
Token gates SHALL reject only complete evidence below a positive minimum: a complete zero as empty, a complete positive as below threshold. A minimum of 0 or less SHALL pass all complete evidence; partial evidence SHALL stay eligible. Both empty caches SHALL admit only a stable complete zero, never a threshold rejection or a log with no session id, and SHALL reuse it only under the same file generation, mode, and options.

#### Scenario: Partial evidence stays eligible
- **WHEN** a log's evidence is partial with any count and the minimum is 1 or 2
- **THEN** it reaches exact matching and is inserted on an exact match, and neither empty cache holds it

#### Scenario: Giant line before a short message
- **WHEN** a log holds a valid line over 16 MiB with no message text, then a short user message, then a 300 KiB line with no message text
- **THEN** it stays eligible and is inserted on an exact match

#### Scenario: Complete zero
- **WHEN** a log's evidence is complete with count 0
- **THEN** it is rejected as empty at minimum 1, cached as empty, and the cached zero passes the token gate at minimum 0

#### Scenario: Complete positive below a generic minimum
- **WHEN** a log's evidence is complete with count 1 and the minimum is 2
- **THEN** it is rejected below threshold, neither empty cache holds it, and the same unchanged log passes at minimum 1

#### Scenario: No session id yet
- **WHEN** the poller meets a log with no session id
- **THEN** it writes no empty-cache entry, and the log is reconsidered once its id appears

#### Scenario: Same-size rewrite
- **WHEN** a log cached as a complete zero is rewritten at the same size with its mtime restored, or replaced at the same path
- **THEN** the cache entry is not reused and the log is read again

# Spec Delta

## ADDED Requirements

### Requirement: Log discovery excludes chat transcripts before reading their content
The match worker SHALL drop an excluded chat log before reading any content beyond its head identity parse, in both collectors, orphan rematch, and last-message backfill. A file-name thread id or known or record session id in the exclude set SHALL drop it without opening the file. Excluded logs SHALL never appear in worker output. The newest-`maxLogs` selection SHALL precede exclusion. Without an exclude set, behavior is unchanged.

#### Scenario: Rollout excluded by file name
- **WHEN** a poll selects a rollout whose file-name thread id belongs to a chat session
- **THEN** the file is never opened and is absent from the entries

#### Scenario: Unknown log excluded by its head id
- **WHEN** a poll selects an unknown log whose head session id belongs to a chat session
- **THEN** only the head identity parse reads it, no token read runs, and it is absent from the entries

#### Scenario: Known chat row excluded without a read
- **WHEN** a known session's id, or an orphan or backfill record's session id, belongs to a chat session
- **THEN** the file is never opened, and it is absent from entries, orphan matches, and last-message results

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

### Requirement: Token evidence keeps incomplete logs eligible
Enrichment SHALL report positive, proven-empty, incomplete, or unavailable evidence. Proven empty needs a stable full read of a file within the head window. Gates SHALL reject on token grounds only on complete evidence below the minimum; incomplete evidence SHALL stay eligible for exact matching, and unavailable evidence SHALL not be inserted that poll. Only proven-empty evidence SHALL be cached as empty.

#### Scenario: Message only outside the windows
- **WHEN** a large log's only message text lies between the head and tail windows
- **THEN** its evidence is incomplete, it stays eligible, and it is inserted when exact matching matches it

#### Scenario: Giant line before a short message
- **WHEN** a log holds a valid line over 16 MiB with no message text, then a short user message, then a 300 KiB line with no message text
- **THEN** it stays eligible and is inserted on an exact match

#### Scenario: Small log without messages
- **WHEN** a log within 200 KiB is read fully and stably and holds no message text
- **THEN** its evidence is proven empty, it is rejected, and it is cached as empty

#### Scenario: Changed or short read
- **WHEN** the file changes between the two stats, or a read returns fewer bytes than requested
- **THEN** the evidence is incomplete and is not cached

#### Scenario: Missing log
- **WHEN** the log cannot be opened or read
- **THEN** the evidence is unavailable, it is not inserted this poll, and nothing is cached

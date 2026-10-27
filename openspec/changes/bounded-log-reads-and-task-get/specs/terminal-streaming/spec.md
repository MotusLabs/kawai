# Spec Delta

## ADDED Requirements

### Requirement: Log polling reads are bounded by size
Log discovery and matching SHALL read at most a bounded head and a bounded tail of any agent log per poll, whatever the file's size. An excluded chat transcript SHALL be identified from its file name and bounded head alone and dropped before any other content is read. A log whose message text lies only outside both windows MAY count as having no message text.

#### Scenario: Large terminal-session log
- **WHEN** a poll enriches an unknown 700 MiB Claude or Codex log
- **THEN** it reads at most the head window and the 200 KiB tail window of that file, and its token count is computed from those windows only

#### Scenario: Excluded Codex chat rollout
- **WHEN** a poll finds a recently modified rollout whose file-name thread id or `session_meta` id belongs to a chat session
- **THEN** the rollout is dropped from the batch without reading beyond its head window, and no token count is computed for it

#### Scenario: Excluded Claude chat transcript
- **WHEN** a poll finds a recently modified Claude transcript whose head session id belongs to a chat session
- **THEN** the transcript is dropped without reading beyond its head window

#### Scenario: Empty tail falls back to the head window
- **WHEN** a log's tail window holds no message text, for example because it starts inside one huge line
- **THEN** the token count is taken from the bounded head window, never from a whole-file read

#### Scenario: Poll memory does not scale with log size
- **WHEN** the same poll runs over a 1 MiB log and over a 1 GiB log with the same head and tail content
- **THEN** both polls read the same number of bytes and return the same entry

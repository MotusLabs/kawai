# Proposal

## Why

Chat transcript work runs synchronously on the server's event loop, 2–3 full parses per
session: at boot, `ChatSessionManager.restorePersisted` (constructor, src/server/chat/
ChatSessionManager.ts:432→898) runs per persisted chat a recursive `readdirSync` discovery
(`findTranscriptPath`, transcriptReplay.ts:101) plus two full `readFileSync`+parse passes
(`readTranscriptTitle` then `readTranscriptCwd` over the same file); on first attach,
`getHistory` adds a third full synchronous parse (`replayTranscriptFile`). With several chat
sessions and large transcripts this blocks the event loop at startup and at every first
attach, stalling WebSocket delivery and terminal input. This is P1/S6 of the refactor
analysis (docs/refactor-analysis/phase2/server-architecture.md, P1-3).

## What Changes

- `transcriptReplay.ts`: add `readTranscriptMeta(filePath)` returning `{ title, cwd }` from a
  single read+parse pass (replaces the title/cwd double parse); convert `findTranscriptPath`
  and the file-reading entry points to async `fs/promises` (`findTranscriptPathAsync`,
  `readTranscriptMetaAsync`, `replayTranscriptFileAsync`), keeping the sync variants only
  where a caller cannot await (each remaining caller documented in-code).
- `ChatSessionManager.restorePersisted` becomes async, single-pass per session (discovery +
  one meta read), and no longer blocks server start: chat rows only need to exist before the
  first `chat-attach`, which awaits them.
- `ChatConnections` `chat-attach` handling awaits an async `manager.loadHistory(sessionId)`
  (memoized `snapshotHistory`) before building the snapshot, preserving the load-bearing
  ordering invariant: live events can never overtake the initial snapshot.

No externally observable behavior changes (snapshot contents and ordering contracts hold);
marked `skip_specs: true`.

## Capabilities

### New Capabilities

None — pure performance refactor; `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

None.

## Impact

- Code: `src/server/chat/transcriptReplay.ts`, `ChatSessionManager.ts`,
  `ChatConnections.ts`, and callers of the converted functions
  (`chatWorkerTranscript.ts`, `transcriptTitleWatcher.ts` if affected).
- Tests: `chatSessionManager.test.ts` (94 cases), `chatTranscriptReplay.test.ts`,
  `chatConnections.test.ts`, `chatRename.integration.test.ts` gate the change; add a race
  test that a `chat-attach` concurrent with a live `assistant_delta` still yields the delta
  after the snapshot.
- Risk: medium — the snapshot ordering invariant must hold through reconnect/restore flows.

# Implementation verification

All P/U/S/L/H tables are copied verbatim into `tests/fixtures/chatImageOracles.ts`. The client paste, lifecycle and history table suites and server upload/send table suite use independent expected results against production components, stores, routes, connection guards and runtime adapters. Additional integration tests cover the real manager and supported-context refusal.

Q1/Q3 run in `chatImageModel.test.ts`; Q2/Q4/Q5 run in `chatImageProperties.test.ts`. Each property uses seed `0x1a6e2026`, 200 sequences of 40 commands. Production manager/connection integration supplements the generated adapter probes. Publication failure, archive-during-read, kill-during-write, late results, superseding text/context, and teardown at uploading/awaiting/unconfirmed/refused/accepted boundaries have explicit tests. Browser reload verifies that unsent drafts are intentionally volatile.

## Oracle map

Titles below are exact generated table-test titles. The mutation column names an executed, restored source mutation detected by the mapped suite or its accompanying boundary/integration tests. `mutation-results.json` records each modified source, test command inputs, and actual failing test titles; shared mutations cover several related oracles. Unchanged source passed after restoration.

| Oracle | Table test title | Killed mutant |
| --- | --- | --- |
| P1 | P1: text / * -> Normal selection-aware text paste; zero uploads and turns | M-text-paste |
| P2 | P2: readable-supported / fits -> Ordered previews once; no clipboard text representation inserted; zero uploads and turns | M-paste |
| P3 | P3: readable-supported / exceeds -> Error; existing draft unchanged; zero uploads and turns | M-capacity |
| P4 | P4: readable-invalid / * -> Error; no invalid preview or turn | M-format |
| P5 | P5: protected-image / * -> Explain absent bytes; existing draft unchanged | M-protected |
| U1 | U1: Session missing -> 404 JSON error; no asset or agent | M-session |
| U2 | U2: Session archived, including during body read -> 409 JSON error; no addressable asset or agent | M-session |
| U3 | U3: Body limit or actual image size exceeded -> 413 JSON error; no addressable asset | M-body |
| U4 | U4: Malformed multipart or empty/missing file -> 400 JSON error; no addressable asset | M-multipart |
| U5 | U5: Unsupported MIME or signature mismatch -> 415 JSON error; no addressable asset | M-signature |
| U6 | U6: Storage failure -> JSON error; no successful reference returned | M-storage-error |
| U7 | U7: valid -> 200 metadata; exact immutable bytes readable only in that session | M-publication |
| S0 | S0: Image send has no valid request id -> Error; zero user events or provider inputs | M-request |
| S1 | S1: Chat unavailable or existing start/context check fails -> Correlated refusal; full draft recoverable | M-unavailable-chat |
| S2 | S2: Malformed/foreign/missing/unsafe image reference or list over four -> Correlated refusal; full draft recoverable | M-id |
| S3 | S3: No nonblank text and no image -> Correlated refusal; no turn | M-empty |
| S4 | S4: Driver refuses before admission -> Correlated refusal; full draft recoverable | M-driver-refusal |
| S5 | S5: valid Claude, images with optional text -> One acceptance; one logical user event; ordered native image blocks, text if supplied | M-claude-input |
| S6 | S6: valid Codex, images with optional text -> One acceptance; one logical user event; ordered native image inputs, text if supplied | M-codex-input |
| S7 | S7: valid text-only -> Existing text behavior with no image metadata | M-correlation |
| L1 | L1: local + Send, content valid -> Capture immutable snapshot; upload only after Send; enter uploading or awaiting-result | M-resend |
| L2 | L2: uploading + all uploads succeed -> Send one message referencing every image; enter awaiting-result | M-send-refs |
| L3 | L3: uploading + upload failure -> Error; keep snapshot recoverable; no provider send; settle attempt | M-uploads |
| L4 | L4: awaiting-result or unconfirmed + correlated refusal -> Keep/restore snapshot, separately if newer; settle attempt | M-refusal |
| L5 | L5: awaiting-result or unconfirmed + correlated acceptance -> Dispose submitted snapshot; preserve newer draft; settle attempt | M-newer |
| L6 | L6: awaiting-result + disconnect -> Mark unconfirmed; preserve snapshot; no resend | M-disconnect |
| L7 | L7: unconfirmed + reconnect -> Keep explicit unconfirmed state; attach history; zero resends | M-disconnect |
| L8 | L8: settled accepted + runtime error/interrupt/restart -> Native recorded message/images retained; no automatic resend or draft restoration | M-newer |
| L9 | L9: Any other state/event combination -> No submission transition or extra provider send | M-resend |
| H1 | H1: Switch sessions or remount during paste/upload -> Origin snapshot/draft only is updated; other drafts untouched | M-isolation |
| H2 | H2: Remove image or kill session before late preparation -> No resurrection; disposed preview URLs released | M-kill |
| H3 | H3: Archive then restore without reload -> Local draft retained; sent images readable while archived; no agent from reads | M-scoped |
| H4 | H4: Reload -> Unsent drafts gone; recorded sent image messages appear once | M-empty-replay |
| H5 | H5: Native replay: either runtime, text plus images or images only -> One logical user event, all image occurrences in order, stable native ids and times | M-native, M-mixed-tool-result |
| H6 | H6: Asset read with missing/foreign/unsafe/symlink reference -> 404; no unrelated bytes; UI unavailable placeholder when a recorded descriptor cannot load | M-unavailable |
| H7 | H7: Valid asset read, live or archived -> Exact bytes over HTTP; no agent starts | M-publication |
| H8 | H8: Plan context plus images -> Both preserved when supported; whole-send refusal when context unsupported/stale | M-context |
| H9 | H9: Local reset command with images -> Visible refusal; draft retained; no replacement chat | M-reset |
| H10 | H10: Slash menu choice with images -> Command inserted; images retained; no send | M-slash |
| H11 | H11: Restart/interrupt after recorded image input -> Same image message replays once; assets retained | M-native |

## Browser and native evidence

Seven Playwright tests, each with a private production server, database, runtime homes and tmux root, cover ordinary Claude and fixture Codex chats, the embedded plan conversation, image-only and mixed sends, paste/removal, text selection paste, upload failures, navigation during upload, actual reload, archive/restore and loading older history. The older-history browser case supplies an explicitly documented socket history projection; native parsing is separately exercised by real runtime smoke and unit fixtures. The Codex browser case uses the fake app-server, not a model provider.

Most browser image cases dispatch synthetic ClipboardEvents. The keyboard case instead writes an actual ClipboardItem through Chromium's clipboard API and presses Control+V, then verifies native text paste and draft loss on reload. This validates the browser clipboard path in headless Chromium; a human OS screenshot-copy gesture was not performed or claimed.

The opt-in `tests/fixtures/chatImageRuntimeSmoke.ts` succeeded with installed Claude 2.1.326 and Codex 0.169.0 for both mixed and image-only native inputs. Claude stores base64 image blocks; Codex stores input_image data URLs and generated path wrappers. The generated 32px PNG's original digest was present in both native transcripts. An additional 2200x1400 Codex probe retained the original digest for both input modes. Native wrappers are omitted from displayed text; canonical original asset references also survive normalized inline pixels. Claude produced no SDK user echo in the real probe; the UUID-preserving echo test injects the possible native echo independently.

Normal conversation WebSocket events contain descriptors; opt-in raw Debug continues to preserve protocol data verbatim. Image-only embedded drafts retain captured context, and production routing now forwards plan-workspace binding updates to their existing consumer.

Focused verification passed on current master with Bun 1.4.3: the 100-test image suite, followed by the queued-context, startup-snapshot and mixed tool-result replay regressions. Q1–Q5 ran at their full 200×40 case counts. All seven isolated browser cases passed. Both installed native runtimes accepted mixed and image-only messages through the public package factories and retained the expected image digest.

## Integration with current master

The feature is based on master `ec608f80`. Master extracted the former driver classes into `packages/agent-runtime`, so optional native `ImageInput` entries now cross that public package seam. The package captures ordered transport inputs before asynchronous admission; Kawai captures the same image values before startup and owns the public descriptors by message UUID. Queued Claude image-only sends retain both their context and duplicate image occurrences; Codex retains images through startup and steer fallback. Existing text-only payloads and permissions are preserved.

All 37 mutation checks were rerun against the current source layout, with exact substitutions and observed failing titles in `mutation-results.json`; every mutation was killed and restored-source tests passed. All 29 delta scenarios have explicit `@covers` evidence. Native smoke now uses the current public factories, checks successful results and native transcript identity, and joins shutdown. Claude 2.1.326 and Codex 0.169.0 both passed for mixed and image-only messages.

The final clean PR commit is certified through the repository's content-keyed full-check record using pinned Bun 1.4.3 and the shared `suite-run` admission wrapper. `bun run check --full-properties --no-retry` runs every declared property case and leaves retries under explicit low-CPU coordination. No full-check failure is treated as a pass; GitHub CI is also checked before merge.

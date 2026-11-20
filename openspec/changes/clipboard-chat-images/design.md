# Design

## Context

See `proposal.md` for motivation and `specs/chat-image-attachments/spec.md` for behavior.

Observed integration points:

- `ChatComposer.tsx` accepts `onSubmit(text)` and rejects blank text. `chatStore.drafts` holds per-session text; `ChatSurface.tsx` owns local reset commands and contextual sends. The `attachment` React node already means captured plan context, not an image collection.
- `ChatConnections.ts` already correlates `chat-send` acceptance and refusal using `requestId`. Ordinary sends do not currently request acknowledgement. `ChatSessionManager.send` validates session/start conditions and workspace context before submitting to a driver.
- `ChatAgentDriver.send(text)` and both concrete drivers are text-only. Claude queues an SDK user message with string content. The installed SDK declares content-block arrays including images. The checked-in Codex `UserInput` union includes `image` and `localImage`; `startCodexTurn` currently sends one text input plus discovered skills.
- `transcriptReplay.ts` reads Claude text blocks individually; `codexRollout.ts` extracts only text and drops blank user messages. Both must recognize image-only messages. Codex replay intentionally uses the native rollout as its only conversation source.
- `routes/paste.ts` stores terminal paste images under `/tmp`, returns a host path, and accepts a configurable size whose current default is 40 MiB. This is unsuitable for durable chat references. `bootstrap.ts` mounts HTTP routes. Native transcripts, rather than a second application message log, remain the history source.
- Existing seams include `chatConnections.test.ts`, `chatSessionDriver.test.ts`, `codexSessionDriver.test.ts` with its fake app-server harness, `codexRollout.test.ts`, `chatStore.test.ts`, and ordinary/embedded `chatSurface*` / `planWorkspaceConversation*` tests.

## Goals / Non-Goals

**Goals:** Add the same clipboard-to-image behavior to both chat runtimes; reuse the ordinary send acknowledgement and native history paths; keep binary transfers outside WebSocket history; preserve existing per-session draft and host boundaries.

**Non-Goals:** See the proposal. No new delivery queue, automatic replay of submitted turns, conversation database, global clipboard listener, image conversion pipeline, or new model capability catalog. Text-only sends retain their existing wire compatibility.

## Decisions

### D1. User-initiated paste and local draft assets

Handle the composer's `paste` event, extracting image `File`s from `clipboardData.items` with a `files` fallback. Deduplicate the two representations within one event, not across deliberate paste actions. Use native paste data rather than `navigator.clipboard.read()`, so the normal operation does not require asynchronous clipboard permission or a secure context. The browser must actually expose the bytes; a copied image URL or protected clipboard item is not fetched remotely.

When readable images exist, prevent text insertion for that event and append previews in clipboard order; otherwise preserve ordinary text paste. An image-advertising event without bytes reports an inline accessible error and preserves the draft. Unsupported file types report an error without becoming text paths. Accept PNG, JPEG, GIF, and WebP. Defaults are four images, each at most 5 MiB, with a resulting 20 MiB raw aggregate cap. These are proposed product defaults, not provider capability claims; enforce them in shared constants and the server.

Keep a separate image collection beside the existing string drafts to avoid changing unrelated text consumers. Each image has a client id, Blob/File, object URL, and optional uploaded reference. Bind asynchronous work to session id and the captured draft object identity; an old completion never resurrects a removed image or writes into a newer draft. Release object URLs on removal, kill, reload/unload, and disposal of a completed submission; keep them across composer unmount/navigation and archive/restore. A transient upload status is UI state, never a new exclusive persistent slot.

Alternative: upload immediately on paste. Rejected because existing unsent drafts are client-local and many pasted images are removed without being sent. Reusing the terminal capture listener would intercept unrelated paste targets and import terminal path-insertion behavior.

### D2. Durable, session-scoped image assets

Add a small `ChatImageStore` under `src/server/chat/images/` rooted at `chat-images/` beside the configured database, not a hardcoded home or `/tmp`. Use a server-derived safe session directory and a content-derived identifier (SHA-256 of bytes plus canonical extension). The store derives all paths; no client-supplied filename, path, URL, or content type determines an arbitrary read. Reject symlinked assets/directories and non-regular files. A requested reference must resolve in the addressed session's namespace even when another session has identical bytes.

Add HTTP routes:

- `POST /api/chat/:sessionId/images`: one multipart image per request, called only after Send. Bound the actual body stream including multipart overhead before buffering; do not trust Content-Length. Check nonempty payload, actual size, recognized PNG/JPEG/GIF/WebP signature, and matching declared supported type. Return `{ image: { id, mediaType, byteSize } }`; return JSON `{ error }` on every refusal. Use 413 for size, 415 for type/signature, 400 for malformed data, and 404/409 for missing/archived sessions. Check session availability again after asynchronous body processing.
- `GET /api/chat/:sessionId/images/:imageId`: serve only that session's registered canonical asset, including for archived chats, with canonical Content-Type, `X-Content-Type-Options: nosniff`, and private caching. Return 404 for missing, invalid, foreign, symlinked, or unreadable references. The route follows the application's existing access boundary; a session id is a namespace, not a new authentication scheme.

Write to a unique temporary file in the destination directory, flush, and atomically rename to the canonical filename before returning a reference. Interrupted temporary files are never addressable. Concurrent identical uploads may converge to the same immutable bytes; do not replace an asset with different content. No database migration is required for the asset index: canonical file identifiers and the session namespace are sufficient. Stored metadata is derived from the file rather than trusted from the client.

Retain uploaded assets through failed sends, interrupt, archive, and restore; delete their namespace on permanent session kill after the existing termination path has stopped consumers. Files uploaded for an ultimately refused send also remain until kill in this first version. This deliberately avoids a time-based collector deleting a slow upload or queued turn. Directory backups/restores must include `chat-images`; existing database-only snapshots remain database-only and cannot recover externally lost image bytes.

Alternative: reuse `/api/paste-image` paths. Rejected because temporary files are not durable and accepting arbitrary paths would turn the new display route into a file reader. Storing base64 in shared chat events would enlarge snapshots and delay WebSocket control messages.

### D3. One validated submission through the existing send path

Extend `chat-send` additively with ordered `images?: { id: string }[]`; require a readable `requestId` on image-bearing sends. Server-side resolution yields trusted image descriptors including absolute paths, bytes, media types, and sizes. Normal conversation events carry only safe public metadata, never those absolute paths or image bytes. Owner decision: the opt-in Debug view keeps verbatim protocol frames, including native image data and paths, as required by chat-debug; this exception does not change normal conversation transport. Empty text is valid only when at least one valid image exists. Validate the entire image list and workspace envelope before opening a turn or emitting its user message; do not silently drop an invalid image. Recheck archived/killed state after awaited work. An already dead or killed driver must refuse an image submission rather than silently succeeding.

The shared surface captures the text, images, plan scope, session id, and request id at Send. Upload images over HTTP, in preview order, with at most one active image request per submission; reuse successful immutable references on explicit retry. Disable duplicate submission of that captured draft while uploading or awaiting its result, but allow edits to create a newer draft. Then issue one `chat-send`. Clear only the captured draft on correlated acceptance; a refusal keeps or restores that snapshot without replacing newer edits. Keep earlier failed snapshots as explicit recoverable entries when there are newer edits. Unconfirmed sends after disconnect are shown separately with a warning to inspect history before retry; never replay them on reconnect. This reuses and generalizes the existing contextual-send recovery machinery rather than creating two competing recovery owners.

Text-only sends keep their current flow. Existing local `/clear`, `/reset`, `/new` commands remain client-handled; with images present, refuse locally and ask the user to remove the images first. This prevents an image attachment from disappearing during chat replacement. Slash-menu selection still inserts without sending. Captured plan context and images are separate fields and can coexist; the existing refusal for a runtime without workspace-context support remains in force.

Admission is the existing manager/driver boundary, not proof of model processing. After admission a runtime failure is reported as a turn error; it is not recast as a pre-admission refusal and never triggers automatic resend. This change does not promise exactly-once delivery across process crashes.

### D4. Native provider payloads

Use a runtime-neutral trusted user-input structure internally, preserving `send(text)` callers through an optional image argument or a dedicated `sendUserInput` seam. Keep SDK types behind drivers. Thread the same trusted input through Claude's contextual send seam.

- Claude: compose one `message.content` block array containing an optional nonempty text block followed by ordered `{ type: 'image', source: { type: 'base64', media_type, data } }` blocks. Keep existing uuid binding and `pasted_content` plan context. Image-only content has no fabricated text instruction. Do not interpret an image filename as a prompt.
- Codex: send an optional text `UserInput` plus ordered `{ type: 'localImage', path }` inputs and existing skill inputs. Resolve the paths only from `ChatImageStore`. Durable assets stay available for the app-server to read. Do not widen sandbox permissions for attachment storage; this is a protocol input read, not permission for generated tool writes.

Fixture tests must observe the actual queue or app-server request produced through the production manager/connection composition. A small opt-in runtime smoke verifies that the supported installed Claude/Codex baselines actually accept the payloads and records their native transcript image forms. Fake-server tests alone cannot establish the installed executable's behavior. Unsupported model/provider vision errors remain visible runtime errors; no automatic text-only fallback loses image context.

### D5. Replay from native image content

Extend `user_message` with safe ordered image descriptors and optional unavailable-image markers. Render these in the user row for live and replayed history, including when `text === ''`. Fetch browser bytes through the image route with lazy loading, constrained thumbnail dimensions, descriptive accessible labels, and an unavailable placeholder on read failure. Existing copy-message behavior copies text only, including an empty string for an image-only row.

Parse a native user message as one logical user message with its text and ordered image blocks; do not emit one user turn per text/image block. Preserve existing injected-context, peer-message, slash-command, ids, timestamps, and turn-boundary behavior for text-only records. Snapshot, older-history, and search projections must tolerate image-only user events without inventing OCR text.

Claude's native inline base64 images can be mapped to the session's asset identifiers by hashing decoded bytes; an absent asset renders unavailable rather than silently dropping the image. Codex replay must recognize the baseline's recorded image forms: inline `input_image` data URLs and any native local-path image representation confirmed by the recorded smoke fixture. Match inline bytes by digest or a canonical in-store path; never fetch a remote transcript URL or read an arbitrary path. Keep the rollout as the only source of Codex conversation rows. Native bytes are consumed only to resolve descriptors and are not retained in the projected conversation event cache or sent in normal conversation frames as base64. The opt-in raw Debug view remains verbatim. Preserve duplicate image occurrences even when their bytes share an asset id.

A native transcript without a recorded user input cannot prove receipt; do not synthesize a second conversation from upload files. Interrupted or crashed sends remain governed by existing transcript availability and the client unconfirmed-send behavior. This avoids speculative matching by text, timestamp, or ordinal and a second replay log. The concrete runtime smoke fixture is required before this change is accepted; if the baseline records no recoverable image content or identity, stop and revise this design rather than introducing text-based matching.

### Acceptance oracles

Use the following tables verbatim in table-driven tests. `*` means the input does not affect that row's result. Rows within a table partition the stated axes; different tables cover distinct operations.

Paste table axes: event class = text / readable-supported / readable-invalid / protected-image; capacity = fits / exceeds (only relevant to supported images).

| Id | Event class | Capacity | Observable result |
| --- | --- | --- | --- |
| P1 | text | * | Normal selection-aware text paste; zero uploads and turns |
| P2 | readable-supported | fits | Ordered previews once; no clipboard text representation inserted; zero uploads and turns |
| P3 | readable-supported | exceeds | Error; existing draft unchanged; zero uploads and turns |
| P4 | readable-invalid | * | Error; no invalid preview or turn |
| P5 | protected-image | * | Explain absent bytes; existing draft unchanged |

Upload validation uses first-failing category in the listed order. `valid` requires all earlier categories to pass, making the rows disjoint; combinations reaching a later row with an earlier failure are unreachable by definition.

| Id | First-failing category | Observable result |
| --- | --- | --- |
| U1 | Session missing | 404 JSON error; no asset or agent |
| U2 | Session archived, including during body read | 409 JSON error; no addressable asset or agent |
| U3 | Body limit or actual image size exceeded | 413 JSON error; no addressable asset |
| U4 | Malformed multipart or empty/missing file | 400 JSON error; no addressable asset |
| U5 | Unsupported MIME or signature mismatch | 415 JSON error; no addressable asset |
| U6 | Storage failure | JSON error; no successful reference returned |
| U7 | valid | 200 metadata; exact immutable bytes readable only in that session |

Send validation axes use first-failing category in listed order, after parsing a readable request id. A malformed/missing request id on an image send is S0. All refusal rows return one correlated error when an id is readable, no user event, and zero provider inputs.

| Id | First-failing category | Observable result |
| --- | --- | --- |
| S0 | Image send has no valid request id | Error; zero user events or provider inputs |
| S1 | Chat unavailable or existing start/context check fails | Correlated refusal; full draft recoverable |
| S2 | Malformed/foreign/missing/unsafe image reference or list over four | Correlated refusal; full draft recoverable |
| S3 | No nonblank text and no image | Correlated refusal; no turn |
| S4 | Driver refuses before admission | Correlated refusal; full draft recoverable |
| S5 | valid Claude, images with optional text | One acceptance; one logical user event; ordered native image blocks, text if supplied |
| S6 | valid Codex, images with optional text | One acceptance; one logical user event; ordered native image inputs, text if supplied |
| S7 | valid text-only | Existing text behavior with no image metadata |

S5/S6/S7 subdivide the final valid category by runtime and image presence; absent images with absent text reach S3. Evaluate S2 before S3. Post-admission runtime errors belong to L8 below, never S4.

Lifecycle transition table: the event column is the command axis. The state axis is local / uploading / awaiting-result / unconfirmed / settled. Events not accepted in a state are explicit no-ops under L9; each event has precedence over L9 only when its stated condition holds. `newer` means the currently editable draft is not the captured submission. A late result for a known unconfirmed request is still correlated.

| Id | State / event condition | Observable result |
| --- | --- | --- |
| L1 | local + Send, content valid | Capture immutable snapshot; upload only after Send; enter uploading or awaiting-result |
| L2 | uploading + all uploads succeed | Send one message referencing every image; enter awaiting-result |
| L3 | uploading + upload failure | Error; keep snapshot recoverable; no provider send; settle attempt |
| L4 | awaiting-result or unconfirmed + correlated refusal | Keep/restore snapshot, separately if newer; settle attempt |
| L5 | awaiting-result or unconfirmed + correlated acceptance | Dispose submitted snapshot; preserve newer draft; settle attempt |
| L6 | awaiting-result + disconnect | Mark unconfirmed; preserve snapshot; no resend |
| L7 | unconfirmed + reconnect | Keep explicit unconfirmed state; attach history; zero resends |
| L8 | settled accepted + runtime error/interrupt/restart | Native recorded message/images retained; no automatic resend or draft restoration |
| L9 | Any other state/event combination | No submission transition or extra provider send |

Selection/navigation, editing, removal, archive, reload, kill, and asset-read behavior are orthogonal to submission state; they are covered separately below rather than hidden in L9. A pending submission holds its own snapshot when editing starts a newer draft. Disconnect during HTTP upload before any `chat-send` leaves that upload attempt failed/recoverable (L3); it cannot have submitted a turn. Duplicate results on a settled attempt are L9. After reload no browser attempt survives; native recorded messages alone are replayed.

| Id | Operation / condition | Observable result |
| --- | --- | --- |
| H1 | Switch sessions or remount during paste/upload | Origin snapshot/draft only is updated; other drafts untouched |
| H2 | Remove image or kill session before late preparation | No resurrection; disposed preview URLs released |
| H3 | Archive then restore without reload | Local draft retained; sent images readable while archived; no agent from reads |
| H4 | Reload | Unsent drafts gone; recorded sent image messages appear once |
| H5 | Native replay: either runtime, text plus images or images only | One logical user event, all image occurrences in order, stable native ids and times |
| H6 | Asset read with missing/foreign/unsafe/symlink reference | 404; no unrelated bytes; UI unavailable placeholder when a recorded descriptor cannot load |
| H7 | Valid asset read, live or archived | Exact bytes over HTTP; no agent starts |
| H8 | Plan context plus images | Both preserved when supported; whole-send refusal when context unsupported/stale |
| H9 | Local reset command with images | Visible refusal; draft retained; no replacement chat |
| H10 | Slash menu choice with images | Command inserted; images retained; no send |
| H11 | Restart/interrupt after recorded image input | Same image message replays once; assets retained |

Completeness: P covers the four clipboard classes and both supported-capacity values. U and S use disjoint first-failure partitions with a valid remainder. L covers the finite state/event product via explicit rows and its complement L9; invalid local content never starts an attempt. H covers orthogonal lifecycle/read operations, with generators also interleaving them with L commands. No transaction crosses a provider boundary: durable file publication precedes reference return; admission precedes asynchronous model processing. No persistent exclusive holder or new startup reconciliation is introduced.

Property oracles use the existing Bun test stack and a tiny seeded generator (seed `0x1a6e2026`, 200 sequences of 40 commands), with independent expected values derived from these tables, never from implementation helpers:

- Q1: Other sessions' drafts are unchanged by an operation on A. Generate two sessions, edits/pastes/removals/switches/late completions; observe production `chatStore` and surface callbacks.
- Q2: Each submitted payload contains exactly the captured ordered image occurrences. Generate four image descriptors including equal-byte duplicates and mixed text; observe Claude queue and fake Codex app-server requests through manager/connection composition.
- Q3: No unconfirmed or settled attempt automatically resubmits. Generate L commands with disconnect/reconnect, duplicate/late results, and newer drafts; count actual `chat-send`/provider inputs and inspect recoverable snapshots.
- Q4: An asset read returns only bytes owned by its addressed session. Generate ids, traversal encodings, forged MIME, directory/file symlinks, and equal-content images in separate sessions; exercise routes mounted in the production HTTP app.
- Q5: Replaying a recorded user message preserves its image occurrences exactly once. Generate supported native image blocks, text-only records, injected context, peer envelopes, repeats and malformed tails; use both native parsers plus history snapshot/page composition and assert no base64 or host paths in normal conversation wire output.

Model-based lifecycle checks run L/H as the reference model under generated commands, request replays, and supersession by newer drafts. Fault injection stops storage after temporary write and after atomic publication; a fresh store must expose either no asset or exact complete bytes. Crash simulations before provider admission produce no native user row; after native receipt, restart replay retains one image message. Client reload at every asynchronous boundary must never cause a resend. Since there is no new SQL transaction, these are the storage publication/admission boundaries rather than invented database transactions. If implementation adds a recovery mechanism, add its recovery-matrix row and precise test citation in the same change.

## Risks / Trade-offs

- Clipboard availability varies by browser and source application -> use paste event bytes, explain withheld data, and test native browser paste in the supported browser matrix; do not silently read the server's clipboard.
- Signature checking is format admission, not full image decoding -> reject recognized mismatches early and display provider rejection for otherwise corrupt or unsupported image content; do not claim all files passing a header check are decodable.
- Third-party profiles may have smaller limits or no vision -> surface their error without dropping images or claiming success from a text fallback.
- Native transcript image shapes can vary -> pin smoke fixtures for the supported baselines and make image-only replay an acceptance gate; do not fall back to ordinal/text matching.
- Inline native base64 may increase transcript parsing memory -> decode one bounded image at a time and retain descriptors only, keeping the existing asynchronous line reader.
- Assets outlive unsuccessful uploads until session kill -> bounded requests and content dedup limit per-attempt cost; automatic orphan collection is deferred. This is not a global disk quota.
- A database-only restore lacks image files -> document directory backup requirements and render unavailable placeholders rather than changing database snapshot promises.

## Migration Plan

1. Add optional shared fields and HTTP/store support; existing sessions without images need no migration and old text frames remain valid.
2. Ship both runtime adapters and replay readers before enabling composer sends. Keep terminal routes unchanged.
3. Validate with focused client/server suites, opt-in real-runtime smoke fixtures, browser paste checks, and `bun run check` during implementation.
4. Rollback disables new image submission; retain asset files and native transcripts. Re-upgrading restores display. Older clients/servers are not promised to display newly added images, so update client and server together.

## Implementation contract

### Acceptance

- A1: P1-P5 and H1-H4 hold for both ordinary and embedded composers, with accessible ordered previews and per-session local drafts.
- A2: S0-S7 and H8-H10 hold; both runtimes receive native images including image-only messages, with no partial send on validation failure.
- A3: U1-U7 and H6-H7 hold through the production HTTP app, with immutable durable assets and no arbitrary path/URL reads.
- A4: L1-L9 hold for image submissions; failures preserve recoverable input, late results preserve newer edits, and reconnect never resends.
- A5: H5 and H11 hold for both native transcript formats in live, paginated, restarted, and archived views, with image bytes absent from normal conversation WebSocket messages; opt-in raw Debug frames remain verbatim.

### Invariants

- I1: An operation on one session never changes another session's draft (Q1).
- I2: A submitted native payload retains exactly its captured ordered image occurrences (Q2).
- I3: An uncertain or settled submission is never automatically replayed (Q3).
- I4: An asset request never serves bytes outside its session namespace (Q4).
- I5: A native recorded user message yields exactly one user event with its ordered image occurrences (Q5).

### Scope

Integration with current master maps the former monolithic driver paths to their runtime-package adapters. The optional native image input seam is additive; asset authority and safe event descriptors stay in Kawai.

- src/shared/**
- src/client/components/chat/**
- src/client/components/team/PlanWorkspaceConversation.tsx
- src/client/stores/**
- src/client/protocol/**
- src/client/__tests__/**
- packages/agent-runtime/src/**
- packages/agent-runtime/__tests__/**
- packages/agent-runtime/README.md
- src/server/chat/**
- src/server/routes/**
- src/server/bootstrap.ts
- src/server/__tests__/**
- tests/**
- docs/architecture/chat.md
- docs/recovery-matrix.md
- openspec/changes/clipboard-chat-images/**

### Verification

- V1: Commit the P/U/S/L/H tables verbatim as table-driven tests with production wiring coverage; run Q1-Q5 with the stated seed and case count.
- V2: Record supported Claude/Codex payload and native replay smoke fixtures and show both runtimes accept image-only and mixed input; browser verification covers keyboard paste, text paste, and withheld image data.
- V3: Add scenario `@covers` annotations, run focused suites and `bun run check`, and report each oracle id's test title and killed mutant in the implementation result.

### Excluded

- X1: No implementation in this planning change; implementation begins only through an explicit apply request.
- X2: No arbitrary attachments, picker/drop UI, remote URL fetching, image transformation, team-mail attachments, or draft persistence across reload.
- X3: No new authentication model, automatic delivery retry, exclusive persistent slot, time-based orphan deletion, or second conversation history source.

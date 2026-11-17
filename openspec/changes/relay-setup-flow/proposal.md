# Proposal

## Why

Configuring a relay today means hand-editing catalog files, guessing which
layer wins, and finding out at the first real request. That request fails
with the gateway's own text: a misleading 403 that nothing classifies.
`provider-relay-setup` §6–§10 designed the operator path: one owned write
path for catalog edits, a source listing and an effective-configuration
preview computed by the production resolution, a connection test through the
real launch path, one ordered failure classifier shared by the test and by
live sessions, and a model-availability check. None of it is on master.

This is one of five slices carved from `provider-relay-setup` (task-f588bc17
r2). The umbrella stays byte-unchanged and held. Its full partition is in
`fixture-relay/design.md`. Every part that needs the held install-modes
lineage (templates, the retained-defaults layer, the install-state record,
install-mode labels) stays mapped to that hold and is not included here.

## What Changes

- **Setup write path (umbrella 6.1, 6.2 without adoption):** a catalog-edit
  API that validates through the production parsers, saves user-level files
  atomically, and reports stale-stamp conflicts. The New Session and Settings
  provider editor sets the base URL, token variable, header bindings, and
  model IDs in one flow, with values going only to the credential store.
  Catalogs still replace the shipped tier whole once a user file exists, so
  before the first save the editor previews which shipped ids stop being
  offered and writes nothing unless the operator confirms.
- **Source listing and preview (7.1–7.4):** every catalog file with its
  status and reason, credential presence and source per variable, migration
  skips and launch-env collisions. A preview of the selected profile equals
  the launch, with values redacted. Rejection messages name the supported
  setting.
- **Connection test (8.1–8.5):** Claude-runtime profiles only. It resolves
  and composes exactly as creation does, runs one print-mode request with
  transcript persistence off, within a 30-second budget, with the process
  group reaped on every path, one test per provider, and no rows written.
  Diagnostic output is redacted before any sink.
- **Classifier and live classification (9.1–9.3):** one ordered, total rule
  list. The existing limit predicate runs first and unchanged, then the
  resolver's required-credential gate, then documented structured evidence.
  Prose is never evidence. Live failed turns show the same class additively
  on the error row and change no turn, mail, or limit outcome.
- **Model availability (10.1–10.3):** `GET {base URL}/v1/models`, bounded,
  no redirects. The exact wire model ID is compared after alias resolution.
  The cache is keyed by credential generation, and an unknown result marks
  nothing.

## Capabilities

### New Capabilities

- `provider-setup`: setup write path, source listing, preview, connection
  test, redaction, failure classes, live classification, model availability.

### Modified Capabilities

- `profile-limit-handling`: ADDED "Connection failures are diagnostics,
  never limits" and "Connection tests never record limits".
- `claude-session-profiles`: ADDED "Profiles are marked when the provider's
  catalog lacks their model".

## Impact

- Code (new): catalog-edit API and route, preview and source-listing
  projectors, `src/server/chat/connectionTest.ts`,
  `src/server/chat/connectionDiagnostics.ts`, a redactor beside
  `src/server/outbound/redact.ts`, a models-list adapter, and client editor,
  listing, and preview components. Those components are extracted, because
  `NewSessionModal.tsx` is already 853 lines.
- Code (changed): `src/server/routes/claudeProfiles.ts`,
  `ChatSessionManager.ts` (live failure handling),
  `provider/runtimeEvents.ts` (error row field), `src/shared/chat.ts`
  (additive diagnostic field). Live classification needs HTTP status and
  structured error evidence on the runtime's error event. If
  `packages/agent-runtime` does not expose it, this change adds an additive
  field there. Kawai consumes the in-tree `workspace:0.1.1` package, so
  nothing is published.
- Dependencies: `provider-credential-store` and `relay-headers` are
  correctness prerequisites.
- Holds unchanged: templates, adoption, the retained-defaults marks, the
  install-state record, and install-mode labels stay with task-c6bfbd04.

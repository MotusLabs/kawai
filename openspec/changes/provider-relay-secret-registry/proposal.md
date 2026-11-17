# Proposal

## Why

`provider-relay-setup` section 1 (the secret-name registry and the
filtered-env audit) landed in #325 and is wired into every production launch
path, but none of its boxes are ticked and its requirement cannot archive on
its own: the umbrella change is held (install modes, task-c6bfbd04) and
bundles ten more sections. Main specs therefore do not record behavior the
server already enforces. This change is the closeout slice for the landed
part only: it states the requirement exactly as the code implements it
today, maps every scenario to existing tests, and archives it into a new
`provider-credentials` main spec.

It is one of five slices carved from `provider-relay-setup` by the
remaining-backlog plan (task-f588bc17 r2): `provider-relay-secret-registry`
(this), `provider-credential-store`, `relay-headers`, `relay-setup-flow`,
and `fixture-relay`. The umbrella stays byte-unchanged and held; its full
partition and eventual reconciliation are recorded in
`fixture-relay/design.md` ("Relay partition inventory").

## What Changes

- ADD `provider-credentials` › "Registered secret names stay withheld" in
  its landed form: catalog-layer credential names in any entry state and
  retained names (names only in `app_settings`), inert collisions with
  pre-spawn refusal on branches that must compose a registered name.
- No production code changes. Tests may gain `@covers` annotations for the
  renamed scenario "A dropped entry's variables stay withheld"; nothing else
  in the test tree changes.
- Archive creates `openspec/specs/provider-credentials/spec.md`.

Not in this change (each named owner, nothing silently dropped):

- secret-source store keys joining the registry and the "Reclassification
  does not end withholding" scenario → `provider-credential-store` (it
  MODIFIES this requirement after this change archives);
- header variables joining the registry → `relay-headers`;
- the source listing reporting a collision → `relay-setup-flow`;
- the literal `enabled: false` disable path ("A disabled entry's variables
  stay withheld") → the held install-modes lineage (task-c6bfbd04,
  `feat/relay-install-modes` bddbdb42), unchanged.

## Capabilities

### New Capabilities

- `provider-credentials`: registered secret names are withheld from every
  agent launch.

### Modified Capabilities

None.

## Impact

- Specs: new `openspec/specs/provider-credentials/spec.md` at archive.
- Code: none. Evidence lives in `src/server/chat/secretNameRegistry.ts` and
  its consumers (design "Current inventory").
- Holds: `provider-relay-setup`, its tasks (task-a12940da, task-c6bfbd04,
  task-cd6ffb9f, task-62609b66, task-42c653e6, task-65da4225,
  task-ec54bc33) and branches stay as they are; no adoption, tick, or
  cancellation.

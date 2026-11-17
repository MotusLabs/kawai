# Proposal

## Why

The human's acceptance path for relay support is end to end: configure a
Bifrost-style relay once through the setup surface, test each model, and
create a working session whose requests carry the right headers, with
failures classified honestly and secrets redacted everywhere. Each earlier
relay slice proves its own part. Only a fixture relay driven through the
real server and browser proves they compose. `provider-relay-setup` task
11.1 specified that e2e, 11.2 the final docs, and 11.3 an archive-order
contract that no longer holds now that the umbrella is split.

This is the last of the five slices carved from `provider-relay-setup`
(task-f588bc17 r2). It also holds the **complete partition** of the
umbrella: every original task, requirement, and scenario mapped to exactly
one slice, landed evidence, or the explicit owner hold. It ends with a
reconciliation proposal for the umbrella itself, which the owner decides.

## What Changes

- A fixture-gated Playwright spec (`tests/e2e/relay-setup.spec.ts`) and a
  loopback fixture relay. A fresh disposable instance configures a relay
  through the setup editor (base URL, token variable, an `x-bf-vk` header
  binding, model IDs), runs the connection test per model, and creates a
  session. The relay asserts it received the composed headers and token. A
  scripted 403 with the documented virtual-key type shows
  `virtual-key-restriction` on the live error row with no limit event. A
  prose-only 403 shows the evidence-qualified unknown. Every diagnostic
  surface shows sentinels redacted. It runs only in CI's fixture step
  (listed by `scripts/e2e-fixture-specs.ts`) or a disposable checkout,
  database, and spare port with CI's fixture setup. It never runs through
  `bun run test:e2e` and never touches live data.
- Final relay docs across the landed slices, with no install-mode content.
- A written reconciliation proposal for `provider-relay-setup` once every
  executable slice has landed: what is landed, what remains held, and the
  options (retire the umbrella or narrow it to the held install-modes
  scope). The owner decides; this change edits nothing in the umbrella.

No requirement changes. The scenarios this e2e exercises are owned by
`relay-setup-flow`, `relay-headers`, and `provider-credential-store`.
`.openspec.yaml` sets `skip_specs: true`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None.

## Impact

- Tests: `tests/e2e/relay-setup.spec.ts`, a loopback relay helper under
  `tests/e2e/fixtures/`, and the dev chat fixture (`src/server/chat/` fixture
  module) if the live-error path needs a scripted runtime outcome.
- Docs: `docs/claude-session-profiles.md`, AGENTS.md profiles/limits bullets,
  `docs/architecture/` bullet.
- CI: nothing to register. The landed lister (#418) selects fixture-gated
  specs automatically.
- Holds: the umbrella and every held task stay unchanged until the owner
  acts on the reconciliation proposal.

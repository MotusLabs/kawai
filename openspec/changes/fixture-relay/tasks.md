# Tasks

Integration slice for `provider-relay-setup` 11.1–11.3. Oracle ids: FR-1…FR-7.
No requirement changes (`skip_specs: true`). Browser runs only in CI's
fixture step or a disposable checkout/database/spare port with CI's fixture
setup — never `bun run test:e2e`, never live data. Never edit
`provider-relay-setup/**`.

## 1. Fixture-relay end to end (umbrella 11.1)

- [ ] 1.1 Decide FR-D1 (real CLI vs fixture-mode request) with one disposable-checkout probe against a loopback relay; journal the choice and what FR-3 will prove. Verify: A3; the journal names the runtime and its limits.
- [ ] 1.2 Add the loopback relay helper (`tests/e2e/fixtures/fixtureRelay.ts`): `/v1/models`, `/v1/messages` with scripted outcomes, request-header capture, 127.0.0.1 on a spare port, sentinel values only. Verify: A2; a unit check that a non-loopback bind is refused.
- [ ] 1.3 Add `tests/e2e/relay-setup.spec.ts`, fixture-gated like `tests/e2e/chat-profiles.spec.ts`: FR-1 configure through the editor (confirming the replace-mode preview), FR-2 connection test per model, FR-3 session reaches the relay with composed headers and token. Verify: FR-1–FR-3 in the fixture step; the header-composition mutant fails FR-3 (A4). // @covers: provider-setup › Relay setup configures a provider in one flow › One-flow setup; // @covers: claude-session-profiles › Bound headers compose into the launch environment › Header binds a virtual key
- [ ] 1.4 Extend the spec: FR-4 documented virtual-key 403 → `virtual-key-restriction`, no limit event; FR-5 prose-only 403 → evidence-qualified unknown; FR-6 sentinels redacted on every diagnostic surface; FR-7 absent model marked. Verify: each row asserts its observable; mutant "error-row diagnostic dropped" fails FR-4. // @covers: provider-setup › Live failures classify like tested ones › A documented restriction shows its class live; // @covers: provider-setup › Live failures classify like tested ones › A prose-only 403 shows the unknown live; // @covers: provider-setup › Diagnostic output is redacted before any sink › Echoed secret is redacted; // @covers: provider-setup › Model availability is checked against the provider's catalog › Absent model is marked
- [ ] 1.5 Checkpoint: `bun scripts/e2e-fixture-specs.ts` lists the new spec, and it is skipped with the fixture off; the existing fixture-gated specs still pass in the same step (V3). Verify: journal the lister output and run id.

## 2. Docs (umbrella 11.2)

- [ ] 2.1 Update `docs/claude-session-profiles.md`, the AGENTS.md profile/credentials/limits bullets, and the relevant `docs/architecture/` bullet for the landed relay behavior; name install modes, templates, retained defaults, retire, and degrade only as held. Verify: A5, by review against the landed slices' archived specs.
- [ ] 2.2 Final campaign: citation preflight (zero unresolved), clean committed head `bun run check --full-properties` (pinned Bun 1.4.3, umask 022, via suite-run), `bun scripts/verify-result.ts` exit 0, the CI fixture-step run on the same head; one complete result. Verify: V1–V3.

## 3. Close and reconcile (replaces umbrella 11.3)

- [ ] 3.1 After review passes: archive this change (no spec sync; `skip_specs`). Verify: `openspec validate --specs --strict` passes.
- [ ] 3.2 Confirm every slice in the design's slice graph has archived, and re-check the canonical partition against the umbrella's current text (still byte-identical to f52963d0, or report the drift). Verify: a table of slice → archive commit in the journal.
- [ ] 3.3 Write the reconciliation note (FR2): landed rows with evidence, held rows unchanged, options (i) retire the umbrella or (ii) narrow it to the held scope, and the effect of each on the umbrella's `@covers` annotations; send it to the Lead for the owner's decision. Verify: A6; nothing under `provider-relay-setup/**` changes.

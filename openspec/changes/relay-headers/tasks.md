# Tasks

Implements `provider-relay-setup` §4 on the current tree. Oracle ids are
this change's design rows: HP1–HP9, HC1–HC9, PH6, PH1, HW1–HW3. Tables
are committed verbatim as table-driven tests next to the code. Never tick
or edit `provider-relay-setup/tasks.md`.

## 1. Parse, trust, and registration (umbrella 4.1)

- [ ] 1.1 Journal the Lead's OD-H1 decision (ambient `ANTHROPIC_CUSTOM_HEADERS` on credentialed launches) before any group-2 code. Verify: the journal entry names the chosen option; HC8's expected row is filled from it.
- [ ] 1.2 Parse `headers` on trusted `providers.json` providers only; refuse it in project files and any `profiles.json` (file rejected whole, naming file and field); refuse case-insensitive collisions; header names are field-name tokens; variables match `CREDENTIAL_NAME_PATTERN`. Verify: HP1–HP6, HP9 as a table-driven test and PH6 (100 cases); mutant "accept `headers` in project files" fails HP2 and PH6; mutant "case-sensitive collision check" fails HP4. // @covers: claude-session-profiles › A provider may bind custom headers to credential variables › A project file cannot bind headers; // @covers: claude-session-profiles › A provider may bind custom headers to credential variables › Case-insensitive collision is refused
- [ ] 1.3 Make headers-only providers credential-bearing in `providerCredentialed`: trusted non-empty base URL required, no executable. Verify: HP7, HP8; mutant "providerCredentialed ignores headers" fails HP7. // @covers: claude-session-profiles › A headers-only provider pins its route › Headers-only provider without a base URL
- [ ] 1.4 Register every header variable of every parsed layer (H2). Verify: HW2 through the real `ChatSessionManager` respawn; mutant "header variables not added to `credentialNames`" fails HW2.
- [ ] 1.5 Checkpoint: HP2 and HP7 through the real `resolveProfileCatalog`; the preserved catalog parse/merge and registry tests pass unchanged. Verify: journal base/head and outcomes.

## 2. Launch composition (umbrella 4.2)

- [ ] 2.1 Compose `ANTHROPIC_CUSTOM_HEADERS` in `ClaudeProfiles.ts` from bindings resolved through the credential composition: newline-joined `Name: Value` pairs in launch env only; an empty variable omits its header; CR/LF/NUL refuses the launch naming the header. Verify: HC1–HC5, HC7, HC9 as a table-driven test; mutant "write the composed value into `settings.env`" fails HC1 and I1. // @covers: claude-session-profiles › Bound headers compose into the launch environment › Header values stay out of the settings layer
- [ ] 2.2 Pin route and transport for headers-only launches like credentialed ones. Verify: HC6; mutant "pins only when `authTokenEnv` is set" fails HC6. // @covers: claude-session-profiles › A headers-only provider pins its route › A headers-only provider pins its route
- [ ] 2.3 Apply OD-H1's decision. Verify: HC8 plus the existing openrouter credentialed-launch tests pass; mutant "opposite of the chosen option" fails HC8.
- [ ] 2.4 Production path: HW1 (a store-held value reaches `claudeRuntimeLaunch`'s options as the composed variable only) and HW3 (a CR value settles the send failed, no child). Verify: each named mutant fails; journal the checkpoint. // @covers: claude-session-profiles › Bound headers compose into the launch environment › Header binds a virtual key
- [ ] 2.5 PH1 (200 cases, fixed seed): header sentinels never appear outside the composed variable. Verify: mutant "log the composed env on launch failure" fails PH1. // @covers: claude-session-profiles › Bound headers compose into the launch environment › A header value carrying a line break is refused
- [ ] 2.6 Cover "Empty variable omits the header" at the launch. Verify: HC3/HC4; mutant "emit `Name: ` with an empty value" fails. // @covers: claude-session-profiles › A provider may bind custom headers to credential variables › Empty variable omits the header

## 3. Exposure evidence and close (umbrella 4.3)

- [ ] 3.1 Build the sentinel-only CLI fixture (umbrella D12-1): a loopback fixture relay and sentinel values. Assert what the CLI process env holds, what one Bash tool child sees on the supported CLI baseline (withheld names absent; only the composed token and header variables and W6/W9 launch-env entries carry credential values), and that the settings layer carries no token or header value. It runs only in CI or a disposable environment with sentinel values; if the real CLI cannot run there, record the gap (A5). Verify: the spec is fixture-gated so `scripts/e2e-fixture-specs.ts` lists it; it never runs via `bun run test:e2e`.
- [ ] 3.2 Document `headers` (placement rule, composition, empty and refused values, headers-only pinning, the measured or unmeasured exposure boundary) in `docs/claude-session-profiles.md`. Verify: review against this change's delta.
- [ ] 3.3 Final campaign: citation preflight (zero unresolved), clean committed head `bun run check --full-properties` (pinned Bun 1.4.3, umask 022, via suite-run), `bun scripts/verify-result.ts` exit 0, one complete result with the coverage map. Verify: V1–V5.
- [ ] 3.4 After review passes: sync and archive in one commit. Verify: `openspec validate --specs --strict` passes.

# Proposal

## Why

Relays such as Bifrost take their virtual key in a custom header
(`x-bf-vk`). Kawai has no supported way to send one. A catalog file setting
`ANTHROPIC_CUSTOM_HEADERS` is rejected, correctly, because catalog env never
carries credentials, but nothing replaces it. `provider-relay-setup` §4
designed the replacement: trusted providers bind header names to credential
variables, and the launch composes `ANTHROPIC_CUSTOM_HEADERS` from resolved
values in the process environment only. None of §4 is on master.

This is one of five slices carved from `provider-relay-setup` (task-f588bc17
r2). The umbrella stays byte-unchanged and held. Its full partition is in
`fixture-relay/design.md`.

## What Changes

- `providers.json` providers at a trusted tier may set `headers` (header
  name → credential variable). The field is refused in project files and
  any `profiles.json`, and case-insensitive name collisions are refused.
- Every header variable joins the secret-name registry. No launch receives
  it under its own name.
- At launch, resolvable bindings compose into `ANTHROPIC_CUSTOM_HEADERS` as
  `Name: Value` lines, in the process environment only, never in the flag
  settings layer. An empty variable omits its header. A value with CR, LF,
  or NUL refuses the launch, naming the header.
- A provider with `headers` and no `authTokenEnv` is credential-bearing: it
  needs a trusted base URL, takes no executable, and its launches pin the
  base URL and transport variables.
- A sentinel-only CLI fixture records what the CLI process and a Bash tool
  child actually receive (umbrella D12-1).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-session-profiles`: three ADDED requirements (bind headers; compose
  into the launch environment; a headers-only provider pins its route).

## Impact

- Code: `src/server/chat/catalogParse.ts` (field, trust refusal, collisions),
  `catalogMerge.ts` (`providerCredentialed` includes headers),
  `profileCatalog.ts` (header variables in `credentialNames`),
  `ClaudeProfiles.ts` (composition, pins, refusal),
  `secretNameRegistry.ts` (the header source is fed), and tests.
- Values come from the composed credential resolution, so this change
  depends on `provider-credential-store`.
- Docs: the `headers` field in `docs/claude-session-profiles.md`.
- Holds unchanged: the umbrella and its tasks. The `enabled`, template, and
  retained states the umbrella mentions are held (task-c6bfbd04).

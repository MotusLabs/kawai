# Tasks

## 1. Catalog file loading and validation

- [x] 1.1 Implement catalog file parsing (JSON object keyed by profile id; entries partial — any subset of `label`, `env`, `model`, plus `executable` in user-level files only; id pattern `^[a-z0-9][a-z0-9-]*$`; caps of 32 env vars and 4096-char values) with errors naming the offending file, and verify unit tests cover valid files, partial entries, each validation failure, and unreadable files
- [x] 1.2 Restrict catalog `env` keys to the `PROFILE_CONTROLLED_ENV` allowlist (credential keys such as `ANTHROPIC_AUTH_TOKEN` rejected) and verify unit tests prove a credential-bearing file is refused while a routing-only file passes
- [x] 1.3 Reject `executable` in catalog files below the user level with an actionable error naming the file, keeping other discovered files' profiles usable, and verify unit tests cover the refusal, failure isolation, and a user-level executable entry passing

## 2. Layered catalog resolution

- [x] 2.1 Implement discovery: collect `.kawai/profiles.json` from the realpathed project path up to `/`, layered above the user-level `~/.kawai/profiles.json`, which replaces the in-image default when present, and verify unit tests cover walk order, home replacement, and missing directories
- [x] 2.2 Implement per-key merge for same-id profiles (nearest wins per env key and per scalar `label`/`model` field, `""` neutralizes an inherited env value, post-merge label falls back to the profile id, `executable` settable only at the user level) and verify unit tests cover nearest-wins, per-key extension, neutralization, scalar override, and label fallback
- [x] 2.3 Allow `default` to be defined in catalog files, layering onto the global provider environment like named profiles, and always synthesize an implicit empty `default` when no file defines it; verify unit tests cover file-defined default routing, credential inheritance from the global layer, named profiles being unaffected, and a replacement catalog without a `default` entry still resolving omitted selections
- [x] 2.4 Verify a malformed catalog file yields an actionable error while profiles from other discovered files still resolve (unit test with one bad and one good file in the walk)

## 3. Executable-backed profiles

- [x] 3.1 Extend profile resolution with user-level `executable`: merged base environment passed through, entry env pre-applied with the executable's own exports winning, no inline controlled settings injected, launched via the SDK executable option in place of the standard binary, and verify unit tests cover env hand-off, settings absence, and wrapper-export precedence
- [x] 3.2 Produce an actionable error before agent start when the executable is missing or not executable, and verify a unit test asserts no agent spawns and the error names the path
- [x] 3.3 Extend the availability probe identity (`claudeLaunchKey`) to include the resolved executable and verify unit tests prove identical env/model profiles with different executables probe separately

## 4. Server API and session creation

- [x] 4.1 Make the profile catalog endpoint resolve per requested project path and return identifiers and labels only, and verify route unit tests cover per-path catalogs and no credential/env leakage
- [x] 4.2 Validate chat creation against the catalog resolved for that project path: reject unknown identifiers and reject any client-supplied environment map or executable path, and verify route unit tests cover both refusals
- [x] 4.3 Verify agent spawn and resume re-resolve the stored profile id against the current filesystem, with the existing actionable-error path when the defining file is gone (unit test: rename catalog, resume session)

## 5. Client picker

- [x] 5.1 Extend `useClaudeProfiles` to accept a project path and `NewSessionModal` to re-fetch the catalog when the selected project path changes, keeping the existing loading/retry UI, and verify component tests cover fetch-on-change and catalog-failure reporting
- [x] 5.2 Check the chat view profile label resolves from the per-path catalog with fallback to the stored id, and verify the component test covers a label present and a catalog missing the stored id

## 6. Migration and integration

- [x] 6.1 Ship the current six profiles as the in-image default catalog file (env-only entries), delete the hardcoded array from `ClaudeProfiles.ts`, and verify the existing profile unit tests pass against the file-backed catalog unchanged in behavior
- [x] 6.2 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 6.3 Exercise the app end to end with the dev-browser skill: pick a project path with a `.kawai/profiles.json` defining a new profile, create a chat session with it, confirm the picker offers it, the chat header shows its label, and a turn starts against it; confirm terminal session creation is unchanged

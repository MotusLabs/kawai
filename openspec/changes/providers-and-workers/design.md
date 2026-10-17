# Design

## Context

See proposal.md (Why) for the motivation. The current code has this shape:

- **Catalog.** `resolveProfileCatalog(ctx)` (`src/server/chat/profileCatalog.ts`) layers its files from farthest to nearest:
  - the base is `~/.kawai/profiles.json` when it exists, else the shipped `config/profiles.default.json`;
  - then project `.kawai/profiles.json` files from `/` down to the project path.

  It returns `profiles: Map<id, CatalogProfile { label, env, model?, executable?, limitResetTimeZone? }>` with a synthesized `default`, plus `errors`. Same-id entries merge, with the nearest scalar winning and env merged per key. A file that fails validation is skipped whole.

  Every launch, probe and destination reader consumes the merged map:
  - `ClaudeProfiles.resolveClaudeProfile`;
  - `launchEnvOf` in `ChatSessionManager`;
  - `OutboundDestinations.load`, which reads each entry's `ANTHROPIC_BASE_URL`;
  - `groupCatalog.ts`, which drops unknown ids;
  - `profileLimitResetTimeZone`.
- **Account facts keyed by profile id.**
  - `profile_limit_events` stores `profile_id` with no window (`src/server/team/routing/limitEvents.ts`). Cooldown is the latest final event's reset, else one hour after it (`cooldownUntil`).
  - Readers of cooldown:
    - the recipient snapshot (`sessionMailbox.ts`), and through it the dispatcher and the cause reporter;
    - the router (`profileStates`, the `cooling` predicate, the `all-profiles-cooling` hold) and `builtinPick`;
    - the dispatch preview (`AssignmentService.spawnProfile`);
    - the urgent refusal (`TeamMailbox.refuseCooling`);
    - the recovery notes (`LimitOutcomes.processNotes`/`nextNoteAt` over `team_handoff_notes.profile_id`);
    - the process-metrics limit tax (`src/server/metrics/capacity.ts`), which `team-process-metrics` (#189, landed after this change was proposed) reconstructs from `coolingTimeline` per profile.
  - Forwards set `team_messages.excluded_profile`, which `buildCandidates` compares by equality.
  - The driver keeps the reset of the latest rejected `rate_limit_event` but drops its `rateLimitType`, which only the usage parser reads.
  - Usage lives in `UsageLimitStore.profiles` (in memory). The SDK gap-fill claim, the Z.AI pull set and the 10-minute timers are also per profile id. `chat-snapshot.usage` and `chat-usage { profileId, report }` reach sessions through `ChatConnections.subscribesProfile`.
- **Group files.**
  - `parseTaskSettings` (`src/server/team/groupFile.ts`) reads `profile`/`profiles`; setting both rejects the file.
  - `parseProfileEffort` reads `profileEffort`.
  - `parseFlow` map keys match `[A-Za-z0-9][A-Za-z0-9_-]*`, so `zai/glm: 2` fails today.
  - Unknown frontmatter keys are ignored, so older servers ignore `workers` and `modelEffort`.
- **Published rule types.** `src/shared/routing.ts` is copied verbatim as `~/.kawai/routing/kawai-routing.d.ts`. Its shapes are `RouteCandidate.profileId`, `RouteContext.profiles: Record<string, RouteProfileState { usage, limitEvents, cooldownUntil }>`, `RouteGroupProfile`, `LimitEvent.profileId` and `LimitOutcomeContext.profileId`.
- **Account notices** are already keyed by credentials path (`accountNotices.ts`), not by profile. They need no change.
- **Overlapping changes.**
  - `chat-transcript-layout` (archived 2026-10-16) renamed the chat-header requirement this change modifies and rewrote it around wrapping metadata. This change's chat-header delta sits on that renamed text.
  - `codex-chat-sessions` (not started) modifies "Users select a predefined chat profile" and adds its own per-Codex-home fan-out. It is amended to build on this change.
  - `rename-agentboard-to-kawai` (open) restates "Users select a predefined chat profile" with `KAWAI_CHAT_ENV` in place of `AGENTBOARD_CHAT_ENV`, on the pre-provider picker text. Whichever change archives second rebases onto the first, so archiving the rename after this one never reverts the provider grouping (Workflow follow-up).
  - `plan-execution` adds routing requirements in profile ids. Those stay valid, because model keys are profile ids.

## Goals / Non-Goals

**Goals:**
- Resolve providers once, in the catalog, into the same flat per-model entries consumers read today. Code that never asks about the account stays unchanged.
- Use one cooldown function for every reader, and one usage key, the provider.
- Keep stored data, wire fields and published rule fields readable by existing code and rules. Additions only.

**Non-Goals:**
- Renaming any stored, wire, rule or plan field named after profiles, including `PlanRole.profiles`, which is hashed plan content.
- Per-provider credentials. Credentials still come only from the server environment layer (Settings or `AGENTBOARD_CHAT_ENV`) or an operator executable.
- Inferring providers for `profiles.json` entries, by host or otherwise.
- Codex runtimes (`codex-chat-sessions`).
- Changing which source fills a provider's usage bar.
- Checking or refreshing a provider's published model names (follow-up F1 from the #190 review).

## Decisions

### D1. `providers.json` sits beside `profiles.json` at every level

- **Placement and order.** At each catalog level (user, then each project `.kawai/` from `/` down), `providers.json` is read before `profiles.json`. The user level's two files together replace the shipped default when either exists, so any user-level file replaces both shipped files whole. The shipped default is `config/providers.default.json` plus `config/profiles.default.json`: provider `zai` (label Z.AI) holds `glm` and `glm-flash`, with their shared env (the base URL, the four tier maps, the auto-compact window) and the Asia/Shanghai reset zone at the provider level and each model keeping its own label and startup model, and one Claude provider (`claude`) holds `default`, `opus`, `sonnet`, and `haiku` with no env; `profiles.default.json` keeps only `mimo`, `kimi`, and `minimax` in the legacy format. Release builds embed both shipped files the way the embedded shipped catalog embeds the profiles default: the same missing-file fallback and the one shared parser, with errors naming the file plus `(embedded)`.
- **File shape.** Each file is `{ "<provider id>": { label?, env?, limitResetTimeZone?, executable?, models: { "<model key>": { label?, model?, env? } } } }`.
  - Ids and keys use `PROFILE_ID_PATTERN`.
  - Provider `env` takes the same controlled names as today.
  - Model `env` takes those names except `ANTHROPIC_BASE_URL`; setting it fails the file and names the file, provider and model.
  - `executable` stays trusted-files-only and provider-level.
  - `model` (the SDK startup model) is model-level.
  - Credentials stay refused at both levels.
- **Shared levels and stamps.** `profileCatalogLevels(ctx)` returns both files for every level. The group catalog stamp and the outbound destinations stamp therefore cover `providers.json` without their own changes, and a base URL set at the provider level reaches every flattened model entry, so `OutboundDestinations` derives it as a model-provider host exactly like a profile-level one.
- Rejected: one combined file with a format switch. Two names keep every existing file valid with no version field, and an older server simply ignores the new file.

### D2. Merge by provider id and by model key; keys are unique

- **Merge rules.**
  - Providers merge by id with today's rules: the nearest scalar wins, env merges per key, and an empty value neutralizes.
  - A provider's `models` merge by key within it.
  - A model's effective environment is the provider's env overlaid by the model's env.
- **Duplicate keys.** A model key defined under two different providers is a catalog error that names both providers and files.
  - Inside one file, the file fails validation.
  - Across operator levels (the user level and the project levels), the nearer definition is ignored and the farther one stands. Operator files are owner-owned, and re-homing a key between them would silently move its sessions, cooldown and usage to another account.
  - **Shipped keys re-home.** The shipped files are the one base a nearer file may take keys from: a project-level definition of a shipped model key moves it out of its shipped provider, resolving as the nearer entry overlaid on the shipped model's flattened settings — a legacy entry as its own one-model provider. A private-gateway override in a project `profiles.json` (#190's docs place them there) therefore keeps exactly today's launch settings, and only that key leaves the shipped provider. A shipped key no nearer file defines keeps its shipped provider.
- Rejected: the nearer definition wins across operator levels, as with fields. That would let any project file move a user-level model to another account.
- Rejected (shipped keys): ignoring the override with an error — it breaks the private-gateway setup and the promise that existing files keep working unchanged. Also rejected: merging the override into the shipped provider — one key's base URL would silently move its siblings' endpoint.

### D3. `profiles.json` entries read as one-model providers

- **Mapping.** An entry `X` reads as provider `X` holding model `X`.
  - The entry's label is both labels.
  - `model` applies to the model.
  - `env`, `limitResetTimeZone` and `executable` apply to the provider.
- **Interactions.**
  - An entry whose id is a model of a different operator provider is ignored with an error naming both files; an entry whose id is a shipped model key re-homes instead (D2).
  - An entry whose id is an existing provider id merges into that provider like any provider entry.
- **Consequence.** A profiles-only catalog therefore resolves exactly the same entries and launch settings as today, with one provider per profile.
- Rejected: grouping legacy entries by base URL host or by host login. Executables can inject other credentials, and project overlays change URLs per path. One host can therefore front several accounts, and one account several hosts.

### D4. The implicit `default`

- When no file defines model `default`, it is synthesized as model `default` of provider `default`. It joins a `default` provider that a file defines.
- A `providers.json` may define `default` under any provider, for example a host-login provider holding `default`, `opus`, `sonnet` and `haiku`. That provider then shares one cooldown and one usage report across all four.

### D5. Model keys are profile ids; `provider/model` is group-file syntax only

- **Ids unchanged.** These keep holding model keys, with no conversion and no renamed column:
  - `chat_sessions.profile_id` (`claudeProfileId`);
  - `team_spawns.profile_id` and spawn slots `spawn:<key>`;
  - `team_messages.excluded_profile` and the handoff `fromProfile`;
  - `team_handoff_notes.profile_id` and `profile_limit_events.profile_id`;
  - plan roles and rule picks.
- **Qualified names.** `<provider>/<model>` is accepted only in the new group keys `workers` and `modelEffort`. It resolves in `groupCatalog.ts`, against the catalog it already resolves at the groups root.
  - It resolves to the bare key when that provider holds the model. Otherwise it is warned and ignored like an unknown id.
  - A qualified name that resolves to a key already listed is ignored with a warning.
  - `parseFlow` map keys accept one `/` between two id-shaped parts, and list items already pass.
- **Old keys keep their grammar.** A qualified name under `profiles` still rejects the file, and under `profileEffort` still drops the key with a warning, as today. A file valid on an older server therefore stays valid on this one, and vice versa.
- Rejected: `provider/model` as the stored id. It would rewrite stored ids and re-hash plan content, and the human chose unique bare keys, with a second account becoming its own provider whose models need distinct names.

### D6. No runtime field

- Providers carry no `runtime` or `provider` kind. `codex-chat-sessions` adds the runtime later.
- The amendment moves its `provider: "codex"` and `codexHome` to the provider level. Its per-home limit fan-out is then replaced by provider cooldown, and its per-home usage cache by the per-provider usage key.

### D7. Limit events record their provider and window

- **Migration.** One numbered migration (`src/server/dbSafety/migrations.ts`) adds `provider_id TEXT` and `limit_window TEXT`, both nullable, to `profile_limit_events`. It takes the next free version when this change lands: versions are dense, master holds 2–7 today (`process-reports` is 7), and the open changes ahead of this one are expected to claim 8 and 9 first, so this migration is 10 or later — a concurrent branch claiming the same number renumbers on rebase. The baseline is never edited, and `schemaBaselinePin.test.ts` gains the migration's expected delta.
- **Writer.** `ChatSessionManager`'s `onLimitEvent` writes `provider_id` from the session's provider (D10), and the reset zone comes from that provider (D11).
- **Window.** The driver keeps the `rateLimitType` of the latest rejected `rate_limit_event` beside the reset it already keeps (`ChatSessionDriver.limitResetsAt`), and drops both together once past. `limitSignals` carries it into the event as `window`. Gateway errors carry none (`NULL`).
- **Old rows.** Rows written before the migration have `provider_id NULL`.

### D8. One cooldown function

`cooldownUntil(profileId, providerId, events, now)` replaces today's single-profile rule. The relevant events for profile M of provider P are:
- every final event recorded on M itself, whatever its provider or window, so rows from before the migration and model-scoped windows count only here;
- final events of other profiles with `provider_id = P` whose window is not model-scoped.

The calculation:
1. Group the relevant events by window, with `NULL` as one group.
2. The latest event of each group sets that group's end: its reset, else one hour after it.
3. M cools until the latest end still in the future.

The provider's own cooldown applies the same calculation to P's provider-scoped events alone. The provider cooldown is what "the provider is cooling" means in the UI wording and in the rule context.

- `MODEL_SCOPED_WINDOWS` is `seven_day_opus` and `seven_day_sonnet`. Any other or unknown window cools the provider, the conservative default.
- `LimitEventStore` exposes:
  - `forProfile` (unchanged);
  - `forProvider(providerId)`;
  - `cooldownFor(profileId, providerId)`, which returns `{ until, provider: boolean }`, true when the provider's cooldown decides.
- Every reader in Context calls `cooldownFor`. The per-session provider comes from D10. The process-metrics limit tax (`coolingTimeline` in `src/server/metrics/capacity.ts`) reconstructs each profile's cooling intervals from that profile's relevant events — its own plus its provider's provider-scoped ones — the same rule the router applies, so a provider cooldown shows in the limit tax of every profile it covers.
- `team_handoff_notes` resolves the provider of its `from_session` record's project path, falling back to the profile id. The recovery note therefore waits for the model's effective cooldown.
- Rejected: "latest event wins" across windows. A short window's later event would release a model whose weekly window is still exhausted.
- Rejected: the maximum over all events. One misread reset would keep a profile cooling for the whole retention.

### D9. Forwards skip the limited provider while it cools

- **Candidates.** `excluded_profile` keeps naming the limited model. `buildCandidates` also excludes every candidate whose provider is the excluded model's provider while that provider cools (D8 `provider: true`), whether it is a member or a spawn slot. The exclusion is a hard filter, so a rule cannot pick it.
- **Session targets.** The same check extends `LimitOutcomes.forward`'s refusal of a session target to sessions on any model of a cooling provider. That covers `forwardTo: <session>` and the human Hand off.
- **No new column.** The provider is derived from the excluded model at read time.
- **Model-scoped limits.** A model-scoped limit excludes only the model, so a forward from `opus` may go to `sonnet`.

### D10. Sessions resolve their provider through the catalog; usage is keyed by provider

- **Provider lookup.** A session's provider is resolved from the catalog at its project path, like its launch settings, and cached per catalog stamp. The cache is the same lookup `launchEnvOf` does. A profile no longer in the catalog stands in as its own provider.
- **Usage store.**
  - `UsageLimitStore` keys `get`, `record`, `recordNoData` and `claimPull` by provider id.
  - The SDK gap-fill claim is once per provider.
  - The Z.AI pull set, its suppression of the host-login pull, and its timers move from profile to provider.
  - `hasLiveSessionOf(providerId)` counts non-archived sessions on any model of the provider that have a driver.
  - The refresh resolves its base URL and credentials from such a live session, rather than from the first record of a profile, archived or not.
- **Wire.**
  - `chat-snapshot.usage` carries the session's provider's report.
  - `ChatConnections.publishUsage(providerId, report)` sends each subscribed session of that provider `chat-usage { profileId, providerId, report }`, with `profileId` being that session's model. `providerId` is additive.
  - The client keeps keying `usage` by profile id, so an older client still renders it.
- Rejected: a `provider_id` column on `chat_sessions`. Membership is the owner's catalog choice, and a stored copy would drift from it after an edit.

### D11. `limitResetTimeZone` is provider-level

The flattened model entry carries its provider's zone, so `profileLimitResetTimeZone` and `withTextReset` are unchanged. A legacy entry's zone is its provider's.

### D12. Group keys `workers` and `modelEffort`

- **Aliases.** `workers` is parsed by the same code as `profiles`, in the same list and capped-map forms with the same validation. `modelEffort` is parsed by the same code as `profileEffort`.
- **Precedence.** When `workers` is set, `profiles` and `profile` are ignored with one warning per key. In that case setting both `profile` and `profiles` no longer rejects the file, because neither is read. When `modelEffort` is set, `profileEffort` is ignored with a warning.
- **Same field.** The parsed `GroupDefinition` keeps `profiles` and `profileEffort`, and every reader stays as is.
- Rejected: making both spellings an error, as `profile` with `profiles` is today. During the switch an owner can keep the old key for an older server and add the new one for this server. The only cost is the warning.

### D13. UI

- **Profiles API.** `GET /api/chat/profiles` entries (`ClaudeProfileMetadata`) gain `providerId` and `providerLabel` additively, in catalog order: the provider holding `default` first, then providers in file order, each with its models in order.
- **Picker.** The New Session picker renders each provider with two or more models, or with a label different from its single model's, as an `<optgroup>`. A one-model provider whose labels are equal stays a plain option, so a profiles-only catalog looks as it does today.
- **Header.** The chat header (`ChatView` to `ChatHeader`) shows `providerLabel · label`, or one label when they are equal, before the reported model. It uses the same catalog view it already fetches. `Session` gains no field.
- **Members.** The Members tab's and groups route's per-profile rows (`TeamMemberProfile`, `TeamGroupSummary.profiles`) gain `providerId` and `providerLabel`. `TeamMembersPanel` lists workers under their provider and labels the row "Workers".
- **Usage bar.** The `UsageBar` is unchanged. Its report already states its source, and naming a provider there would mislead for gateway providers whose bar shows the host login's plan.

### D14. Rule types (additive)

`src/shared/routing.ts` gains these fields:
- `providerId` on `RouteCandidate`, `RouteGroupProfile`, `RouteProfileState` and `LimitOutcomeContext`;
- `providerId: string | null` and `window: string | null` on `LimitEvent`;
- `RouteContext.providers: Record<string, RouteProviderState { label, profiles, usage, limitEvents, cooldownUntil }>`, covering the providers of the context's profiles.

Existing fields keep their meaning with two refinements:
- `RouteProfileState.cooldownUntil` becomes the profile's effective cooldown (D8), so an existing rule that skips cooling profiles also skips a cooling provider's models;
- `RouteProfileState.usage` is the provider's report.

`docs/routing/devs.example.ts` keeps working unchanged. The docs show `ctx.providers`.

### D15. Wording names the provider when its cooldown decides

- **Waiting reasons.** The `profile-cooling` constraint gains an optional `provider` detail. `waitingLabels` reads "Recipient's provider Z.AI is cooling until …" when the provider's cooldown decides, and keeps today's text otherwise.
- **Urgent refusal.** The refusal reads "Session … runs on profile glm-flash of provider zai, which is cooling down after a provider limit until …".
- **Decision log and hand-off note.** Both name the provider in the same case.
- **Unchanged.** Parked labels keep naming the limited profile.

## Risks / Trade-offs

- [A provider with per-model quotas the code does not know cools as a whole] → `MODEL_SCOPED_WINDOWS` covers Claude's per-model weeklies. For any other split quota, the owner defines separate providers.
- [A model-scoped window cools only the recording profile, not another profile on the same underlying model (for example `default` running Opus)] → That other profile records its own event the first time it is refused. That costs one failed turn, which beats cooling the whole provider for days.
- [Moving entries into `providers.json` turns existing project-level `profiles.json` entries for those ids into ignored entries with errors] → The migration plan converts them into a `providers.json` overlay. The errors name both files.
- [A project-level provider overlay that changes the base URL makes one provider id mean two endpoints] → This already holds for profiles today. The overlay remains the owner's explicit choice.
- [A group switched to `workers` alone is read by an older server as having no profiles and spawns on `default`] → Switch only after the live server reads the new keys, or keep the old key beside the new one during the switch (D12).
- [Rollback after the migration] → Under database safety, an older build refuses the migrated database. Rollback means restoring the `pre-migration-<n>` backup (`docs/operations/database-backups.md`), which loses later writes. This holds for every migration.
- [Catalog resolution on hot paths] → The provider lookup is cached per catalog stamp, the same stamp the group catalog uses.

## Migration Plan

1. **Land and deploy.** Land the change and update the live build. The migration runs at start after its backup. Nothing else changes until the owner edits a file: a user-level `profiles.json` resolves as before, and with no user-level file the shipped default now resolves as grouped providers — the Z.AI pair under `zai` and the four Claude profiles under `claude` — with every launch setting unchanged.
2. **Group accounts.** To share an account's cooldown and usage, write `~/.kawai/providers.json`. At the user level it replaces the shipped default together with any `~/.kawai/profiles.json`, so it must hold every provider in use. A reserved-name example:

   ```json
   {
     "zai": {
       "label": "Z.AI",
       "limitResetTimeZone": "Asia/Shanghai",
       "env": { "ANTHROPIC_BASE_URL": "https://zai.example.internal/api/anthropic" },
       "models": {
         "glm": { "label": "GLM", "model": "opus" },
         "glm-flash": { "label": "GLM Flash", "model": "sonnet" }
       }
     },
     "claude": {
       "label": "Claude",
       "models": { "default": { "label": "Default" }, "haiku": { "label": "Haiku", "model": "haiku" } }
     }
   }
   ```

3. **Convert project overrides.** Project-level `.kawai/profiles.json` entries for ids now held by a provider become a `.kawai/providers.json` overlay: provider-wide settings under the provider, model settings under the model. Then check the catalog errors in the New Session dialog.
4. **Switch group keys.** After the live server runs this build, switch group files to `workers` and `modelEffort`, or add them beside the old keys first.
5. **Rollback.** Remove `providers.json` files to return to per-profile accounts. Code rollback follows the database-safety restore procedure.

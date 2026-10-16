# Tasks

## 1. Provider catalog

- [ ] 1.1 Parse and validate `providers.json` in `src/server/chat/profileCatalog.ts` (design D1). This covers provider and model shapes, id patterns, the model-level base-URL refusal naming the file, provider, and model, the provider-only `executable` in trusted files, and the credential refusal at both levels. Have `profileCatalogLevels` return both files per level, `providers.json` first. Verify new `profileCatalog.test.ts` cases for each validation rule and for "Model-level base URL is refused".
- [ ] 1.2 Merge providers by id and models by key (D2), read `profiles.json` entries as one-model providers (D3), and synthesize the implicit `default` (D4). `resolveProfileCatalog` should keep returning the flat per-model `profiles` map, with each entry's effective env, model, executable, and reset zone, plus `providerId`. It should also return a `providers` map of labels and model keys in catalog order. Verify `profileCatalog.test.ts` covers every scenario of the `claude-session-profiles` delta. A profiles-only fixture must resolve deep-equal to master's output, apart from the added `providerId` fields.
- [ ] 1.3 Add the cached provider lookup `providerOf(profileId, ctx)` (D10), keyed by the catalog stamp, where a profile that is no longer in the catalog stands in as its own provider. Verify unit tests for a provider hit, the unknown-profile fallback, and cache invalidation when either catalog file changes.
- [ ] 1.4 Document the `providers.json` format, the merge and uniqueness rules, legacy reading, and the design's Migration Plan in `docs/claude-session-profiles.md`, using only reserved example names. Verify the documented example passes `resolveProfileCatalog` in a test that loads it from the doc's fenced block.

## 2. Picker and header

- [ ] 2.1 Add `providerId` and `providerLabel` to `GET /api/chat/profiles` entries (`ClaudeProfiles.ts`, `ClaudeProfileMetadata`), in D13 order. Verify `claudeProfileRoutes.test.ts` and `claudeProfiles.test.ts` assert the fields and the order, and that the response still carries no env, base URL, or executable.
- [ ] 2.2 Group models under `<optgroup>` per provider in `NewSessionModal.tsx`, keeping a one-model provider with equal labels as a plain option (D13). Verify `newSessionModal.test.tsx` covers "Models are grouped by provider" and an unchanged profiles-only picker. Update `tests/e2e/chat-profiles.spec.ts` if its picker assertions change, and run only that fixture spec on a spare `E2E_PORT` after `bun run build`.
- [ ] 2.3 Show the provider and model labels in the chat header (`ChatView.tsx` to `ChatHeader.tsx`), with one label when they are equal and the reported model after them. Verify `chatHeader.test.tsx` and `chatHeaderIntegration.test.tsx` cover "Provider and model labels" and "Live session identity".

## 3. Group keys and the Members tab

- [ ] 3.1 Parse `workers` and `modelEffort` in `src/server/team/groupFile.ts` (D12). The new key wins with one warning per ignored old key, and `profile` together with `profiles` is not an error while `workers` is set. Let `parseFlow` map keys take one `/` between id-shaped parts, while the old keys keep their grammar (D5). Verify `teamGroupFile.test.ts` covers "Workers map", "Old and new keys together", "Both spellings are set", and an old-key file parsing exactly as before.
- [ ] 3.2 Resolve `<provider>/<model>` names in `groupCatalog.ts` against the catalog already resolved there. A wrong provider is warned and ignored, and a resolved duplicate is warned and ignored. Verify `teamGroupCatalog.test.ts` covers "Qualified names", "Qualifier names the wrong provider", "A qualified key", "A qualifier naming the wrong provider", and the duplicate case.
- [ ] 3.3 Add `providerId` and `providerLabel` to `TeamGroupSummary.profiles` (`routes/teamGroups.ts`) and `TeamMemberProfile` (`workspaceRead.ts`), and list workers under their provider in `TeamMembersPanel.tsx`. Verify `teamWorkspaceRead.test.ts` and `teamMembersPanel.test.tsx` cover "Workers are grouped by provider" and the existing Members scenarios.
- [ ] 3.4 Document `workers`, `modelEffort`, qualified names, precedence, and the switch-over advice in `docs/routing/README.md` (Group settings) and the group-settings and Members bullets of `AGENTS.md`. Verify the README's YAML example parses through `parseTaskSettings` in a test.

## 4. Provider cooldown

- [ ] 4.1 Add the numbered migration that adds nullable `provider_id` and `limit_window` to `profile_limit_events` (D7), taking the next free version at landing. Verify `schemaBaselinePin.test.ts` gains the migration's expected delta and a migration test opens a pre-migration database and finds old rows intact with `NULL` in both columns.
- [ ] 4.2 Keep the latest rejected `rate_limit_event`'s `rateLimitType` beside its reset in `ChatSessionDriver`, carry it through `limitSignals.ts` as the event's window, and write `provider_id` and the provider's reset zone in `ChatSessionManager.onLimitEvent`. Verify `limitSignals.test.ts` and `chatSessionManager.test.ts` cover "Final rate-limit failure", "Reset written in the error text", and "Window recorded".
- [ ] 4.3 Implement `cooldownFor(profileId, providerId)` and `forProvider` in `limitEvents.ts` with the D8 rules: per-window latest end, `MODEL_SCOPED_WINDOWS`, and own events including rows from before the migration. Verify `limitEvents.test.ts` covers "Only the limited profile cools", "Profiles of one provider cool together", "A model-scoped window cools one profile", "Events recorded before providers", "Transient retry", and a short later window that does not release an exhausted weekly window.
- [ ] 4.4 Route every cooldown reader through `cooldownFor`: the recipient snapshot (`sessionMailbox.ts`), the dispatcher and `memberCauses.ts`, the router's `profileStates`, `builtinPick`, the `all-profiles-cooling` hold, `AssignmentService.spawnProfile`, and the recovery notes in `limitOutcomes.ts`. Verify `teamDispatcher.test.ts`, `routingRouter.test.ts`, `teamAssignmentService.test.ts`, and `limitOutcomes.test.ts` cases where a sibling model's limit cools routing, preview, and the note. Also add a `teamRouting.integration.test.ts` case where a `glm` final event keeps `juniors` mail off `glm-flash`.
- [ ] 4.5 Exclude a cooling provider's models from limit forwards in `buildCandidates` and in `LimitOutcomes.forward`'s session-target refusal (D9). Verify `routingCandidates.test.ts` and `limitOutcomes.test.ts` cover "Handoff received", a model-scoped forward from `opus` reaching `sonnet`, and a refused Hand off to a `glm-flash` session while `zai` cools.
- [ ] 4.6 Name the provider when its cooldown decides (D15) in the `profile-cooling` constraint and `waitingLabels.ts`, the urgent refusal in `TeamMailbox.ts`, the decision log, and the hand-off note. Verify `waitingLabels.test.ts`, `teamMailbox.test.tsx`, and a `TeamMailbox` server test cover "Refused urgent mail" and "Refused for a cooling provider".
- [ ] 4.7 Update the Limits section of `docs/routing/README.md` and the Limits bullet of `AGENTS.md` for provider cooldown, windows, and forwards. Verify by review against the `profile-limit-handling` delta.

## 5. Provider usage

- [ ] 5.1 Key `UsageLimitStore` by provider (`usageLimits.ts`) and look up each session's provider through `providerOf` in the snapshot, the push callbacks, and the SDK gap-fill claim, so the claim runs once per provider. Verify `usageLimits.test.ts` and `chatSessionManager.test.ts` cover "Profiles share a provider", "One pull per provider", and the existing per-profile scenarios.
- [ ] 5.2 Move the Z.AI pull set, host-login suppression, and refresh timers to provider keys. Count live sessions on any of the provider's models, and resolve the refresh target from a live session. Verify `zaiUsage.test.ts` and `chatSessionManager.test.ts` cover "Shared plan pulled once", "A session on another profile keeps it fresh", "Pulls stop without live sessions", and "Shutdown stops refreshes".
- [ ] 5.3 Fan `chat-usage` out per subscribed session of the provider, carrying the session's `profileId` plus additive `providerId` (`ChatConnections.ts`, `src/shared/types.ts`). Verify `chatConnections.test.ts` covers "Live update during a turn" for two models of one provider, and that `chatStore.test.ts` still applies the message by profile id.
- [ ] 5.4 Update the usage bullet of `AGENTS.md` for per-provider reports and pulls. Verify by review against the `chat-usage-limits` delta.

## 6. Rule context

- [ ] 6.1 Add the D14 fields to `src/shared/routing.ts` and build `ctx.providers` and each profile's effective `cooldownUntil` in the router. Verify `routingContract.test.ts` and `routingRouter.test.ts` cover "A rule sees the cooling provider", and `routingRules.test.ts` shows `docs/routing/devs.example.ts` loading and routing unchanged ("Earlier rules keep working").
- [ ] 6.2 Document `ctx.providers` and the effective per-profile cooldown in the Routing rules section of `docs/routing/README.md`. Verify the published `kawai-routing.d.ts` copy matches `src/shared/routing.ts` in the existing rule-types test.

## 7. Integration

- [ ] 7.1 Run `bun run lint && bun run typecheck && bun run test` on the final head, and `openspec validate providers-and-workers --strict`. Verify all four pass. The only allowed validator note is the expected archive-order info for `chat-header` until `chat-transcript-layout` is archived.

## Workflow follow-up

- Archive `chat-transcript-layout` before archiving this change. This change's chat-header delta modifies that change's renamed requirement.
- Amend `codex-chat-sessions` to build on providers (design D6), rebasing its MODIFIED "Users select a predefined chat profile" onto this change's text.
- After merge, the owner moves accounts into `providers.json` following the design's Migration Plan, and switches group files to `workers` and `modelEffort` only after the live server runs this build.
- Archive this change after review and merge, and check that `openspec validate --specs --strict` is no worse than on master.

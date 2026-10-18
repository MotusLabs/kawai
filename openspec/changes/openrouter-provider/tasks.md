# Tasks

Start only once `providers-and-workers` sections 4 (provider cooldown) and 5 (per-provider usage) are on master. Rebase onto that master first, and confirm `cooldownFor`, `limit_window` and the per-provider `UsageLimitStore` exist.

## 1. Credentials and catalog

- [x] 1.1 Verify the auth precedence first (design Risks). With the host `CLAUDE_CONFIG_DIR` and its claude.ai login present, run one Claude Code turn with `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` set to a capped inference key, and `ANTHROPIC_API_KEY=""` and `CLAUDE_CODE_OAUTH_TOKEN=""`. Confirm the turn succeeds and `/api/v1/key` usage grows. Record the result in design.md D3. If the login wins, amend D3 with the per-provider `CLAUDE_CONFIG_DIR` before continuing.
- [x] 1.2 Parse `authTokenEnv` and `balanceKeyEnv` on providers in `catalogParse.ts`. Accept them only in shipped and user-level `providers.json`, with the env-identifier pattern. Reject them in project files and in any `profiles.json`, naming the file and field. Add `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to `PROFILE_CONTROLLED_ENV`. Verify `profileCatalog.test.ts` cases for each scenario of "Trusted providers may name their credential variables" and "Catalogs may cap the output reservation".
- [x] 1.3 Refuse a project-level file that sets `ANTHROPIC_BASE_URL` on a provider that has a trusted credential variable (design D2), while model-mapping overlays still apply. Verify tests for both scenarios of "A credentialed provider's route comes only from trusted catalogs", plus a key-order-independence case like `providers-and-workers`' two-pass rule.
- [x] 1.4 Implement withholding and injection (design D3): add `withheldCredentialNames(catalog)` in `chatProviderEnv.ts`. Make `resolveClaudeProfile` always return an explicit, filtered `env`, including no-override defaults and executable-backed profiles. For credentialed providers, set `ANTHROPIC_AUTH_TOKEN` from the named variable and blank `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` in both the env and `settings.env`. Use the same resolution in the availability probe. Verify `claudeProfiles.test.ts` covers every scenario of "Named credential variables are withheld from every agent", and that `bun scripts/verify-claude-profile-settings.ts`, extended with a credentialed loopback provider, shows the bearer token reaching the mock gateway and no `x-api-key`.
- [x] 1.5 Gate auth for credentialed providers on their own variable (design D4) in `ChatSessionManager.authOk` and `chatAuth.ts`, with a refusal naming the provider and variable. Skip account notices for these sessions. Verify `chatSessionManager.test.ts` cases for "Key variable missing" with a host login present, and "No login-expiry notice".
- [x] 1.6 Add the `openrouter` provider to `config/providers.default.json` (design D5). Document `authTokenEnv`, `balanceKeyEnv`, the trust and withholding rules, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the inference-versus-management key split, and the user-level copy of the entry in `docs/claude-session-profiles.md`. Update the AGENTS.md profiles wording on credentials. Verify that `shippedCatalog.test.ts` resolves the three models to provider `openrouter` with the listed mappings, and that a test loads the doc's user-level fenced block through `resolveProfileCatalog`.

## 2. OpenRouter usage

- [ ] 2.1 Add `src/server/chat/openRouterUsage.ts`: strict-shape parsers for `/api/v1/key` and `/api/v1/credits` responses into a `ChatUsageReport` with meters, labels, periods, status and `remainingUsd`, per design D6. Use the spike's captured shapes as fixtures, with the key value removed. Verify unit tests for every scenario of "An OpenRouter key's caps and budgets render as meters", "Account credits render when a balance key is configured", and "An exhausted OpenRouter meter reports a limited status", plus malformed bodies recording no data.
- [ ] 2.2 Select the adapter by base URL host in the manager's provider pull (an `openrouter.ai` host never probes Z.AI and keeps the host-login pull suppressed). Read the session's effective token for `/key` and the server-side `balanceKeyEnv` value for `/credits`. Log refusals without key material. Verify `chatSessionManager.test.ts` with an injected fetch: one `/key` request and no quota request for "OpenRouter session starts", "Key refused" keeping the SDK pull suppressed, and a 403 from credits dropping only that meter. Also verify that the logged text contains no key.
- [ ] 2.3 Schedule the extra pull after a turn carrying `providerCostUsd`: 30 s later, at most once per provider per minute. Verify a fake-timer test for "Several quick turns", anchored on `Date.now()` per the CI Bun 1.3 rule.
- [ ] 2.4 Update the usage bullet of AGENTS.md and the usage section of `docs/claude-session-profiles.md` for the OpenRouter source. Verify by review against the `chat-usage-limits` delta.

## 3. Credit limits

- [ ] 3.1 Treat HTTP 402 as a final limit in `limitSignals.ts` (`assistantLimitSignal` and `retryLimitSignal`), whatever the class. Record it with `limit_window = 'credit'` and no reset. Verify `limitSignals.test.ts` with the spike's exact assistant frame (`error: "unknown"`, `API Error: 402 This request requires more credits…`), plus a `billing_error` 402 case.
- [ ] 3.2 Implement the bounded credit cooldown in the provider cooldown (design D8): the one-hour rule, plus an in-memory early end fed by OpenRouter usage reports' `remainingUsd`. Verify `limitEvents` and cooldown tests for "Owner tops up", "No balance source", and "Restart during a credit cooldown" (a fresh store applies only the hour).
- [ ] 3.3 Make limit outcomes take `otherwise` for credit events, and make the waiting reason, `waitingLabels.ts`, and the urgent-mail refusal say "out of credit" with the latest end. Verify `limitOutcomes.test.ts` for "Group parks short resets" (forwarded, never parked, forward excludes `openrouter`) and a `TeamMailService` refusal test for "Urgent mail to a member out of credit".
- [ ] 3.4 Update the Limits bullet of AGENTS.md and the Limits section of `docs/routing/README.md` for 402 credit limits. Verify by review against the `profile-limit-handling` delta.

## 4. Provider-reported turn cost

- [ ] 4.1 Sum `message_delta.usage.cost` over a turn's `stream_event` frames in `ChatSessionDriver`, and emit `providerCostUsd` on `turn_completed` when any was present (additive in `src/shared/chat.ts`). Verify `chatSessionDriver.test.ts` with the spike's frames: the sum is 0.001064075 against `total_cost_usd` 0.042563, and a turn with no cost field has no `providerCostUsd`.
- [ ] 4.2 Show `providerCostUsd` in `ChatMessages.tsx`'s completion summary in place of the estimate, with the provider-reported hover text. Verify a client test for "OpenRouter turn" and "Provider without reported cost".

## 5. Integration

- [ ] 5.1 Run `bun run lint && bun run typecheck && bun run test` on the final head, and `openspec validate openrouter-provider --strict`. Verify all pass.
- [ ] 5.2 Do a live check with a capped inference key in `OPENROUTER_API_KEY` and a management key in `OPENROUTER_MANAGEMENT_KEY`. An `openrouter-haiku` chat completes a turn; the usage bar shows the key cap and credits meters; the completion summary shows the provider-reported cost; a Bash tool `env` in an `openrouter` and in a GLM session shows neither key variable. Spending the cap records a `credit` event and cools `openrouter`. Delete the test key afterwards. Verify by recording the observations in the PR description, with no key material.

## Workflow follow-up

- Archive after review, once `providers-and-workers` has been archived first, so that this change's ADDED requirements sit beside its rewritten texts.

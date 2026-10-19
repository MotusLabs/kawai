# Proposal

## Why

OpenRouter serves Claude models, and others, through an Anthropic-compatible endpoint on prepaid credits. Kawai cannot run it safely today. A spike on 2026-10-18, with a temporary capped key that has since been deleted, showed four gaps:

- **Credentials are global.** OpenRouter needs its own bearer key in `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY` explicitly empty. Catalog files may not carry credentials, so the only way in is the server environment. From there the key reaches every profile's gateway, and any server `ANTHROPIC_API_KEY` reaches OpenRouter as `x-api-key`.
- **The usage bar would mislead.** OpenRouter has no Z.AI quota endpoint, so the bar falls back to the host claude.ai login and shows the Claude plan for OpenRouter sessions. The real figures exist:
  - `GET /api/v1/key` with the session's inference key returns the key's cap, its budgets, and its remaining credit.
  - `GET /api/v1/credits` returns the account balance, but only to a management key, which also refuses inference.
- **Running out of credit goes unnoticed.** Through Claude Code, an OpenRouter 402 arrives as an assistant message with `error: "unknown"` and the text `API Error: 402 …`. `limitSignals.ts` counts only `rate_limit`, `billing_error`, `overloaded` and 429, so no limit is recorded and routing keeps choosing a provider that cannot pay. The 402 also fires while some balance remains, whenever the remaining credit cannot cover the requested output reservation ("can only afford 9957" of 32000 tokens).
- **The turn cost shown is wrong.** "Turn complete · $…" shows the SDK's `total_cost_usd`, which Claude Code estimates from Anthropic list prices. It read $0.0426 for a turn OpenRouter charged $0.00106. OpenRouter's real charge (`usage.cost`) does reach kawai, on the stream's `message_delta`.

## What Changes

- **A per-provider credential, by reference.**
  - A provider in a trusted catalog (the user level or the shipped default) may name the server environment variable that holds its key (`authTokenEnv`). Its sessions get that value as `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` blanked.
  - Every variable a catalog names as a credential is removed from every agent's environment, including executable-backed launches.
  - A project-level file can neither name a credential variable nor change the base URL of a provider that has one; an empty value counts as a change. Agents can write those files, and either edit could send a server secret to a URL an agent chose.
  - Every launch that receives the key pins the provider's base URL, and the proxy and TLS variables, in the flag settings layer, so Claude settings files cannot redirect it either. A credentialed provider must have a trusted base URL and cannot name an `executable`.
  - The catalog file itself still holds no secret.
- **A server-only balance credential.** A trusted provider may name a second variable (`balanceKeyEnv`). Only the server uses it, to read the account balance, and no agent ever receives it.
- **Shipped `openrouter` provider.** It points at `https://openrouter.ai/api`, reads its key from `OPENROUTER_API_KEY` and its balance key from `OPENROUTER_MANAGEMENT_KEY`, and ships models `openrouter-opus`, `openrouter-sonnet` and `openrouter-haiku`, mapped to OpenRouter's `~anthropic/…-latest` slugs. A session cannot start while its key variable is unset; the refusal names the variable.
- **An optional output reservation cap.** Catalog `env` accepts `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, so the owner can lower the per-request reservation a prepaid balance must cover.
- **OpenRouter usage on the usage bar.** For a provider whose base URL is on `openrouter.ai`, the server pulls `/api/v1/key` instead of probing the Z.AI endpoint, and suppresses the host-login pull.
  - The key's cap and each budget become meters. A budget with a known reset interval gets its period; a one-off cap gets no period.
  - With a balance key, the account's credits become one more meter.
  - Pulls run once per provider, refresh on the existing cadence, and also refresh shortly after a turn that reported a cost.
- **Out-of-credit is a limit.** In a Claude Code session, any final failure with HTTP status 402 is recorded as a final limit event in a `credit` window, whatever the error class. Codex sessions keep `codex-chat-sessions`' limit rules.
  - It cools the whole provider with no reset time, so limit outcomes never park delivered work on it and take the group's `otherwise` branch (forward or release).
  - The cooldown lasts the existing one-hour fallback used when no reset is known, and ends earlier once a usage pull shows that remaining credit has grown since the event (a top-up, or a raised cap): that pull's time becomes the event's known reset.
- **The provider-reported turn cost.** When a turn's stream reported `usage.cost`, `turn_completed` carries the sum, and the transcript shows it as the turn's cost instead of the SDK estimate.
- **Not changed:**
  - `chat_turn_usage` and process metrics stay tokens-only.
  - No new database migration: the `credit` window uses the `limit_window` column that `providers-and-workers` adds.
  - MiMo pay-as-you-go has no balance API (only its console shows the balance), so MiMo gets no usage bar from this change.
  - LiteLLM is not adopted. It meters its own traffic and never reads a provider's balance.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `claude-session-profiles`: providers may name a credential variable and a balance variable, both withheld from agents; a credentialed provider's routing comes only from trusted catalogs and its base URL is pinned on every launch that carries the key; the shipped `openrouter` provider; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` joins the controlled variables.
- `chat-usage-limits`: the OpenRouter key and credits pull, its meters, its refresh cadence, and refresh after costed turns. Three existing requirements are modified: the quota-endpoint pull, the on-demand refresh, and per-provider report keeping. A provider whose own usage endpoint is selected is never probed at the quota endpoint and never falls back to the host login.
- `profile-limit-handling`: in a Claude Code session, a 402 is a final `credit` limit with no reset, cooling the provider until credit returns.
- `chat-sessions`: a turn's completion cost is the provider-reported charge when one was streamed.

## Impact

- **Depends on `providers-and-workers`.** This change needs its provider-level cooldown (section 4) and its per-provider usage store (section 5). Section 4 landed in #219. Section 5 is still pending, and implementation waits for it.
- **Archive order:** `process-observability`, then `providers-and-workers`, then this change. Both of those changes MODIFY the `chat-usage-limits` requirements that this change also MODIFIES: "Usage is refreshed when no report has arrived" and "Provider plan usage is pulled from the provider quota endpoint". This change's blocks restate the text the two produce together, with a carve-out for providers whose own usage endpoint is selected. Archiving it earlier would lose their wording.
- **Code:**
  - `src/server/chat/catalogParse.ts` and `profileCatalog.ts`: new provider fields, trust rules, the controlled variable.
  - `ClaudeProfiles.ts` and `chatProviderEnv.ts`: credential injection and withholding.
  - `chatAuth.ts`: the missing-key refusal.
  - A new `src/server/chat/openRouterUsage.ts` beside `zaiUsage.ts`, plus `usageLimits.ts` and `ChatSessionManager.ts` for pull selection and refresh.
  - `limitSignals.ts` and the limit-event cooldown for `credit`.
  - `ChatSessionDriver.ts` for summing streamed cost; `src/shared/chat.ts` for an additive `providerCostUsd`; `ChatMessages.tsx` for display.
  - `config/providers.default.json`, `docs/claude-session-profiles.md`, and the AGENTS.md profile, usage and limits bullets.
- **Configuration:** the owner puts an OpenRouter inference key in `OPENROUTER_API_KEY` and, optionally, a management key in `OPENROUTER_MANAGEMENT_KEY` in the server environment. A cap or budget on the inference key makes the bar show a meter. Nothing changes for existing profiles.
- **Security:** the management key can create and delete keys. It stays in the server process and is used only for the credits request. The audit's model-provider set already includes `openrouter.ai`, because it derives from base URLs.
- **Compatibility:**
  - Older servers reject the new provider fields, and with them the whole file. Use the shipped provider, or add the fields only after the live server reads them.
  - Older clients ignore `providerCostUsd` and keep showing the SDK estimate.

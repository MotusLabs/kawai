# Proposal

## Why

A profile is one account and one model in a single entry, so every fact that belongs to the account is kept per profile:
- **Cooldown.** When GLM hits the Z.AI plan limit, GLM Flash on the same plan still looks available. Routing keeps sending work to GLM Flash, and a limit forward from GLM can land there and fail the same way.
- **Usage.** Each profile pulls and shows the same plan quota on its own.
- **Reset time zone.** It is repeated on every profile of the account.

Kawai cannot tell that two profiles share an account. The lead's instructions carry a manual rule instead ("another profile on the same exhausted account is not a workaround"), and the planned `codex-chat-sessions` change patches the same gap again for Codex logins.

The vocabulary hides this shape as well. Groups list "profiles" when they mean the kinds of worker they run: a model, from a provider, at an effort. On 2026-10-16 the human asked for providers that own models, groups that name their workers with effort per model, and limits and usage that move to the provider in the same change.

## What Changes

- **Providers own models.** A new catalog file, `providers.json`, is read at the same levels as `profiles.json`: the user level `~/.kawai/`, then `.kawai/` directories from the filesystem root down to the project path.
  - A provider holds what belongs to the account: a label, its routing environment and model slots, its reset time zone, and an executable (operator-owned files only).
  - It lists its models. Each has a key, a label, the model it starts on, and optional model settings such as the compaction window.
  - The base URL belongs to the provider alone, so all of a provider's models reach the same endpoint.
- **A model's key is its profile id.** Model keys are unique across all providers. Sessions, group files, plans, routing rules and limit records keep storing the same ids, which now name models, so nothing stored is converted.
  - A key defined under two providers is a catalog error naming both.
  - Under the new group keys, group files may also write `provider/model`, which kawai checks against the catalog.
- **`profiles.json` keeps working.** Each entry reads as a provider with one model of the same id, so a catalog without `providers.json` behaves exactly as today: one account per profile. An entry whose id is already a model of another provider is refused with an error naming both files.
- **New group keys.** `workers` is the new name of `profiles`, and `modelEffort` of `profileEffort`. The old keys keep working. When a file sets both spellings of one key, the new one wins and the group shows a warning.
- **Cooldown belongs to the provider.**
  - A final limit event cools every model of its provider, in every group of every team.
  - Claude's weekly windows that are scoped to one model (`seven_day_opus`, `seven_day_sonnet`) cool only the model that hit them.
  - Routing, spawning, limit forwards, the urgent-mail refusal, waiting reasons and the recovery note all read this one cooldown.
  - Limit events record their provider and window, through one database migration that adds two nullable columns.
- **Usage belongs to the provider.** Kawai keeps one usage report per provider, and sessions on any of its models show it. The pull made when no report has arrived, and the quota-endpoint pull with its refresh, run once per provider.
- **UI.**
  - The New Session dialog lists models grouped under their providers.
  - The chat header names the provider and the model.
  - The Members tab groups each group's workers by provider.
  - Routing rules also see each candidate's provider, through additive fields.
- **Not changed:**
  - which source fills a provider's usage bar;
  - login-expiry notices, which already follow the environment a session's agent receives, and so match across a provider's models;
  - database columns, wire fields, published rule fields and plan content fields named after profiles;
  - "group" in tools and protocol (no "Role" wording);
  - credentials, which still never enter catalog files.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `claude-session-profiles`: providers with models, unique model keys used as profile ids, `profiles.json` entries read as one-model providers, and the picker grouped by provider.
- `profile-limit-handling`: limit events record their provider and window; cooldown covers the provider, or one model for a model-scoped window; forwards and the urgent-mail refusal follow it.
- `chat-usage-limits`: usage reports, pulls and refreshes are kept per provider.
- `team-routing-rules`: `workers` names a group's allowed models, also as `provider/model`; rules see each candidate's provider and its cooldown.
- `agent-teams`: `modelEffort` names effort per model.
- `team-workspace`: the Members tab groups workers by provider.
- `chat-header`: the header names the provider and the model.

## Impact

- **Code and tests:** see design.md for the full list. The main areas are:
  - the catalog (`src/server/chat/profileCatalog.ts`) and session launch;
  - the profile picker, the chat header and the Members tab;
  - group-file parsing (`src/server/team/groupFile.ts`);
  - limit recording and cooldown readers;
  - the usage store and its pulls;
  - the published routing types (`src/shared/routing.ts`, additive only).
- **Database:** one migration adds nullable `provider_id` and `limit_window` columns to `profile_limit_events`. It takes the next free number when this lands: 5, if `plan-validation` takes 3 and `execution-safety-recovery` takes 4 first. Rows written before it keep today's per-profile cooldown until they age out after 24 hours.
- **Configuration:** existing files keep working unchanged. To share an account's cooldown and usage, the owner moves its entries into `providers.json`; design.md gives the steps.
- **Compatibility:** older servers ignore `providers.json` and the new group keys. A group file should switch to `workers` and `modelEffort` only after the live server reads them; until then an older server would ignore `workers` and spawn members on the default profile. During the switch a file may keep the old key beside the new one: this server reads the new key and warns that the old one is ignored.
- **`chat-transcript-layout` (complete, not archived):** it renames the chat-header requirement this change modifies, so it must be archived first.
- **`codex-chat-sessions` (not started):** its `provider: "codex"` profile field becomes a provider-level setting. Its copying of login-wide limit events to every profile sharing a Codex home becomes unnecessary, because models of one provider share a cooldown. Both changes modify "Users select a predefined chat profile". That change is amended after this one is approved, rebasing onto this text.

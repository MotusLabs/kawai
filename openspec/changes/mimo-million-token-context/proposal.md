# Proposal

## Why

Xiaomi documents a 1M-token context window for MiMo-V2.6-Pro, but Kawai's shipped MiMo profile supplies neither a context hint nor an auto-compact window. The reported 167K meter is consistent with Claude Code's 200K fallback minus its reserve; the affected session's raw report has not been inspected, so that diagnosis remains a hypothesis.

## What Changes

- Declare MiMo's 1M capacity to Claude Code using `[1m]` on its startup model and all tier mappings, independently of its compaction preference.
- Add an optional `autoCompactWindow` token count to Claude catalog profiles/providers/models and role group frontmatter. A configured size enables auto-compaction. Ship MiMo with a global default of `300000`.
- Add `modelAutoCompactWindow` role overrides, following the existing per-model effort convention. Resolve role/model override, then role default, then catalog default, then existing runtime behavior.
- Preserve Pro for startup/Opus/Haiku/Fable and Flash for Sonnet; Xiaomi documents 1M for both models.
- Document how the shipped fix reaches newly started agents and how operators can update replacement catalogs.
- Pin the effective launch configuration and validate the actual driver's context report. Keep Kawai's existing reserve-aware meter behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-session-profiles`: MiMo's shipped launch configuration declares its supported context window alongside its existing routing and tier mappings.
- `agent-teams`: roles can choose a default compaction window and override it for an individual model profile.

## Impact

- Catalog parsing/merging, team group parsing/resolution, Claude launch composition, `config/profiles.default.json`, related tests, and configuration documentation. Read-only group metadata carries the new optional settings.
- No new dependencies, database migration, or meter algorithm. User-level catalogs replace shipped defaults and must be updated by their operator; running agents need a new process to receive new settings.
- Xiaomi's 128K maximum output is supporting model information, not a request to raise Claude Code's output budget in this change.
- Sources checked 2026-10-26: [Xiaomi model limits](https://mimo.mi.com/docs/en-US/quick-start/model), [MiMo Pro specifications](https://mimo.mi.com/models/en-US/mimo-v2-6-pro), and [Claude Code custom-model context configuration](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

# Proposal

## Why

Xiaomi documents a 1M-token context window for MiMo-V2.6-Pro, but Kawai's shipped MiMo profile supplies neither a context hint nor an auto-compact window. The reported 167K meter is consistent with Claude Code's 200K fallback minus its reserve; the affected session's raw report has not been inspected, so that diagnosis remains a hypothesis.

## What Changes

- Declare MiMo's 1M capacity to Claude Code using `[1m]` on its startup model and all tier mappings, independently of its compaction preference.
- Add an optional `autoCompactWindow` token count to Claude catalog profiles/providers/models and role group frontmatter. A configured size enables auto-compaction. Ship MiMo with a global default of `300000`. The normalization checks the newly composed key set — the window and each cleared disable flag — against the launch's freshly derived per-spawn registered-name set without ever adding to it; a nonempty intersection refuses the launch before either layer is written rather than blanking or dropping the key.
- Add `modelAutoCompactWindow` role overrides, following the existing per-model effort convention. Resolve role/model override, then role default, then catalog default, then existing runtime behavior.
- Preserve Pro for startup/Opus/Haiku/Fable and Flash for Sonnet; Xiaomi documents 1M for both models. When a selected numeric preference applies to a launch whose model declaration explicitly carries `[1m]`, the launch also clears `CLAUDE_CODE_DISABLE_1M_CONTEXT` in both env layers, subject to the same registered-name refusal; without an explicit preference or an explicit `[1m]` declaration that flag keeps its legacy behavior, and capacity is never inferred from a numeric window alone.
- Document how the shipped fix reaches newly started agents per install mode: merge-mode installs inherit the shipped or retained MiMo definition, replace-mode operator catalogs stand alone until the operator adds the preference, and the relay-adopted template carries it.
- Pin the effective launch configuration and validate the actual driver's context report. Keep Kawai's existing reserve-aware meter behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-session-profiles`: MiMo's shipped launch configuration declares its supported context window alongside its existing routing and tier mappings.
- `agent-teams`: roles can choose a default compaction window and override it for an individual model profile.

## Impact

- Catalog parsing/merging, team group parsing/resolution, Claude launch composition, `config/profiles.default.json`, related tests, and configuration documentation. Read-only group metadata carries the new optional settings.
- No new dependencies, database migration, or meter algorithm. Catalog assembly follows the durable install mode (relay §3): a replace-mode operator definition without the field receives no shipped preference, a merge-mode omission inherits the shipped or retained MiMo definition, and a retired retained layer never synthesizes MiMo; running agents need a new process to receive new settings. This change's MiMo inventory update lands before relay §5's fresh-defaults trim, and §5 snapshots the updated MiMo facts verbatim into its adoption templates and eligible-retained inventory (design D4).
- Xiaomi's 128K maximum output is supporting model information, not a request to raise Claude Code's output budget in this change.
- Sources checked 2026-10-26: [Xiaomi model limits](https://mimo.mi.com/docs/en-US/quick-start/model), [MiMo Pro specifications](https://mimo.mi.com/models/en-US/mimo-v2-6-pro), and [Claude Code custom-model context configuration](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

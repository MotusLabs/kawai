# Proposal

## Update status (2026-11-18, PROPOSED)

Planning update for plan `plan-2eb5f292` (draft); owner approval pending.
Nothing is implemented (0/10 on master `f52963d0`). Changes from the
2026-10-26 text, each a proposed refinement:

- **Retargeted to the actual launch path.** Claude launches compose in
  `src/server/chat/provider/claudeRuntimeLaunch.ts` (`claudeSpawnLaunch`,
  `launchFields`) over `resolveClaudeProfile`, and run through the in-tree
  `@motuslabs/agent-runtime` 0.1.1 (`package.json:47`); the old
  `ChatSessionDriver` is gone. No runtime package API change or publication
  is needed or allowed.
- **Env-only composition.** The package's `settings` option carries only
  `env` (`packages/agent-runtime/src/options.ts:250`), so the window and the
  cleared disable switches go into both env layers; no inline
  `autoCompactEnabled` setting is composed (design D3).
- **Relay install-mode coupling dropped.** Install modes, retained layers and
  the relay §5 trim do not exist on master (held lineage
  `feat/relay-install-modes`, task `c6bfbd04`, untouched). Catalog assembly is
  today's tiers (user-level files replace the shipped defaults; project
  overlays merge over the base), so the former D4 landing-order rule and
  oracle C5c are removed and C5a/C5b are re-derived over those tiers; whichever of this change and a future relay change
  lands second re-derives the shared requirement.
- **Role field renamed** `modelAutoCompactWindow` → `profileAutoCompactWindow`,
  matching the landed per-profile convention `profileEffort`
  (`src/server/team/groupFile.ts:11-22`, `groupCatalog.ts:125-158`).
- **Implementation contract added** (design.md).
- The credentialed runtime smoke R1 stays an explicit owner gate (task 4.1);
  it is not waived and no result is invented.

## Why

Xiaomi documents a 1M-token context window for MiMo-V2.6-Pro, but Kawai's
shipped MiMo profile (`config/profiles.default.json:14-24`) supplies neither a
context hint nor an auto-compact window. The reported 167K meter is consistent
with Claude Code's 200K fallback minus its reserve; the affected session's raw
report has not been inspected, so that diagnosis remains a hypothesis.

## What Changes

- Declare MiMo's 1M capacity to Claude Code using `[1m]` on its startup model
  and all tier mappings, independently of its compaction preference.
- Add an optional typed `autoCompactWindow` token count to Claude catalog
  profiles/providers/models and role group frontmatter. A selected size sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and clears `DISABLE_AUTO_COMPACT` and
  `DISABLE_COMPACT` in both env layers. Ship MiMo with `300000`. The composed
  key set is checked against the launch's fresh per-spawn registered-name set
  without adding to it; a nonempty intersection refuses the launch before
  either layer is written.
- Add `profileAutoCompactWindow` role overrides keyed like `profileEffort`.
  Resolve role/profile override, then role default, then catalog scalar, then
  existing runtime behavior.
- Preserve Pro for startup/Opus/Haiku/Fable and Flash for Sonnet. When a
  selected preference applies to a launch whose model declaration explicitly
  carries `[1m]`, also clear `CLAUDE_CODE_DISABLE_1M_CONTEXT` in both layers,
  under the same refusal; capacity is never inferred from a window alone.
- Feed the normalized launch env to the context tracker and the start
  observation, keeping Kawai's reserve-aware meter.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-session-profiles`: MiMo's shipped launch configuration declares its
  context window; catalog entries can carry a typed window.
- `agent-teams`: roles choose a default compaction window and override it per
  profile.

## Impact

- Code (planned): `catalogParse.ts`, `catalogMerge.ts`, `profileCatalog.ts`,
  `ClaudeProfiles.ts` (or a focused adjacent `claudeCompaction.ts`),
  `provider/claudeRuntimeLaunch.ts`, `provider/claudeRuntime.ts`,
  `ChatSessionManager.ts` (callback wiring beside `getEffort`),
  `src/server/team/groupFile.ts`, `groupCatalog.ts`, `sessionTeams.ts`,
  `workspaceRead.ts`, `src/shared/teamWorkspace.ts`,
  `config/profiles.default.json`, docs.
- No new dependency, migration, meter algorithm, or runtime package change.
  Running agents need a new process to receive new settings.
- Shared requirement: "Named profiles configure independent provider
  sessions" is also MODIFIED by `provider-relay-setup` and
  `rename-agentboard-to-kawai` (not in this package); the later archive
  re-derives it.
- Sources checked 2026-10-26: [Xiaomi model limits](https://mimo.mi.com/docs/en-US/quick-start/model), [MiMo Pro specifications](https://mimo.mi.com/models/en-US/mimo-v2-6-pro), and [Claude Code custom-model context configuration](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

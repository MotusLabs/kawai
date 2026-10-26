# Design

## Context

See proposal.md for motivation and sources. MiMo is a legacy entry in `config/profiles.default.json`. `catalogParse.ts`, `catalogMerge.ts`, and `profileCatalog.ts` validate and flatten catalog settings; `ClaudeProfiles.ts` produces process env and flag-layer settings. `ChatSessionDriver` reads the window from the launch env before seeding its context tracker, and spawn observations record that same env. Reports outrank the configured window in the tracker.

Roles already have a group default and per-model map for effort (`groupFile.ts`, `groupCatalog.ts`, `SessionTeams.effortFor`). The manager provides a callback re-read at agent start. Mirror that path for compaction. The user requested both a global MiMo default and agent-profile overrides.

## Goals / Non-Goals

**Goals:** Keep capacity, compaction preference, and observed threshold separate. Configure MiMo globally at 300000 tokens; let roles specialize that preference without duplicating model profiles.

**Non-Goals:** Output-budget changes, an in-chat compaction editor, disabling auto-compaction through the new field, changes to Codex compaction, and modifications to operator-owned catalog files. Do not change worker staffing or group membership.

## Decisions

### D1: Capacity stays in the model declaration

Tag MiMo's startup model and every model env/alias mapping with `[1m]`, preserving Pro/Flash assignments and the base URL. The tag tells Claude Code the custom model capacity. Use the repository's decimal 1000000 convention. Ship `autoCompactWindow: 300000` on MiMo separately. Setting only the legacy auto-compact env would still leave the driver's assumed capacity unresolved; raising compaction to 1M would ignore the requested 300K default.

Capacity normalization is explicit (Lead decision B4): when a selected numeric preference applies to a launch whose model declaration explicitly carries `[1m]` — including the planned MiMo definitions — the launch clears `CLAUDE_CODE_DISABLE_1M_CONTEXT` in both env layers alongside the other disable flags, subject to the registered-name refusal in D3. With no selected preference, or with no explicit `[1m]` declaration, that flag keeps its existing behavior; capacity is never inferred or forced from a numeric window alone. The prescribed override wins over inherited user/project/local settings for that launch only; no live profile is edited.

### D2: Typed preferences in catalogs and roles

Add optional `autoCompactWindow` to legacy Claude profiles, providers, and provider models. Accept JSON integer tokens in [100000, 1000000]. Reject invalid catalog values using existing file-level error isolation. Treat it as Claude-only; reject Codex entries and resolved executable-backed entries carrying it so wrappers retain ownership.

Carry the scalar through parse, merge, flatten, embedded defaults, and shipped-model re-homing. At each provider/model scope, nearer scalar definitions win; a model's effective scalar overrides its provider's. A re-homed model carries its previously flattened preference before nearer overrides, like its existing launch settings. Catalog assembly follows the durable install mode (relay §3): a replace-mode operator definition without the field receives no shipped preference (absence preserved), a merge-mode omission inherits the field from any applicable shipped or retained MiMo definition, and where no lower definition exists nothing is synthesized — a retired retained layer never resurrects MiMo.

Roles accept `autoCompactWindow: 250000` and `modelAutoCompactWindow: { mimo: 300000 }`. Numbers in role frontmatter use plain decimal integer tokens only. Support qualified keys such as `mimo/mimo` using existing provider/model resolution. Reuse flow parsing rather than introducing a YAML dependency. Invalid defaults/maps/entries produce warnings following per-model effort conventions. A repeated written key is consumed by its first occurrence, even if invalid; resolved aliases keep the first valid resolved entry. Unknown qualifiers are ignored, known unlisted models warn and apply. Do not add a legacy alias for a new field.

Example role profile:

```yaml
autoCompactWindow: 250000
modelAutoCompactWindow: { mimo: 300000 }
```

Resolution for a supported Claude process: role per-model value > role default > flattened catalog scalar > existing legacy env/runtime behavior. Ungrouped sessions use the catalog default. Group settings apply equally to human-created and staffed members; Codex and wrapper-backed launches ignore group compaction preferences. No new field means no enablement change.

### D3: One effective value reaches every launch consumer

Resolve the role preference via `SessionTeams` and a manager-to-driver callback at each start, as effort is resolved today. Apply it and the catalog scalar through a shared Claude launch composition helper after profile resolution, before the context tracker and query options consume the launch. Every key the helper composes — the window and each cleared disable flag, including `CLAUDE_CODE_DISABLE_1M_CONTEXT` under D1's condition — enters the same fresh per-spawn registered-name set the launch already derives (`catalogRegisteredNames`: parsed catalog names plus the retained set, re-derived at every start and respawn, with header and store sources included as they arrive). A mandatory normalization that would carry a registered name in either env layer refuses with the existing typed pre-spawn refusal (`RegisteredNameRefusal`): the send settles failed with its names-only message and no child starts — the key is never blanked or silently dropped, on the Default branch as much as on named and credentialed branches. Catalog-only callers, including the availability probe, still receive their catalog preference.

A selected numeric value sets `settings.autoCompactEnabled: true`, `settings.autoCompactWindow`, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in both process env and `settings.env`. Set `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT` — and, under D1's explicit `[1m]`-plus-preference condition, `CLAUDE_CODE_DISABLE_1M_CONTEXT` — to empty strings in both locations for that launch: these documented switches otherwise defeat enablement. Keep unrelated env/settings and credential pinning intact. Restrict this normalization to launches with an explicit new preference; legacy profiles retain current behavior. Never mutate shared process env. The new typed preference wins over the legacy window env when both exist.

Use the normalized launch env for the context tracker, onSpawn facts, and existing settings observations, so role overrides never leave the meter or start record at the catalog's old size. Preserve report precedence, reserve subtraction, and approximation labels. A configured 300K window is not a promise of a 300K displayed threshold; a reported 33K reserve would make it 267K.

Expose optional role preferences in the existing read-only group metadata (`workspaceRead.ts`, `TeamMemberRow`). This is configuration inspection, with no new editor. Re-read on process start; edits leave the current process untouched, removal falls through to the next default. No new persisted session columns.

### D4: Landing order with the relay trim (Lead decision B3)

The MiMo inventory update in this change lands BEFORE provider-relay-setup §5 trims fresh defaults to Anthropic + OpenAI, serialized by the actual catalog source ownership (relay G2/G8: whichever change lands second rebases onto the other). Relay §5 then snapshots the identified updated MiMo definition — its exact facts and source commit — verbatim into its adoption templates and eligible-retained inventory, so an upgraded install's retained MiMo keeps `[1m]` and 300000 while a fresh trim stays Anthropic + OpenAI only. Already-frozen retained facts are never edited, and this change never resurrects a retired MiMo id; if the landing order reverses, work stops for a new Lead decision (template-only alternative). The 300000 preference applies where the effective MiMo definition declares it — operator replacement catalogs and legacy retained facts may differ. When archiving, the overlapping `Named profiles configure independent provider sessions` delta composes with the relay's version without reverting relay clauses.

### Acceptance oracles

Commit the following tables verbatim as table-driven tests. `*` means irrelevant to that row. Rows describe separate seams; each table's selection rows are mutually exclusive. Numeric values are windows, not observed thresholds.

| ID | Role model value | Role default | Catalog scalar | Legacy window | Effective window / enabled override |
| --- | --- | --- | --- | --- | --- |
| W1 | 300000 | 250000 | 400000 | 150000 | 300000 / true |
| W2 | absent | 250000 | 400000 | 150000 | 250000 / true |
| W3 | absent | absent | 300000 | 150000 | 300000 / true |
| W4 | absent | absent | absent | 150000 | 150000 / no new enablement override |
| W5 | absent | absent | absent | absent | runtime default / no new override |

| ID | Input / seam | Observable result |
| --- | --- | --- |
| C1 | Shipped (pre-trim) or relay-adopted-template MiMo definition declaring `[1m]`/300000, empty isolated home | Pro startup/Opus/Haiku/Fable tagged [1m], Flash Sonnet tagged [1m], original URL, window 300000 — asserted where the effective definition carries the preference, never as an unconditional fresh-install promise |
| C2 | Provider 400000, model 300000 | That model 300000; sibling without own scalar 400000 |
| C3 | Far model 300000, near model 400000; then shipped key re-homed without scalar | Near scalar 400000; re-homed key retains inherited scalar |
| C4 | Catalog scalar invalid: string, boolean, null, fractional, below/above bounds | Whole file reported and skipped, valid other file usable |
| C5a | Replace-mode catalog omits the scalar | No shipped MiMo preference injected (absence preserved exactly) |
| C5b | Merge-mode catalog omits the scalar; a shipped or retained MiMo definition is available below | The MiMo scalar is inherited from that lower definition |
| C5c | Merge-mode catalog omits the scalar; no MiMo lower definition exists (fresh trim, or retained layer retired) | No preference injected; MiMo is never synthesized or resurrected |
| G1 | Role default invalid or map malformed | Group retained; bad field warned/ignored, valid fallback applies |
| G2 | Invalid/unknown/wrong-qualified map entry plus valid sibling | Bad entry warned/ignored alone; valid sibling applies |
| G3 | Repeated written key, or two valid keys resolving to one model | First written occurrence consumed; first valid resolved entry wins; later duplicate warned |
| G4 | Known unlisted model, bare and qualified forms separately | Warning; preference applies to a human-created member on that profile |
| L1 | Real manager constructs human-created and staffed MiMo members with role override | Both query launches get same normalized window in env/settings, enabled true, disable flags blank; tracker and start observation use same window |
| L2 | Role value edited, running process queried, process restarted, value removed and restarted | Old launch unchanged; new launch uses edit; removal restores catalog/role fallback |
| L3 | Two concurrent sessions, role preference only on first | First gets override; second gets its own default; shared process env unchanged |
| L4 | Codex or wrapper-backed member with role preference | Existing launch behavior; no role-injected Claude compaction settings |
| L5 | Catalog scalar on Codex or wrapper-backed Claude entry | Actionable catalog incompatibility error |
| L6 | A registered name among the composed keys (window or a cleared disable flag) at start and at respawn, on Default and on named/credentialed branches, with the name's binding removed after registration | Existing typed pre-spawn refusal, names-only settled failed send, zero query launches, no composed registered key in either env layer |
| L7 | Noncolliding preference control at start and respawn | Launches normally with the normalized window; the registered set is re-derived at each spawn, so a name registered after driver creation still refuses the next spawn |
| M1 | Effective window 300000, first usage, no report; then report threshold 267000/raw 300000/reserve 33000 | Approximate 300000 first, then exact 267000; reported facts win |
| V1 | Read-only group metadata | Configured default, resolved model map, warnings present |
| R1 | Actual supported CLI at the minimum supported baseline (`CLAUDE_CODE_MIN_VERSION`, 2.1.289) with MiMo normalized launch | Driver recognizes 1M capacity, effective enablement and selected 300K window with its real reserve, accepted outgoing untagged provider model ids; recorded fields follow their actual versioned meanings; a newer CLI's static facts do not certify the baseline, and missing baseline/report/credentials reads as unverified |

No group/role selection applies to a session without that role; those combinations are unreachable. L4 and L5 distinguish runtime composition from invalid catalog input. Table coverage is bounded to this change, not a new recovery state machine. Consulted `docs/oracle-hazards.md`: L1 must use production manager/driver composition, not only a standalone resolver test, and L6 exercises both named hazards — a registered set frozen at creation and a branch re-composing a name it filtered — through the existing `registeredNames*` manager wiring and refusal seams, with no new recovery framework. R1 records the report's raw fields per their actual versioned meanings rather than forcing them to match M1's synthetic values.

Property P1: a chosen numeric override never leaks to another session or process env. Generate two isolated role/model configurations and sizes uniformly in the accepted integer range, including boundary cases; run the real resolver/composition seams, snapshot process env before/after, fixed seed `0x4d494d4f`, 128 cases, no new dependency. Assert each result equals the precedence table and independent resolution. No persistent state machine is introduced.

## Risks / Trade-offs

- Current upstream docs may differ from the installed supported CLI → R1 captures version, resolved settings, report fields, reserve, and model routing. Do not infer success from the meter alone; a 200K raw report remains a failed runtime check.
- Forced enablement can conflict with inherited disable flags → normalize both env layers only for explicitly configured preferences and test conflicting inherited values.
- Catalog replacement can hide the shipped fix → behavior is mode-conditional (D2): replace-mode operators add the preference themselves or adopt the relay template; merge-mode installs inherit it. Provide a small operator example covering tagged models and the typed window. Do not silently rewrite operator files, and never edit frozen retained facts (D4).
- The new normalization composes env keys outside the catalog's profile-controlled list → every composed key joins the launch's fresh per-spawn registered-name set and a collision refuses the launch (D3), so the preference cannot re-introduce a withheld name; oracle-hazards D-freeze rows cover the regressions.
- Larger windows can cost more and compacting earlier changes context retention → document the global default and overrides; preserve runtime reserve policy.

## Migration Plan

Ship catalog/parser/launch support together, and land the MiMo inventory update before relay §5's trim (D4), whose snapshot carries the updated definition verbatim into the adoption templates and the eligible-retained inventory. Existing merge-mode installs need no edits: MiMo developers inherit 300K from the shipped or retained definition; role examples demonstrate overriding it. Replace-mode operators add `autoCompactWindow: 300000` and the capacity hint themselves, or adopt the relay template carrying them. Start a fresh agent process to adopt the new settings. Roll back by removing the new fields and reverting shipped tags together with the code; avoid leaving new fields for old parsers to reject. Record runtime validation limitations explicitly if MiMo credentials are unavailable: R1 names the minimum supported CLI (`CLAUDE_CODE_MIN_VERSION`, 2.1.289) and leaves unverified whatever the actual baseline cannot show — a newer CLI's static strings or a minimal prompt do not certify the baseline, and no baseline bump is authorized by this change.

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

### D2: Typed preferences in catalogs and roles

Add optional `autoCompactWindow` to legacy Claude profiles, providers, and provider models. Accept JSON integer tokens in [100000, 1000000]. Reject invalid catalog values using existing file-level error isolation. Treat it as Claude-only; reject Codex entries and resolved executable-backed entries carrying it so wrappers retain ownership.

Carry the scalar through parse, merge, flatten, embedded defaults, and shipped-model re-homing. At each provider/model scope, nearer scalar definitions win; a model's effective scalar overrides its provider's. A re-homed model carries its previously flattened preference before nearer overrides, like its existing launch settings. User catalogs still replace both shipped files wholesale.

Roles accept `autoCompactWindow: 250000` and `modelAutoCompactWindow: { mimo: 300000 }`. Numbers in role frontmatter use plain decimal integer tokens only. Support qualified keys such as `mimo/mimo` using existing provider/model resolution. Reuse flow parsing rather than introducing a YAML dependency. Invalid defaults/maps/entries produce warnings following per-model effort conventions. A repeated written key is consumed by its first occurrence, even if invalid; resolved aliases keep the first valid resolved entry. Unknown qualifiers are ignored, known unlisted models warn and apply. Do not add a legacy alias for a new field.

Example role profile:

```yaml
autoCompactWindow: 250000
modelAutoCompactWindow: { mimo: 300000 }
```

Resolution for a supported Claude process: role per-model value > role default > flattened catalog scalar > existing legacy env/runtime behavior. Ungrouped sessions use the catalog default. Group settings apply equally to human-created and staffed members; Codex and wrapper-backed launches ignore group compaction preferences. No new field means no enablement change.

### D3: One effective value reaches every launch consumer

Resolve the role preference via `SessionTeams` and a manager-to-driver callback at each start, as effort is resolved today. Apply it and the catalog scalar through a shared Claude launch composition helper after profile resolution, before the context tracker and query options consume the launch. Catalog-only callers, including the availability probe, still receive their catalog preference.

A selected numeric value sets `settings.autoCompactEnabled: true`, `settings.autoCompactWindow`, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in both process env and `settings.env`. Set `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT` to empty strings in both locations for that launch: these documented switches otherwise defeat enablement. Keep unrelated env/settings and credential pinning intact. Restrict this normalization to launches with an explicit new preference; legacy profiles retain current behavior. Never mutate shared process env. The new typed preference wins over the legacy window env when both exist.

Use the normalized launch env for the context tracker, onSpawn facts, and existing settings observations, so role overrides never leave the meter or start record at the catalog's old size. Preserve report precedence, reserve subtraction, and approximation labels. A configured 300K window is not a promise of a 300K displayed threshold; a reported 33K reserve would make it 267K.

Expose optional role preferences in the existing read-only group metadata (`workspaceRead.ts`, `TeamMemberRow`). This is configuration inspection, with no new editor. Re-read on process start; edits leave the current process untouched, removal falls through to the next default. No new persisted session columns.

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
| C1 | Shipped MiMo, empty isolated home | Pro startup/Opus/Haiku/Fable tagged [1m], Flash Sonnet tagged [1m], original URL, window 300000 |
| C2 | Provider 400000, model 300000 | That model 300000; sibling without own scalar 400000 |
| C3 | Far model 300000, near model 400000; then shipped key re-homed without scalar | Near scalar 400000; re-homed key retains inherited scalar |
| C4 | Catalog scalar invalid: string, boolean, null, fractional, below/above bounds | Whole file reported and skipped, valid other file usable |
| C5 | User catalog replaces defaults without scalar | No shipped MiMo preference injected |
| G1 | Role default invalid or map malformed | Group retained; bad field warned/ignored, valid fallback applies |
| G2 | Invalid/unknown/wrong-qualified map entry plus valid sibling | Bad entry warned/ignored alone; valid sibling applies |
| G3 | Repeated written key, or two valid keys resolving to one model | First written occurrence consumed; first valid resolved entry wins; later duplicate warned |
| G4 | Known unlisted model, bare and qualified forms separately | Warning; preference applies to a human-created member on that profile |
| L1 | Real manager constructs human-created and staffed MiMo members with role override | Both query launches get same normalized window in env/settings, enabled true, disable flags blank; tracker and start observation use same window |
| L2 | Role value edited, running process queried, process restarted, value removed and restarted | Old launch unchanged; new launch uses edit; removal restores catalog/role fallback |
| L3 | Two concurrent sessions, role preference only on first | First gets override; second gets its own default; shared process env unchanged |
| L4 | Codex or wrapper-backed member with role preference | Existing launch behavior; no role-injected Claude compaction settings |
| L5 | Catalog scalar on Codex or wrapper-backed Claude entry | Actionable catalog incompatibility error |
| M1 | Effective window 300000, first usage, no report; then report threshold 267000/raw 300000/reserve 33000 | Approximate 300000 first, then exact 267000; reported facts win |
| V1 | Read-only group metadata | Configured default, resolved model map, warnings present |
| R1 | Actual supported CLI with MiMo normalized launch | Driver recognizes 1M capacity, reports selected 300K window with its real reserve; outgoing model id remains accepted by MiMo |

No group/role selection applies to a session without that role; those combinations are unreachable. L4 and L5 distinguish runtime composition from invalid catalog input. Table coverage is bounded to this change, not a new recovery state machine. Consulted `docs/oracle-hazards.md`: L1 must use production manager/driver composition, not only a standalone resolver test.

Property P1: a chosen numeric override never leaks to another session or process env. Generate two isolated role/model configurations and sizes uniformly in the accepted integer range, including boundary cases; run the real resolver/composition seams, snapshot process env before/after, fixed seed `0x4d494d4f`, 128 cases, no new dependency. Assert each result equals the precedence table and independent resolution. No persistent state machine is introduced.

## Risks / Trade-offs

- Current upstream docs may differ from the installed supported CLI → R1 captures version, resolved settings, report fields, reserve, and model routing. Do not infer success from the meter alone; a 200K raw report remains a failed runtime check.
- Forced enablement can conflict with inherited disable flags → normalize both env layers only for explicitly configured preferences and test conflicting inherited values.
- Catalog replacement can hide the shipped fix → provide a small operator example covering tagged models and the typed window. Do not silently rewrite operator files.
- Larger windows can cost more and compacting earlier changes context retention → document the global default and overrides; preserve runtime reserve policy.

## Migration Plan

Ship catalog/parser/launch support together. Existing groups need no edits: MiMo developers inherit 300K globally; role examples demonstrate overriding it. Operators using replacement catalogs add `autoCompactWindow: 300000` and the capacity hint themselves. Start a fresh agent process to adopt the new settings. Roll back by removing the new fields and reverting shipped tags together with the code; avoid leaving new fields for old parsers to reject. Record runtime validation limitations explicitly if MiMo credentials are unavailable.

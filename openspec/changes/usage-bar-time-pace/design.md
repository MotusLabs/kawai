# Design

## Context

`UsageBar.tsx` renders one row per `ChatUsageWindow`: a fixed-width label, a 4px rounded track (`.chat-usage-meter`, `overflow: hidden`) holding the fill (`.chat-usage-fill`), the rounded percent, and `resets <local time>`. A window carries only `key`, `label`, `percentUsed`, and `resetsAt`; nothing says how long the window is, so the client cannot turn "resets in 2h 30m" into "50% elapsed". Window keys come from three Claude parsers in `src/server/chat/usageLimits.ts` (push `rate_limit_event`, `/usage` report rows, SDK pull) plus the Z.AI quota parser, whose row semantics are explicitly undocumented. `ChatUsageWindow.key` is documented as server vocabulary so a new meter needs no client release — the same principle should hold for period lengths.

## Goals / Non-Goals

**Goals:**
- Elapsed time visible on the meter that already exists, with zero layout growth.
- Period knowledge lives with the parsers that already own window vocabulary.

**Non-Goals:**
- Pace colouring, burn-rate projection, or a numeric "elapsed %" column (see proposal non-goals).
- Inferring a period from two successive reports or from `resetsAt` deltas.

## Decisions

### D1. The server sends `periodMs`; the client never maps kinds

Add optional `periodMs?: number` to `ChatUsageWindow`. A single table in `usageLimits.ts` maps a window's base kind (the key before any `:` scope suffix or `#n` suffix) to its length:

| Base kind | Period |
|---|---|
| `five_hour`, `session` | 5 h |
| `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `seven_day_overage_included`, `weekly_all`, `weekly_scoped`, `model_scoped` | 7 d |
| `overage`, `zai:*`, anything else | none |

Every Claude parser sets it through one helper when building a window; `parseZaiQuotaLimit` never does. *Alternative:* a client-side kind table — rejected because it duplicates server vocabulary and breaks the "new meter needs no client release" rule already written on `key`. *Alternative:* `periodStart` timestamps — the sources don't send one, so it would be derived from the same table anyway.

`weekly_scoped` and the `model_scoped:` prefix are treated as 7 days because the `/usage` row group is `weekly` and the pull names them per-model weekly windows; an implementer who finds a `/usage` row with `group: 'weekly'` under an unlisted kind may also map by `group === 'weekly'`/`'session'` when the kind is unknown, but must not guess for any other group.

### D2. Elapsed share is computed on the client from `now`

`elapsed = clamp(1 − (resetsAt − now) / periodMs, 0, 1)`; no marker when `resetsAt` is null or unparsable, `periodMs` is absent or ≤ 0, or `resetsAt ≤ now`. A pure exported helper (`usageElapsedShare(window, now)`, beside `formatUsageReset`) carries this so tests pin it without rendering. Computing on the server would freeze the value at receipt time and require pushes just to move a marker.

### D3. The marker is a tick on the track, not a second bar

Inside the track, an absolutely positioned 2px-wide tick (`.chat-usage-time`) at `left: <elapsed>%`, taller than the 4px track (≈10px, vertically centred) so it reads as a "now" line over both the filled and empty parts. The track stays the flex child it is today, so row height is unchanged — the meter row is already taller than 10px because of the text. To let the tick overhang, the track's `overflow: hidden` moves to an inner wrapper that clips the fill (or the fill gets its own radius), and the track becomes `position: relative; overflow: visible`.

Colour: `var(--text-primary)`-style foreground at reduced emphasis, distinct from the `--working` / `--approval` / `--chat-danger` fills so status tints keep their meaning. Per the Tailwind memory note, use plain CSS in the stylesheet, not `bg-x/NN` opacity utilities (they emit nothing for var colours).

*Alternatives considered:*
- **Second thin bar under the usage bar** (stacked "time" and "usage" tracks): clearest comparison, but adds height per row — rejected by the no-extra-space constraint.
- **Background shading of the elapsed part of the track**: no extra space, but low contrast against the fill where they overlap, and it reads as a second fill.
- **Text "· 50% time"**: explicit, but widens an already truncating row.

The tick plus hover text gives the at-a-glance comparison (fill vs. line) with the exact numbers one hover away.

### D4. Words live in `title` and `aria-label`

The row gets a `title`, and the track (currently `aria-hidden`) gets an `aria-label` carrying the same text when a marker exists; a full `role="meter"` treatment is not needed. Text: `22% used · 50% of the 5-hour window elapsed · resets in 2h 30m`, using the window's own label (lower-cased only if it is a known Claude label; provider/scoped labels verbatim). Without a marker: `22% used · resets <local time>`. Time-left formatting is a small helper (`2h 30m`, `3d 4h`, `45m`, `<1m`) — not `formatElapsed`, which is seconds-oriented.

### D5. A minute clock, owned by the bar

Generalize `useTickingClock(active, intervalMs = 1000)` in `chatElapsed.ts` and call it from `UsageBar` with `60_000`, active only while some window has a marker-eligible `resetsAt` and `periodMs`. One interval per mounted bar; the 5-hour marker moves ~0.33% per minute, so finer ticks buy nothing. Existing callers keep the 1 s default.

## Risks / Trade-offs

- [Server period table drifts from Anthropic's real window lengths] → Lengths come from the window names themselves (`five_hour`, `seven_day`); an unknown kind gets no marker rather than a wrong one.
- [Clock skew between server-reported `resetsAt` and the browser] → Clamp to 0–100%; a reset "already passed" hides the marker instead of pinning it at 100%.
- [Tick unreadable on a nearly-full or nearly-empty track] → The tick overhangs the track vertically, so it stays visible at 0% and 100%; hover text gives the exact value.
- [Old server, new client] → `periodMs` absent → no marker, bar renders as today. New server, old client: the extra field is ignored.

## Migration Plan

Additive field and client rendering only; ship in one release. Rollback is reverting the client change — the server field is harmless on its own.

## Open Questions

- Z.AI quota rows: if the provider's row semantics become documented (e.g. `TOKENS_LIMIT` really is a 7-day window), `zai:tokens_limit` can join the period table without changing this design.

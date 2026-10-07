# Design

## Context

`ChatDebugPanel` maps `view.frames` (sorted, deduplicated by `seq`, capped at
5000 live frames by `chatDebugStore`) to one row per frame. Expanded rows are
tracked in a `Set<seq>`. The panel auto-scrolls when the newest `seq` changes
and the user is at the bottom. `frameLabel()` in
`src/client/utils/chatWireFrames.ts` derives a frame's type: its `type` plus
the most specific sub-kind, such as `stream_event · content_block_delta`.

Replaying the grouping against a real 35,032-frame wire log:

| Rule | Rows |
|---|---|
| None (today) | 35,032 |
| Same dir + label, strictly adjacent | 26,910 |
| Same, with `system · thinking_tokens` absorbed | ~820 |

Thinking deltas strictly alternate with `system · thinking_tokens`, so strict
adjacency leaves thinking, about 75% of the frames, ungrouped.

## Goals / Non-Goals

**Goals:**
- Grouping is a pure function of the frame list, computed on render, with no
  new store state beyond UI expansion.
- Expansion state survives a group's start or end changing.

**Non-Goals:**
- Server, wire message, storage, or paging changes.
- Semantic grouping by content block (`content_block_start` to `stop`).
- Concatenated previews of delta text. This is a possible follow-up.
- Virtualized rendering of very large expanded groups.

## Decisions

### Group key is direction + `frameLabel`

Two frames continue a run when `dir` and `frameLabel(frame)` are equal. Reusing
`frameLabel` keeps the group title identical to the member rows. It also means
non-JSON lines (`text`, such as consecutive stderr lines) and lifecycle frames
group by the same rule. The label does not include the delta sub-kind
(`text_delta`, `input_json_delta`). Different delta kinds belong to different
content blocks, and those are always separated by `content_block_start` and
`content_block_stop` frames, so they never end up adjacent.

*Alternative:* group by content block. This is more meaningful for
stream-json, but it is protocol-specific and not what was asked for. Rejected
for now.

### Absorbed ("transparent") labels

A small constant set of labels, currently only `system · thinking_tokens`, may
sit inside a run without ending it. The rules:

- A transparent frame with the same direction joins whatever run is open.
  Only a non-transparent frame with a different direction or label closes the
  run. A trailing `thinking_tokens` frame before `content_block_stop` therefore
  stays in the delta group, and the live tail never needs to look ahead.
- A transparent frame with no open run starts a run under its own label, and
  that group behaves like any other.
- The group's title and count use the run's main label. Absorbed frames are
  reported separately ("×412 · +412 thinking_tokens").
- Members always stay in `seq` order. Nothing is hidden.

*Alternative:* period detection, which collapses any repeating A,B,A,B
pattern. It is general, but hard to label and to predict. Rejected in favour of
an explicit, testable list.

This was my recommendation during exploration and hasn't been explicitly
confirmed. Dropping it means emptying the transparent set, which changes no
other part of the design.

### Pure `groupFrames(frames)` helper

`groupFrames` in `chatWireFrames.ts` returns an ordered list of entries:
either `{ kind: 'frame', frame }` or
`{ kind: 'group', label, dir, frames, absorbed }`. The panel memoizes it on
`view.frames`. With 5000 frames at most, a linear pass per update is cheap,
and memoizing parsed labels per `seq` avoids re-parsing JSON on every live
batch.

### Expansion state keyed by member sequence

A group's first `seq` changes when "Load older" prepends to it or when the cap
trims its oldest members. Group expansion is therefore stored as a set of
member `seq`s: the group is expanded if any of its members is in the set, and
toggling adds or removes all current members. When the group grows, it is
still expanded because its earlier members are still in the set. New members
render inside it without being added to the set. Per-frame JSON expansion
keeps its existing `Set<seq>`.

### Copy all

"Copy all" joins the members' `raw` with `\n`, which produces JSONL matching
the server's capture order. It reuses `copyText`.

## Risks / Trade-offs

- [Expanding an 800-frame group renders 800 rows] → Acceptable at the
  5000-frame cap. Virtualization is out of scope, and the user can collapse it
  again.
- [Auto-scroll keys on newest `seq`; a growing collapsed group doesn't change
  height] → No regression, since scrolling to the bottom is a no-op when the
  height hasn't changed.
- [Absorbing into "whatever run is open" could hide a stray `thinking_tokens`
  frame inside an unrelated group] → It is still listed in seq order and
  counted on the row, so nothing is lost from view.
- [The transparent list may need more labels as Claude Code adds
  interleaved status frames] → It is a single constant, covered by tests.

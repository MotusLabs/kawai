# Design

## Context

See proposal.md for motivation. The constraints that shape the approach:

Chat sessions are created as `input.name?.trim() || generateSessionName()`
(`src/server/chat/ChatSessionManager.ts`), so an unnamed session lands on a
random `adj-noun` placeholder. `handleRename` in `src/server/index.ts` already
routes renames and already handles dormant sessions through
`db.updateSession`, but refuses chat sessions outright; `applyPatch` already
propagates `patch.name` to db, registry, and clients.

Claude Code generates a title with a **separate internal query** — visible on
the wire as `query_source: "generate_session_title"` — and persists the result
as a transcript row:

```json
{"type":"ai-title","aiTitle":"openspec-apply","sessionId":"<sdk-session-id>"}
```

These rows carry no `uuid` and no `timestamp`. They are state rows rewritten at
turn boundaries rather than chronological events — a session may hold dozens of
them, sometimes with the title changing. `transcriptReplay.ts` currently skips
them as unknown line types.

## Goals / Non-Goals

**Goals:**
- One naming rule for chat: a user-set name wins, a generated title fills in
  otherwise.
- A generated title reaches the session list without the user opening the chat.
- A place to record whether a name was chosen or merely generated.

**Non-Goals:**
- Renaming terminal (tmux) sessions, or changing the `[\w-]+` rule that names
  tmux windows.
- Writing names back into Claude Code's own session store.
- Surfacing name provenance in the UI as a badge or icon.
- Naming unclaimed sessions from the first user prompt as a fallback.

## Decisions

### D1. Name provenance: `manual | auto | placeholder`

A name string alone cannot answer the question this change turns on.
`calm-raven` is either a name a user chose or a name nothing better arrived for
yet, and the two must behave differently forever after.

Stored alongside the name:

| provenance | set by | overwritten by a generated title |
|---|---|---|
| `placeholder` | `generateSessionName()` at create | yes |
| `auto` | adopted from a generated title | yes |
| `manual` | user at create, or any rename | **never** |

Transitions: `placeholder`/`auto` → `manual` on any user rename; `placeholder` →
`auto` on the first generated title; `auto` stays `auto` as titles evolve.
`manual` is terminal.

*Alternative:* infer provenance from whether the name matches the `adj-noun`
pattern. Rejected — a user may type `calm-raven` on purpose, and the inference
gets that exactly backwards.

### D2. A generated title is followed, not frozen, while unclaimed

While provenance is `auto`, each newer generated title replaces the name. This
is the same rule as adoption — Claude owns the name until a human claims it —
and later titles tend to be better than the first one.

*Alternative:* adopt the first generated title and stop. Rejected for this
change; it settles on a thin early title. Still available later without a
spec change.

### D3. One-way naming — kawai reads titles, never writes them

A kawai rename updates kawai's session name only. It does not call
`renameSession()`, does not append a `custom-title` row, and does not open a
`rename_session` control request.

Claude Code's own `--resume` list therefore keeps whatever title it generated.
That is accepted: the ask is kawai's UI, and the alternative writes into a
transcript file a live agent process is appending to.

*Alternative:* two-way sync. Rejected for this change — its only payoff is a
tidier `--resume` list, against a live-write race. A clean follow-up if wanted.

### D4. Observe generated titles by tailing the transcript

The title never appears on the SDK message stream, so the transcript JSONL is
the only source. kawai already parses that file. Rather than fold the read into
the existing attach-time replay, live chat sessions watch their transcript and
adopt each new `ai-title` row as it lands.

The gap this closes is real: the title query runs *after* the turn ends, so
reading only at turn boundaries can leave `pure-bell` in place until the next
turn. Attach-only reading never fixes rows for sessions nobody has opened,
which is where the list shows them.

*Alternatives:*
- Poll `getSessionInfo()` (a runtime SDK export). Rejected — it reads the same
  file through a heavier path and still needs a poll interval to decide.
- Read on turn completion and on attach. Rejected as the sole mechanism — it
  misses the late write that is the common case. Kept as a catch-up read.

### D5. Chat names are free text

Terminal names are constrained to `[\w-]+` because they are tmux window names.
Generated titles contain spaces and periods
(`Claude Code Chat subscription usage metrics spec`), so that rule would reject
every one. Chat names are labels only — a chat session has no tmux window — so
the rule is trimmed non-empty, with no character restriction and no uniqueness
requirement. The existing terminal rule is unchanged and still applies to
terminal sessions.

### D6. Existing rows migrate as `placeholder`

Sessions created before this change carry `adj-noun` names from
`generateSessionName()` and no provenance. The migration stamps them
`placeholder`, so they adopt a generated title at the next tail. The
approval-policy requirement chose the opposite default ("before this feature
SHALL behave as manual"); naming goes the other way because a placeholder name
has no value to preserve.

### D7. A `custom-title` row counts as `manual`

Claude Code writes `custom-title` on an internal rename. Nothing in kawai's
chat path produces one under D3, but if one appears it is a user-set title and
should stick. Treated as `manual` on read.

## Risks / Trade-offs

- **[The transcript is another process's file, appended while we read it]** →
  Tail only the appended region; tolerate a truncated trailing line by waiting
  for the next write, as transcript replay already does.
- **[Retitles make the list row change under the user]** → Only while unclaimed.
  A single rename pins it. The list is name-sorted only if nothing else drives
  order, so movement is limited.
- **[Migration misclassifies a hand-picked `adj-noun` name as a placeholder]** →
  The generated title would replace it once. Low likelihood given the pattern;
  recovered by renaming. Accepted for the sake of the four live sessions whose
  placeholders are actively harmful.
- **[A long generated title truncates in the row]** → Rows already truncate;
  the full name remains available in the header and on hover.
- **[Watching a transcript per live chat session]** → Only live chat sessions are
  watched, and the watch is released on kill, archive, and server shutdown. The
  transcript is a single small file per session.

## Migration Plan

1. Add the provenance column to `chat_sessions`, defaulting existing rows to
   `placeholder`. Column addition is additive and backward compatible.
2. Existing chat sessions adopt a generated title on their first tail after the
   upgrade; nothing needs to run at migration time.
3. Rollback: drop the column. Names stay as strings; nothing else depends on
   provenance, and clients that do not know the field keep rendering names.

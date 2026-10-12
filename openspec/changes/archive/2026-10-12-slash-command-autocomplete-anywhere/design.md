# Design

## Context

See proposal.md for the motivation. Today the menu is driven entirely by the
whole composer text:

- `slashCommandFilter.ts` exports `SLASH_MENU_QUERY = /^\/\S*$/` and
  `slashMenuQuery(text)`, which returns the text only when the whole message is
  a bare `/command`.
- `ChatView.tsx` derives `menuOpen` from `slashMenuQuery(text)`, filters with
  `filterChatCommands(commands, text)`, and `chooseCommand(name)` replaces the
  whole text with `/${name} `. Highlight and Escape-dismiss reset on every text
  change. The argument hint matches the whole text against `/^\/(\S+) $/`.
- The composer is a controlled `<textarea>` with no ref and no caret tracking.
- The component tests in `chatComponents.test.tsx` drive it with
  `onChange({ target: { value } })` — no `selectionStart` — and
  `onKeyDown(...)`; `slashCommandFilter.test.ts` covers `slashMenuQuery` and
  the ranking.

## Goals / Non-Goals

**Goals:**
- One caret-aware rule decides when the menu is open, what it filters by, and
  what a choice replaces, whether the `/` word is first in the message or not.
- Choosing a command edits only that word and leaves the caret where typing
  naturally continues.
- Existing leading-`/` behavior and its tests stay as they are.

**Non-Goals:**
- Executing mid-message commands, expanding them, or changing what is sent.
  `/clear`, `/reset`, `/new` interception (`CLEAR_COMMAND`) keeps matching the
  whole trimmed message.
- Showing a different command list mid-message (for example, skills only). The
  menu offers the same list everywhere; whether the agent acts on a mid-message
  `/name` is up to the agent.
- Positioning the menu at the caret. It stays above the composer.
- Changing ranking, highlight styling, or the loading/unavailable states.

## Decisions

**D1. A pure `slashTokenAt(text, caret)` replaces `slashMenuQuery`.**
It returns `{ start, end, query }` for the `/` word containing the caret, or
null. The word starts at a `/` that is at index 0 or follows whitespace
(`\s`, so space, tab, and newline); `query` is the text from that `/` to the
caret and must match `/^\/[^\s/]*$/`; `end` extends from the caret over the
rest of the word (non-whitespace) so a choice made with the caret mid-word
replaces the whole word. Null when the caret is not inside such a word.

- Requiring whitespace or start before `/` keeps `and/or`, `a/b`, and URLs
  closed. Rejecting a second `/` closes the menu while a path like `/usr/bin`
  is typed.
- Alternative: keep the whole-text regex and add a second "last word" regex.
  Rejected — it ignores the caret, so editing earlier in a message would open
  a menu for the trailing word and a choice would replace the wrong text.

**D2. ChatView tracks the caret in state.**
A `caret: number | null` state is set from the textarea's `selectionStart` in
`onChange` and `onSelect` (which fires for arrow keys, clicks, and
selections). A non-collapsed selection sets `null`, which closes the menu. When
the event carries no `selectionStart` (the test renderer), `onChange` falls
back to the end of the new value, which is exactly where typing leaves the
caret and keeps the current tests valid. `menuOpen` becomes
`token !== null && !menuDismissed && status !== 'unavailable'`, and the filter
gets `token.query`.

- Highlight and Escape-dismiss reset when the token's `start` or `query`
  changes, not on every text change, so typing elsewhere in a long message
  does not reset a dismissed menu that is not showing anyway, and moving into
  a new `/` word reopens it.
- Alternative: read `selectionStart` from a ref during render. Rejected — the
  render would not re-run on caret-only moves, so moving the caret out of the
  word would leave a stale menu.

**D3. A pure `insertCommand(text, token, name)` does the edit.**
It returns `{ text, caret }`: `text.slice(0, start) + '/' + name + ' ' +
text.slice(end)` with the following whitespace collapsed so choosing before
an existing space does not leave a double space, and `caret` right after the
inserted space. ChatView sets the text, sets the caret state, and restores the
DOM caret through a textarea ref in a layout effect (a controlled value update
otherwise moves the caret to the end). At the start of an empty message this
yields `/name ` with the caret at the end — the current behavior.

**D4. The argument hint follows the command before the caret.**
The hint shows when the text before the caret ends with `/<name> ` where the
`/` is at index 0 or after whitespace and `<name>` (or an alias) is a listed
command. For a message that is exactly `/<name> ` this is today's behavior;
typing arguments moves the caret past the trailing space and hides it, as now.

**D5. Keyboard rules are unchanged.**
While the menu has matches, Up/Down/Enter/Tab/Escape belong to the menu
wherever the `/` word is; with no matches Enter sends. Matching the
established rule keeps one mental model and needs no new spec behavior.

## Risks / Trade-offs

- [A `/` word typed in prose (`check /tmp` then Enter) can match a command by
  description substring, so Enter inserts a command instead of sending] →
  Same risk exists today for messages starting with `/`; Escape dismisses, and
  a second `/` (any real path) closes the menu. Revisit with name/alias-only
  matching mid-message if it proves annoying.
- [Caret restore after insertion races React's controlled update] → Restore
  in `useLayoutEffect` keyed on the inserted caret, after the value commits.
- [`onSelect` is not exercised by the test renderer] → Cover the pure helpers
  exhaustively in `slashCommandFilter.test.ts`, and in component tests call
  `onSelect`/`onChange` with explicit `selectionStart`/`selectionEnd`.

# Proposal

## Why

A team lead's chat session runs for days, and opening it is noticeably slow:
every attach sends the whole conversation in one `chat-snapshot` (the largest
transcript on this host is 141 MB of JSONL), and the client folds and renders
every event of it at once, with no virtualization. Almost always the user only
wants what happened recently, so the cost of opening a chat should follow the
recent part, not the session's age.

## What Changes

- Attaching to a chat (live or archived, first open, reload, or reconnect)
  delivers only the recent history window: every turn that started in the
  24 hours ending at the session's newest activity, plus everything still live
  (unfinished output, pending requests, rosters, activity). Turns are never
  split, so a tool call always arrives with its result. A chat idle for days
  therefore still opens on its last day of work rather than empty.
- The snapshot says whether older history exists. When it does, the top of the
  transcript shows a **Load earlier messages** control; each use fetches the
  preceding 24-hour window (at least one turn) and prepends it without moving
  the user's reading position. When nothing older remains it shows the start
  of the conversation.
- Not a sliding window: nothing is ever removed from a transcript while it is
  shown, and a reconnect keeps everything shown. The window moves forward only
  when the chat is opened again (selected again or the page reloaded), which
  recomputes the last 24 hours — unless, within the same page load, the user
  had loaded earlier messages in that chat, which then reopens from the oldest
  turn they loaded.
- Choosing a chat-search snippet whose entry is older than the loaded window
  loads history back to that entry before revealing it.
- New additive wire messages (`chat-history-page` request and reply) and
  additive snapshot fields; older clients keep working and simply see the
  recent window. No change to stored data, transcripts, search, or replay
  parsing.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-sessions`: attaching delivers the recent history window instead of the
  whole conversation, and older history loads on request (modifies
  "Conversation events stream to the chat view"; adds windowed-history
  requirements).
- `chat-session-search`: jumping to a matched entry loads older history when
  the entry lies outside the loaded window (modifies "Results jump to the
  matched entry").

## Impact

- Server: `ChatSessionManager.getSnapshot` (window selection over memoized
  history + live events), `ChatConnections` (`chat-attach` optional
  `historyFrom`, new `chat-history-page` handler), `chatConnectionTypes.ts`
  whitelist, a new pure window module in `src/server/chat/`.
- Shared: `src/shared/types.ts` (snapshot fields, new client/server messages).
- Client: `chatStore` (prepend older pages, remember the window start),
  `protocol/chatMessages.ts`, `ChatMessages.tsx` (load-earlier control with
  scroll anchoring), `useRevealRow`/search reveal path.
- Not affected: transcript storage, the full-history memo (still built once
  per session — search reads it), session search results, mailbox delivery
  confirmation.

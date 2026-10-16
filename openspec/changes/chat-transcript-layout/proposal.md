# Proposal

## Why

Kawai's terminal archive makes conversations easy to scan through author labels, timestamps, and aligned text. Chat sessions should offer the same readability while retaining their live controls and detailed events; their header also needs to accommodate long model, project, and task labels without squeezing them into one metadata line.

## What Changes

- Give live and archived Chats a shared transcript layout with an author/time gutter on wide containers and metadata above the body on narrow containers.
- Align message bodies, use quiet separators between author changes, and keep related same-author output closely spaced.
- Display local message times with full date/time available on hover and to assistive technology; preserve stable times while text streams and when history replays.
- Keep response text before and after a tool call as separate entries in order, live and replayed.
- Retain every existing event detail and interaction: paired expandable tool calls/results, errors, workers, background tasks, peer context and threads, approvals/questions, activity, notices, and completion summaries.
- Organize the chat header into identity/actions, readable metadata, and wrapping task/paused context. Allow extra rows when necessary, keeping context usage visible and all session actions reachable.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Author/time presentation, responsive alignment, and preservation of the rich transcript across live and archived sessions.
- `chat-header`: Responsive identity, metadata, task, and context layout that allows additional rows instead of forcing all labels onto two lines.

## Impact

- Client components: `ChatMessages`, `ChatView`, `ChatHeader`, `ChatContextMeter`, transcript-related styles, and the header layout hook; worker/task rows as needed for alignment.
- Client component tests and browser coverage for long labels, narrow containers, larger chat fonts, streaming, replay, and interactive event details.
- Existing `ChatEvent.at` timestamps are the source; no new API, dependency, persistence schema, or terminal-preview changes are planned.
- Timestamp normalization in the client store and server replay will preserve message starts and avoid presenting fabricated times for undated history; replayed times come from transcript records and may trail the live start.
- The client store's assistant merge rule changes so text before and after a tool call in one response stays as separate, ordered entries (today the later text overwrites the earlier one).
- Coordinate with `team-workspace-pages`, which replaces the old header panel switcher with Team, and `codex-chat-sessions`, which introduces provider-specific identity. Preserve those behaviors without implementing either change here.

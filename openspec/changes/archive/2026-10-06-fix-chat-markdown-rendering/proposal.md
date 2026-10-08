# Proposal

## Why

In Claude Code chat sessions, assistant messages look like plain text. The
chat view parses the markdown but styles the output only with `prose`
classes. Those classes come from the Tailwind typography plugin, which is not
installed. Tailwind's preflight reset then removes the default heading, list,
code and quote styling. GFM is also turned off, so tables and strikethrough
appear as raw `|` and `~~` characters. Claude replies rely on this
formatting, which makes the chat transcript hard to read.

## What Changes

- Assistant text in the chat view renders with visible markdown formatting.
  This covers headings, emphasis, ordered and unordered lists, inline code,
  fenced code blocks, blockquotes, links, horizontal rules and GFM tables,
  strikethrough and task lists.
- The chat view and the session log preview share one markdown renderer, so
  both look the same. The preview already styles markdown correctly. The
  shared renderer is extracted from the preview's existing code.
- Links in assistant text open in a new tab with `noopener`.
- Raw HTML in assistant text stays inert, as it is today.
- Out of scope: user messages stay preformatted plain text. Tool-call and
  tool-result rendering, syntax highlighting and height limits on tool
  output are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Adds a requirement that defines what "render assistant
  text as markdown" means, which the existing "Conversation events stream to
  the chat view" requirement only states in general terms. The new
  requirement covers visible formatting, GFM support, inert raw HTML and
  unchanged user messages. The existing requirement is not modified.

## Impact

- `src/client/components/chat/ChatMessages.tsx`: switches to the shared
  renderer.
- `src/client/components/SessionPreviewContent.tsx`: the markdown component
  map and `MarkdownMessage` move into a new shared module, which also shrinks
  this 937-line file.
- New module under `src/client/components/` for the shared markdown
  renderer.
- Tests: `src/client/__tests__/chatComponents.test.tsx` and
  `src/client/__tests__/SessionPreviewModal.test.tsx`.
- Dependencies: none added. `react-markdown`, `remark-gfm` and `remark-breaks`
  are already installed.

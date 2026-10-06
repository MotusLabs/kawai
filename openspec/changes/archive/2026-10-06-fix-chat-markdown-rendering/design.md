# Design

## Context

Two client components render Claude markdown today:

```
SessionPreviewContent.tsx (session log preview)     ChatMessages.tsx (chat view)
  ReactMarkdown                                       ReactMarkdown
    remarkPlugins: [remarkGfm, remarkBreaks]            remarkPlugins: [remarkBreaks]
    components: markdownComponents                      (no components)
  per-element Tailwind classes that use the           wrapper: "prose prose-invert"
  theme tokens; works                                 no typography plugin, so the
                                                      classes do nothing
```

`tailwind.config.js` has `plugins: []`. The comment on
`SessionPreviewContent.tsx:466` says the preview styles markdown without the
typography plugin on purpose. `SessionPreviewContent.tsx` is 937 lines, well
over the project's 500-line limit for a file.

## Goals / Non-Goals

**Goals:**
- One markdown renderer used by both the chat view and the session log
  preview.
- The chat view gets the preview's current look, extended to cover the GFM
  elements the preview doesn't style yet: strikethrough and task lists.

**Non-Goals:**
- Syntax highlighting. It would add a dependency and a theming question, so
  it belongs in a separate change.
- Changing how user messages, tool calls, tool results or notices render.
- Changing the preview's visual output beyond the fixes listed below.

## Decisions

### 1. Extract a shared `Markdown` component instead of adding the typography plugin

Move `markdownComponents` and `MarkdownMessage` out of
`SessionPreviewContent.tsx` into `src/client/components/Markdown.tsx`. Export
one `Markdown` component that takes `{ content: string }`. It fixes the plugin
list at `[remarkGfm, remarkBreaks]` and wraps the output in the existing
`min-w-0 break-words text-sm leading-6 text-primary [overflow-wrap:anywhere]`
container. Both views import it. `ChatMessages.tsx` drops the `prose` wrapper
and its own `react-markdown` import.

- *Alternative: install `@tailwindcss/typography`.* This is a one-line fix,
  but it goes against the earlier "no typography plugin" decision. Its colours
  don't follow the CSS-variable theme tokens without a `typography` theme
  block, and the codebase would still have two renderers that can drift
  apart.
- *Alternative: copy the component map into the chat view.* This is the
  fastest option, but it creates exactly the drift that caused this bug.

### 2. Fix code-block detection by context, not content

The current `code` override treats code as a block only when it has a
`language-*` class or contains a newline. A one-line fenced block with no
language therefore gets the inline "chip" styling inside the `<pre>`. The
`pre` override will reset nested code styling with
`[&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit`, so styling
comes from where the code sits instead of from guessing at its content. The
inline chip stays the default for `code`.

### 3. Style the GFM elements the preview doesn't style yet

- `del`: `line-through text-secondary`.
- Task lists: `remark-gfm` gives the list `className="contains-task-list"` and
  each item `className="task-list-item"` with a disabled checkbox `input`.
  The `ul`/`ol` overrides drop `list-disc`/`list-decimal` and the left
  padding when the list carries `contains-task-list`, so the checkbox isn't
  shown next to a bullet. The `li` override passes `className` through.
- `h4`–`h6`: same treatment as `h3`, so deeper headings don't fall back to
  the reset's unstyled text.

### 4. Raw HTML handling stays as it is

`react-markdown` does not render raw HTML unless `rehype-raw` is added. We
won't add it. The existing chat test (`<script>` doesn't execute) stays and
moves into the shared renderer's tests.

### 5. Testing approach

- New `src/client/__tests__/Markdown.test.tsx` checks the shared component's
  DOM: element tags and key classes for each spec scenario (block, inline,
  GFM, line breaks, raw HTML, link `target`/`rel`).
- `chatComponents.test.tsx` asserts that an `assistant_text` event produces
  structured elements (for example a `table` and an `h2`) and that a
  `user_message` with markdown stays literal text.
- The existing preview markdown test in `SessionPreviewModal.test.tsx` must
  pass unchanged. That shows the extraction is a pure refactor for the
  preview.
- Visual check with the `dev-browser` skill: open a chat session with the
  development fixture and take a screenshot of a reply that uses headings,
  lists, a table and code.

## Risks / Trade-offs

- [The preview's markdown changes slightly: code-block detection, new
  `del`/task-list/`h4`–`h6` styles] → These are fixes, not regressions, and
  the existing preview test guards the elements it already covers.
- [Chat text gets `leading-6` and `text-primary` from the shared wrapper
  instead of whatever the `prose` classes gave] → `prose` did nothing, so
  chat text currently inherits the defaults. The new look matches the
  preview, which users already see.
- [`remark-breaks` turns single newlines into `<br>`, which can make
  hard-wrapped prose look ragged] → This matches current behaviour in both
  views and Claude Code's own rendering, and the spec makes it explicit.

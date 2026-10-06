# Tasks

## 1. Shared markdown renderer

- [x] 1.1 Create `src/client/components/Markdown.tsx` with a header comment. Move `markdownComponents` and `MarkdownMessage` out of `SessionPreviewContent.tsx` into it, unchanged, and export them as `Markdown({ content })` using `[remarkGfm, remarkBreaks]`. Switch `SessionPreviewContent.tsx` to import it. Verify the existing "renders message content as markdown" test in `SessionPreviewModal.test.tsx` passes unchanged and that `SessionPreviewContent.tsx` gets shorter.
- [x] 1.2 Add `src/client/__tests__/Markdown.test.tsx` covering the current behaviour: headings, lists, blockquote, rule, fenced code in `<pre>`, inline code chip, bold and italic, a link with `target="_blank"` and `rel` containing `noopener`, a GFM table with a header row, a bare URL autolink, single newline to `<br>`, and an inert `<script>`. Verify with `bun test src/client/__tests__/Markdown.test.tsx`.

## 2. Renderer fixes (design decisions 2 and 3)

- [x] 2.1 Reset nested code styling in the `pre` override (`[&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit`) so a one-line fenced block with no language doesn't get the inline chip styling. Add a test asserting the `pre` carries the reset classes for that input.
- [x] 2.2 Add a `del` override (`line-through text-secondary`) and `h4`–`h6` overrides matching `h3`. Add tests for `~~text~~` producing a styled `del` and for `####` producing a styled `h4`.
- [x] 2.3 Handle GFM task lists: make the `ul`/`ol` overrides drop the list marker and left padding when `className` contains `contains-task-list`, and make the `li` override pass `className` through. Add a test asserting that `- [ ] a` / `- [x] b` render disabled checkboxes, one checked, inside a list without `list-disc`.

## 3. Chat view uses the shared renderer

- [x] 3.1 In `src/client/components/chat/ChatMessages.tsx`, render `assistant_text` with the shared `Markdown` component. Remove the `prose prose-invert` wrapper and the direct `react-markdown`/`remark-breaks` imports. Verify `grep -rn "prose" src/client` returns nothing.
- [x] 3.2 Extend `src/client/__tests__/chatComponents.test.tsx`: an `assistant_text` with a heading, a table and `~~x~~` renders `h2`, `table` and `del` elements; the existing raw-HTML test still passes; a `user_message` whose text is `**not bold**` shows those literal characters and contains no `strong`. Verify with `bun test src/client/__tests__/chatComponents.test.tsx`.

## 4. Development fixture and visual check

- [x] 4.1 In `src/server/chat/developmentFixture.ts`, add a `/markdown/i` prompt branch that replies with a sample containing headings, both list types, a task list, a table, inline and fenced code, a blockquote, a link and strikethrough. Cover it in the fixture's existing tests. Verify that test passes.
- [x] 4.2 Run `bun run lint && bun run typecheck && bun run test` and confirm all three pass.
- [x] 4.3 With `AGENTBOARD_CHAT_FIXTURE=1 bun run dev`, use the `dev-browser` skill to open a chat session and send "markdown". Take a screenshot and confirm each element in the chat-sessions delta scenarios is visibly formatted. Then open a session log preview containing markdown and confirm it looks the same.

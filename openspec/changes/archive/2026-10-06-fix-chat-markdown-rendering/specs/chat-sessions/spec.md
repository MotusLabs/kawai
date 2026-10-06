# Spec Delta

## ADDED Requirements

### Requirement: Assistant markdown renders with visible formatting
The chat view SHALL render assistant text as formatted content, not as plain
text. Block and inline markdown elements and GitHub-flavored markdown
extensions SHALL each be visually distinct from body text. Single line breaks
inside a paragraph SHALL be preserved. Raw HTML in assistant text SHALL NOT be
rendered or executed. User messages SHALL keep their literal text.

#### Scenario: Block elements are formatted
- **WHEN** assistant text contains a heading, a bulleted list, a numbered list, a blockquote, a horizontal rule and a fenced code block
- **THEN** the heading is larger or bolder than body text, list items show bullets or numbers and are indented, the blockquote is visually set off, the rule is visible, and the code block appears in a monospace block whose whitespace is preserved and whose wide lines scroll horizontally instead of overflowing the transcript

#### Scenario: Inline elements are formatted
- **WHEN** assistant text contains bold, italic, inline code and a link
- **THEN** bold and italic are visibly emphasized, inline code is visually distinct from surrounding text, and the link is visibly a link that opens in a new browser tab without giving the opened page access to the chat window

#### Scenario: GitHub-flavored markdown is supported
- **WHEN** assistant text contains a pipe table, `~~strikethrough~~`, a task list and a bare URL
- **THEN** the table renders as a bordered table with a header row, the strikethrough text is struck through, task list items show checkboxes, the bare URL is a link, and no raw `|` or `~~` syntax is visible

#### Scenario: Single line breaks are kept
- **WHEN** assistant text contains two lines separated by a single newline
- **THEN** they render on separate lines

#### Scenario: Raw HTML stays inert
- **WHEN** assistant text contains raw HTML such as a `<script>` tag
- **THEN** no script runs and no element is created from that HTML

#### Scenario: User messages are not reformatted
- **WHEN** the user sends a message that contains markdown syntax
- **THEN** the user's turn shows the literal text with its whitespace preserved

#### Scenario: Chat and session preview render markdown the same way
- **WHEN** the same markdown text appears as an assistant message in the chat view and in the session log preview
- **THEN** both render the same elements with the same styling

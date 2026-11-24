# Spec Delta

## ADDED Requirements

### Requirement: Team navigation preserves the application viewport

Team navigation and task or plan controls SHALL keep the application shell anchored to the viewport, with no document scrolling that clips its top or leaves a blank strip below it. Long navigator and chat content, including visually hidden accessibility labels, SHALL remain within their owning scroll areas.

#### Scenario: Answer a plan question from attention
- **GIVEN** the navigator contains enough worktree rows to scroll and a plan decision card is below the visible plan content
- **WHEN** the human activates **Answer the question** in the attention queue
- **THEN** the plan opens with the requested card revealed and focused
- **AND** the document stays at its origin and the application shell continues to fill the viewport
- **AND** the navigator keeps its scroll position

#### Scenario: Open a stopped change from attention
- **GIVEN** the navigator is scrolled and the requested stopped change is below the visible plan content
- **WHEN** the human activates the attention item's **Retry or stop execution** action
- **THEN** the requested change is revealed and focused inside the plan content
- **AND** the document and application shell keep their viewport positions

#### Scenario: Use controls inside a selected record
- **GIVEN** a task or plan detail is open with long content
- **WHEN** the human opens and cancels an inline action form, including a plan's **Answer** or **Retry** confirmation
- **THEN** the document stays at its origin and the application shell continues to fill the viewport
- **AND** the form and its controls remain reachable through the detail's own scroll area

### Requirement: Plan reveals scroll only the owning content pane

Revealing a plan decision card or change SHALL scroll only that plan's content pane and focus the requested target without additional ancestor scrolling. A target that fits SHALL be fully visible; a taller target SHALL expose its beginning and remain scrollable. A missing target SHALL retain the existing fallback to the plan title and consume the request once.

#### Scenario: Reveal a card that fits
- **WHEN** an attention link opens a decision card shorter than the available plan content height
- **THEN** the full card is visible within the plan content and owns keyboard focus
- **AND** the document, application shell, navigator, and attention list keep their scroll positions

#### Scenario: Reveal a target taller than the pane
- **WHEN** an attention link opens a change or card taller than the available plan content height
- **THEN** the target's beginning is visible and the target owns keyboard focus
- **AND** the human can scroll the plan content to reach the rest without shifting the application shell

#### Scenario: A reveal target no longer exists
- **WHEN** an attention link names a change or decision card absent from the loaded plan
- **THEN** the detail falls back to its title without a navigation error
- **AND** a later plan update does not replay the consumed reveal or unexpectedly move focus or scroll

### Requirement: Hidden labels retain accessibility without document overflow

Accessibility labels in the application surrounding the Team page SHALL remain available to assistive technology while visually hidden. Their positions SHALL NOT extend the document's scrollable height beyond the application viewport when their owning navigator or chat content is long or scrolled.

#### Scenario: Long navigator retains state labels
- **WHEN** a long navigator with dirty, detached, or stale worktree state labels is scrolled and the Team page is opened
- **THEN** those state labels remain available to assistive technology and visually hidden
- **AND** they do not add document-level scrollable space

#### Scenario: Return from a long chat transcript
- **GIVEN** a long chat transcript contains hidden full timestamps, repeated-author labels, and copy-feedback status regions
- **WHEN** the human scrolls the transcript and opens the Team page
- **THEN** the application stays anchored to and fills the viewport
- **AND** the hidden transcript metadata remains available when returning to the chat without creating document-level scrollable space

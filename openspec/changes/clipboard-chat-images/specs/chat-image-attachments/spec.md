# Spec Delta

## Purpose

Lets users paste visual context into Claude and Codex chat sessions, review it before sending, and see the same images when reading the conversation later.

## ADDED Requirements

### Requirement: Clipboard images become removable draft previews
The chat composer SHALL accept image files exposed by a user-initiated paste event and show ordered thumbnail previews with keyboard-accessible remove controls. Pasting SHALL NOT send a message or upload an image. Ordinary text paste SHALL retain its existing behavior.

#### Scenario: Paste a screenshot
- **WHEN** a user pastes clipboard image data into a live chat composer
- **THEN** a thumbnail appears without sending a turn or uploading bytes

#### Scenario: Paste multiple images and remove one
- **WHEN** the user pastes several images, then removes the middle preview
- **THEN** the remaining previews retain their order and only those images are included when sent

#### Scenario: Ordinary text paste
- **WHEN** the clipboard exposes text without image files
- **THEN** the text is inserted at the current selection with the existing composer behavior

#### Scenario: Image and text in one paste
- **WHEN** the clipboard exposes image files and a text representation in one paste
- **THEN** the images are attached once and the text representation is not inserted automatically

#### Scenario: Browser withholds image bytes
- **WHEN** a paste event advertises an image but exposes no readable image file
- **THEN** the composer explains that the browser did not provide image data and the existing draft is preserved

### Requirement: Image drafts belong to their chat session
Unsubmitted images SHALL remain client-local and belong to the same per-session draft as the text. They SHALL survive navigation, reconnect, and archive followed by restore within the current page lifetime. Killing the session or reloading the page SHALL discard its image draft. An asynchronous completion SHALL NOT change a different or newer draft.

#### Scenario: Switch sessions during preparation
- **WHEN** a user pastes in chat A, switches to chat B before preparation completes, and returns to A
- **THEN** only A contains the image and B's draft is unchanged

#### Scenario: Reconnect and restore
- **WHEN** a chat with an image draft reconnects or is archived and restored without reloading the page
- **THEN** its text and image previews are still present

#### Scenario: Reload or kill
- **WHEN** the page reloads or the session is killed
- **THEN** its unsubmitted images are discarded

### Requirement: Both agent runtimes accept images with optional text
A connected live chat SHALL allow a message containing text, one or more images, or both. Images SHALL be submitted in preview order as native image inputs to Claude or Codex. An empty message SHALL NOT be sent. Image preparation or upload in progress SHALL prevent partial submission.

#### Scenario: Claude receives text and images
- **WHEN** the user sends text and two images to a Claude chat
- **THEN** Claude receives the text and both images as image content in preview order

#### Scenario: Codex receives an image-only message
- **WHEN** the user sends one image with no text to a Codex chat
- **THEN** Codex receives the image as image content and the transcript shows the image-only user message

#### Scenario: Image-only Claude and mixed Codex messages
- **WHEN** an image-only message is sent to Claude or text with images is sent to Codex
- **THEN** the selected runtime receives every image as image content with any supplied text

#### Scenario: Pending upload
- **WHEN** one image is still preparing or uploading when Send is activated
- **THEN** no partial message reaches the agent and the interface shows the pending work

#### Scenario: No message content
- **WHEN** the draft contains only whitespace and no images
- **THEN** Send is unavailable and no turn starts

### Requirement: Image submissions are bounded and session scoped
The system SHALL accept PNG, JPEG, GIF, and WebP images with matching recognized file signatures, at most four images per message and at most 5 MiB per image. Uploads and sends SHALL validate these limits server-side. Image references SHALL belong to the addressed chat; filesystem paths and remote URLs SHALL NOT be accepted as image references.

#### Scenario: Accepted boundary
- **WHEN** the user sends four supported images each no larger than 5 MiB
- **THEN** the message is accepted if the chat's ordinary send checks also pass

#### Scenario: Invalid image or limit exceeded
- **WHEN** a submission has an unsupported type, a mismatched signature, an image larger than 5 MiB, or more than four images
- **THEN** the invalid operation is refused with a useful error and no partial user turn is sent

#### Scenario: Another session's image reference
- **WHEN** a client sends or requests an image reference owned by another chat, a forged reference, a filesystem path, or a remote URL
- **THEN** the operation is refused without exposing unrelated bytes or sending a turn

#### Scenario: Archived or missing chat
- **WHEN** a client uploads or sends images to an archived or missing chat
- **THEN** the operation is refused and no agent is started for it

### Requirement: Refused or uncertain sends preserve recoverable input
Upload or pre-acceptance send failures SHALL preserve the submitting draft's text and images for explicit retry without overwriting newer edits. Losing the connection after submission SHALL NOT automatically resend the message. The interface SHALL distinguish an unconfirmed send from a confirmed refusal or acceptance.

#### Scenario: Upload fails
- **WHEN** an image upload fails before the turn is submitted
- **THEN** the text and images remain available and the user sees the error

#### Scenario: Send is refused
- **WHEN** the server refuses the correlated image send before acceptance
- **THEN** its text and images are recoverable and no turn is sent

#### Scenario: Reply is lost
- **WHEN** the connection drops after submission and before its result arrives
- **THEN** the draft remains recoverable as an unconfirmed submission and reconnect does not resend it

#### Scenario: User has newer edits
- **WHEN** a late failure or result arrives after the user has changed the draft
- **THEN** it does not clear or overwrite those edits and the earlier submission remains separately recoverable when needed

### Requirement: Sent images remain part of conversation history
Submitted images SHALL be rendered with their user message in live views, reconnect snapshots, history pages, and replay of retained native transcripts after restart, reload, or archive. Archive and interrupt SHALL retain the images. Image bytes SHALL travel over HTTP for browser upload and normal conversation display. The opt-in Debug view SHALL retain its existing verbatim protocol-frame behavior, including native image data.

#### Scenario: Reload and restart
- **WHEN** a conversation whose native transcript recorded image input is reopened after a page reload or server restart
- **THEN** each user message shows its text and images once in their original order, including image-only messages

#### Scenario: Archived and older history
- **WHEN** the user opens an archived chat or loads an older history page containing images
- **THEN** those images are visible with their messages and reading them does not start an agent

#### Scenario: Interrupt retains sent images
- **WHEN** the user interrupts a turn after sending images
- **THEN** the sent images remain visible with the user message

#### Scenario: Image file is unavailable
- **WHEN** an image asset is missing or unreadable while its message remains in history
- **THEN** the message remains visible with an image-unavailable placeholder and no unrelated file is served

### Requirement: Image attachments coexist with existing composer controls
Image paste SHALL work in ordinary and embedded chat composers alongside captured plan context. Existing slash-command selection and text-only local reset commands SHALL retain their behavior. A local reset command with images SHALL be refused visibly without discarding the draft or creating a replacement chat. Archived views SHALL remain read-only.

#### Scenario: Plan context with images
- **WHEN** the user sends images and a captured plan context from a host whose runtime supports that context
- **THEN** the message carries both, with the typed text preserved and the existing context validation applied before sending

#### Scenario: Runtime cannot carry plan context
- **WHEN** a message includes images and plan context for a runtime that does not support plan context
- **THEN** the whole message is refused with the existing context error and the draft remains recoverable

#### Scenario: Slash menu and reset
- **WHEN** a slash-menu option is selected with images attached
- **THEN** it inserts the command without sending; attempting a local reset command with those images explains that they must be removed first and keeps the draft

#### Scenario: Archived view
- **WHEN** the user opens an archived chat containing images
- **THEN** the images are readable and no composer or image-removal controls are shown

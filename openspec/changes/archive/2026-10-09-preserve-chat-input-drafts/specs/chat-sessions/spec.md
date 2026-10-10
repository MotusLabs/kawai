# Spec Delta

## ADDED Requirements

### Requirement: Chat composer drafts are kept per session

The chat view SHALL keep unsubmitted composer input as per-session draft state. A session's draft SHALL be preserved while its chat remains available in the client, and each chat's composer SHALL show only that session's draft. Drafts SHALL be client-side state only: they SHALL survive WebSocket reconnects but SHALL NOT be sent to the server or restored after a page reload.

#### Scenario: Draft survives switching to another chat and back
- **WHEN** the user types text into chat A's composer without submitting, switches to chat B, and switches back to chat A
- **THEN** chat A's composer shows the previously typed text and chat B's composer showed chat B's own draft, not chat A's

#### Scenario: Each chat keeps its own draft
- **WHEN** the user types different unsubmitted text into chats A and B
- **THEN** switching between A and B shows each chat's own text in its composer

#### Scenario: Submitting clears only that chat's draft
- **WHEN** the user submits the message typed in chat A while chat B has an unsubmitted draft
- **THEN** chat A's composer is empty and chat B's draft is unchanged

#### Scenario: Removing a session discards its draft
- **WHEN** a chat session with an unsubmitted draft is killed and removed
- **THEN** its draft is discarded and does not reappear

#### Scenario: Draft survives a WebSocket reconnect
- **WHEN** the connection drops and reconnects while a chat has an unsubmitted draft
- **THEN** the draft remains in that chat's composer after reconnect

#### Scenario: Draft survives archive and restore
- **WHEN** a chat with an unsubmitted draft is archived and later restored
- **THEN** the restored chat's composer shows the pre-archive draft

#### Scenario: Drafts are not restored after a page reload
- **WHEN** the page is reloaded after typing an unsubmitted draft
- **THEN** the chat's composer is empty

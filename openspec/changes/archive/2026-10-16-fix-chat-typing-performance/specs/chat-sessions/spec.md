# Spec Delta

## ADDED Requirements

### Requirement: Composer editing stays responsive in long conversations
The chat composer SHALL display edits and respond to caret and slash-command interactions without waiting for unchanged conversation history to be processed again. Growing conversation history SHALL NOT add history-proportional work to an edit when the history has not changed. This SHALL apply while the chat is idle and while new output arrives.

#### Scenario: Type in a long idle conversation
- **WHEN** the user types, deletes, pastes, or moves the caret in a connected chat with hundreds of prior messages and no incoming events
- **THEN** the composer reflects each edit and caret interaction without reprocessing the unchanged history
- **AND** history remains available with its existing formatting and expanded disclosures

#### Scenario: Use slash commands with a long history
- **WHEN** the user opens, filters, navigates, and chooses from the slash-command menu in a chat with hundreds of prior messages
- **THEN** the menu and caret respond without reprocessing unchanged history
- **AND** choosing a command inserts it without sending a message

#### Scenario: Edit while output streams
- **WHEN** new assistant output arrives while the user edits an unsubmitted draft in a long conversation
- **THEN** the draft retains the user's edits, focus, and selection while new output appears in order
- **AND** incoming output does not cause unchanged assistant message bodies to be processed again merely to update a different message

#### Scenario: Submit after editing a long conversation
- **WHEN** the user submits the edited draft in a connected chat with hundreds of prior messages
- **THEN** the submitted text follows the existing message or local-command behavior
- **AND** only the submitting session's draft is cleared

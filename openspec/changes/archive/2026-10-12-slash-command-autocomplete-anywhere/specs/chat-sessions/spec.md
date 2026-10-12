# Spec Delta

## MODIFIED Requirements

### Requirement: The composer offers a slash-command menu
The chat composer SHALL open a command menu while the caret is in a word that starts with `/` at the start of the message or after whitespace, filtering the session's commands by that word against names and aliases first and descriptions second. The menu SHALL be operable by keyboard and pointer. Choosing a command SHALL replace that word with `/<name> ` without sending and SHALL show the command's argument hint. The menu SHALL indicate when the list is loading and SHALL NOT block sending.

#### Scenario: Filter and choose by keyboard
- **WHEN** the user types `/re` and presses Enter while a matching command is highlighted
- **THEN** the composer contains `/<chosen name> `, the argument hint is shown, and no message is sent

#### Scenario: Open in the middle of a message
- **WHEN** the composer contains `please run ` and the user types `/re` after it
- **THEN** the menu opens and lists the commands matching `re`

#### Scenario: Open at the start of a later line
- **WHEN** the composer contains a first line and the user types `/` at the start of the second line
- **THEN** the menu opens and lists all commands

#### Scenario: Choose in the middle of a message
- **WHEN** the composer contains `please run /re on this` with the caret just after `/re` and the user chooses a command
- **THEN** the composer contains `please run /<chosen name> on this`, the caret sits just after `/<chosen name> `, the argument hint is shown, and no message is sent

#### Scenario: A slash inside a word or path does not open the menu
- **WHEN** the caret follows `and/or`, `https://example`, or `/usr/bin`
- **THEN** the menu stays closed

#### Scenario: Moving the caret away closes the menu
- **WHEN** the menu is open for a `/` word and the user moves the caret out of that word or selects text
- **THEN** the menu closes, and it opens again when the caret returns into a `/` word

#### Scenario: Dismiss the menu
- **WHEN** the menu is open and the user presses Escape
- **THEN** the menu closes and the composer text is unchanged

#### Scenario: Send while the menu has no match
- **WHEN** the typed command matches no listed command and the user presses Enter
- **THEN** the menu does not intercept Enter and the message is sent as typed

#### Scenario: A command in the middle of a message is sent as typed
- **WHEN** the user sends `please run /clear later`
- **THEN** the message is sent to the agent as typed and no new chat is created

#### Scenario: List still loading
- **WHEN** the user types `/` before the command list is ready
- **THEN** the menu shows that commands are loading

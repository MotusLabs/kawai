# Spec Delta

## ADDED Requirements

### Requirement: Chat view uses a reduced-glare dark palette
In the dark theme, the chat view SHALL render on a lifted dark-gray background
with off-white text instead of the app's near-black palette. Primary message
text SHALL have a contrast ratio between 7:1 and 10:1 against the chat
background. Secondary text SHALL have at least 4.5:1 against every chat
surface it appears on. The light theme and views outside the chat view SHALL
be unchanged.

#### Scenario: Assistant and user messages in the dark theme
- **WHEN** the dark theme is active and the chat view shows user and assistant messages
- **THEN** the transcript background is a dark gray rather than near-black, and message text measures between 7:1 and 10:1 contrast against it

#### Scenario: Secondary text stays readable on every chat surface
- **WHEN** role labels, tool-activity summaries, notices or the session header details appear on the chat background, inside the user-message bubble, or on an approval or question card
- **THEN** that text measures at least 4.5:1 contrast against the surface behind it

#### Scenario: Status and error colors follow the palette
- **WHEN** the chat view shows an error, or the Debug panel lists outgoing, incoming, stderr and lifecycle frames
- **THEN** each of these colors comes from the chat palette, stays distinguishable from the others, and measures at least 4.5:1 contrast against the chat background

#### Scenario: Primary actions remain legible
- **WHEN** the chat view shows a primary button such as Send, Allow, Submit answers or Restore
- **THEN** its label measures at least 4.5:1 contrast against the button background

#### Scenario: Rest of the app keeps its dark palette
- **WHEN** the dark theme is active and the user looks at the session navigator, a terminal session or a modal while a chat session is open
- **THEN** those areas keep the app's existing dark colors

#### Scenario: Light theme is unchanged
- **WHEN** the light theme is active and the user opens a chat session
- **THEN** the chat view uses the app's existing light colors

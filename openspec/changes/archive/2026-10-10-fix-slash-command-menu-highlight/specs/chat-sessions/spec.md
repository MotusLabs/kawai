# Spec Delta

## ADDED Requirements

### Requirement: The slash-command menu marks the selected option
The slash-command menu SHALL visually distinguish the currently selected option from the other options, and SHALL visually distinguish a pointer-hovered option from the menu surface. The selection mark SHALL follow keyboard navigation (Up/Down) and pointer hover so the option that Tab or Enter will insert is always the one that looks selected. The mark SHALL be built from theme tokens so it stays visible in the light theme and in the chat palette.

#### Scenario: Selection follows the arrow keys
- **WHEN** the slash-command menu is open with more than one match and the user presses Down then Up
- **THEN** the visual selection mark moves to the next option and then back, and only one option carries the mark at a time

#### Scenario: The first option starts selected
- **WHEN** the menu opens or the composer text changes so the match list is recomputed
- **THEN** the first matching option carries the selection mark

#### Scenario: Hover differs from the menu surface
- **WHEN** the pointer moves over an option that is not the selected one
- **THEN** that option is visually distinguished from the menu background

#### Scenario: Tab inserts the marked option
- **WHEN** the user moves the selection with the arrow keys and presses Tab
- **THEN** the composer contains the marked option's `/<name> ` and the menu closes

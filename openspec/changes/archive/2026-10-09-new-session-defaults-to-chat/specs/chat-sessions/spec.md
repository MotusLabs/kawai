# Spec Delta

## ADDED Requirements

### Requirement: New-session dialog preselects Claude Code chat
The new-session dialog SHALL preselect the chat kind when it opens, so
creating a Claude Code chat session needs no kind switch. Entry points that
open the dialog for a specifically terminal purpose — the OpenSpec change
section actions that offer the terminal-only first-prompt selector — SHALL
preselect the terminal kind instead. The dialog SHALL recalculate the
preselected kind from the current entry point at every open, regardless of
how any previous open ended.

#### Scenario: Dialog opens with chat preselected
- **WHEN** the user opens the new-session dialog from the header button or the keyboard shortcut
- **THEN** the session-kind selector shows Claude Code chat as the selected value, the profile selector is visible, and no command presets are shown

#### Scenario: Change-section entry point preselects terminal
- **WHEN** the user opens the new-session dialog from an OpenSpec change section action
- **THEN** the session-kind selector shows Terminal as the selected value and the first-prompt selector is visible

#### Scenario: Reopening follows the same rule
- **WHEN** the user closes the dialog, having switched the kind to Terminal, and reopens it outside a change section
- **THEN** the session-kind selector shows Claude Code chat again

#### Scenario: Entry point switches between opens
- **WHEN** the user closes the dialog opened from a generic entry point and reopens it from an OpenSpec change section, or the reverse
- **THEN** each open preselects the kind of its own entry point — Terminal for the change section and Claude Code chat for the generic one

### Requirement: Switching session kind preserves form entries
When the user changes the session kind in the new-session dialog, the
project path, display name, and any entries made for the previously
selected kind SHALL be retained, and the newly selected kind's fields SHALL
appear with their own defaults.

#### Scenario: Kind switch keeps path and name
- **WHEN** the user enters a project path and display name, then switches the session kind
- **THEN** the project path and display name remain as entered and the fields of the newly selected kind are shown

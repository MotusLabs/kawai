# Design

## Context

`NewSessionModal.tsx` owns the dialog's full lifecycle: `kind` starts as
`'terminal'` (initial state) and is reset to `'terminal'` when the dialog
closes. `App` keeps the modal mounted across opens and sets the `initial*`
props in the same batched update as `isOpen`, so any kind recorded at
close time describes the previous entry point, not the next one. The modal
already receives `initialAutoStartChange` — the OpenSpec change name passed
only by change-section entry points — and shows the terminal-only "Start
with" selector for `kind === 'terminal' && initialAutoStartChange`. Initial
focus lands on the active command-preset chip via `defaultButtonRef`; that
chip renders only for the terminal kind. The chat profile catalog
(`useClaudeProfiles(isOpen && kind === 'chat')`) fetches per open with no
cache; Create is disabled while it loads or errors, and the existing focus
attempt is a single `focus()` call ~50 ms after open — a disabled Create is
unfocusable, so that attempt no-ops on any load that outlives 50 ms.

## Goals / Non-Goals

**Goals:**

- One rule for the preselected kind, applied identically to initial state,
  open, and reopen.
- Keep Enter-submits and initial focus working when chat is preselected,
  including while the profile catalog loads.

**Non-Goals:**

- No persistence of a last-used kind; the default is fixed by entry point.
- No renaming of the "Claude chat" option label, no new kinds, no changes
  to validation or the create flow.

## Decisions

### Recalculate the default on every closed→open transition

A tiny helper `defaultKind(initialAutoStartChange?: string)` returns
`'terminal'` when a change context is present (the dialog exists there to
offer the terminal-only first-prompt selector), `'chat'` otherwise. The
closed→open branch of the lifecycle effect calls
`setKind(defaultKind(initialAutoStartChange))` with the prop value of the
open render; the close branch stops touching `kind`, and the `useState`
initializer merely seeds the generic default for first paint.

- *Why at open, not close?* `App` batches the `initial*` setters with
  `setIsOpen(true)`, so the effect's first run after opening sees the
  current entry point. A close-time reset records the previous entry
  point: generic → change-section would open Chat and hide the Start-with
  selector; change-section → generic would open Terminal. Both violate the
  spec's recalculation rule.
- *Why not a `defaultKind` prop from App?* The modal already owns the
  open/reset lifecycle and already receives `initialAutoStartChange` as the
  change-section marker; a second prop would duplicate that signal.
- *Why not persist the last-used kind?* The request is a fixed default;
  persistence adds settings surface and surprises (reopen-after-terminal
  would stop matching the spec's "reopening follows the same rule").

### Provisional focus: Create when enabled, kind select as fallback

With chat default there is no command-preset chip, so `defaultButtonRef`
would stay unset and nothing receives focus (the dialog's Tab trap still
works, but Enter-to-submit is lost). When `kind === 'chat'`, attach
`defaultButtonRef` to the Create submit button: it is the dialog's primary
action and native Enter activation submits — same outcome as today's
focused preset chip (whose Enter path goes through the `command-select`
branch of the keydown handler).

Create is disabled while the catalog loads or errors, and a disabled
button cannot take focus, so focus becomes provisional:

- The initial attempt (existing ~50 ms timeout) focuses Create when it is
  enabled; otherwise it focuses the session-kind select, which is always
  rendered and never disabled. The element the dialog focused is recorded
  in a provisional-focus ref.
- A catch-up effect runs when the catalog settles successfully while the
  dialog is open with chat kind: if the currently focused element is still
  the provisional one, focus moves to the now-enabled Create. Focus the
  user moved themselves never matches the provisional ref, so it is never
  stolen.
- On a catalog error Create never enables; focus rests on the kind select,
  whose Tab order reaches the Retry-profiles button.

Alternative considered: focus the project-path input. Rejected — it is
already prefilled and Create is the dialog's primary action and today's
de-facto focus target.

### Leave kind-dependent rendering as is

The existing conditional blocks (profile selector, command presets, host
picker, Start with) already key off `kind`, so a different preselection
needs no structural change. Switching kinds already preserves `projectPath`
and `name` because they are independent state — the spec pins this, tests
assert it.

## Risks / Trade-offs

- [Profiles fetch now fires on every generic dialog open] → Accepted: one
  small local request per open, already the case whenever a user switched
  to chat; the Create button's disabled state communicates the load.
- [Catalog error leaves Create disabled by default] → Provisional focus
  rests on the always-enabled kind select, whose Tab order reaches the
  Retry button; switching to Terminal still enables Create.
- [Terminal-first users pay an extra click] → Accepted; change-section
  entry points, where apply work starts, keep the Terminal default.

## Migration Plan

Client-only, no data or API change; ships in the next build, rollback is
reverting the one component.

## Open Questions

None.

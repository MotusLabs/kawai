# Design

## Context

`src/client/App.tsx` detects status transitions in two WebSocket handlers and calls `playPermissionSound()` / `playIdleSound()` from `src/client/utils/sound.ts`:

- `sessions` (full list): compares each incoming session to the store copy before `setSessions`.
- `session-update` (single session): captures the previous status, calls `updateSession`, then plays.

Both blocks duplicate the same two conditions inline and know nothing about selection. `useSessionStore` holds `selectedSessionId` (live terminal or chat session); `playIdleSound` has its own 500 ms rate limit. App tests cannot easily assert on sound calls — the existing "sound notifications fire …" test only checks the session list, and `mock.module` registrations leak across bun test files.

## Goals / Non-Goals

**Goals:**
- One rule for both handlers, decided by a pure function that is unit-tested directly.
- Suppress only the Idle sound, only for the selected session, only while the page is visible.

**Non-Goals:**
- Changing the Permission sound, tones, rate limiting, or AudioContext handling.
- A user-facing setting for this behavior.
- Treating a focused-but-not-selected session, split views, or window focus (as opposed to page visibility) as "watched".

## Decisions

**Pure decision module.** Add `src/client/utils/soundTransitions.ts` exporting a function that takes the previous status, next status, whether the session is the selected one, whether the page is visible, and the two sound settings, and returns which sounds to play (`{ permission: boolean, idle: boolean }`). Both App handlers call it and then invoke the existing play functions. Alternative: add a `selected` check inline in both blocks — rejected because it duplicates the rule again and stays untestable without mocking the sound module.

**Selection source.** Read `useSessionStore.getState().selectedSessionId` inside each handler at the moment the transition is detected, before the handler applies the new list (in the `sessions` handler selection may be rewritten later in the same handler, e.g. after a hibernate/wake). The pre-update selection is what the user was looking at when the turn finished.

**Visibility source.** `document.visibilityState === 'visible'`, read at detection time; when `document` is unavailable (tests, SSR), treat the page as hidden so the sound behaves as before. Alternative: `document.hasFocus()` — rejected because a visible dashboard on a second monitor without focus is still being watched, and the user chose "suppress only while the tab is visible".

## Risks / Trade-offs

- [The user looks at a visible tab but is not actually watching the selected session] → Accepted; the transcript/terminal and status dot still show the change, and other sessions still chime.
- [A selected session's idle transition and a background session's land in one snapshot] → The decision is per session, so the background session still plays; the shared rate limit means at most one chime either way.

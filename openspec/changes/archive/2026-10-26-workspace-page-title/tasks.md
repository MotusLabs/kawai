# Tasks

## 1. Derive the workspace title

- [x] 1.1 Add the pure page-title formatter in `src/client/utils/pageTitle.ts`, implementing the directory precedence, trailing-slash handling, literal name preservation, and `Kawai` fallback. Add `src/client/utils/__tests__/pageTitle.test.ts` with the design's T1–T7 table verbatim, alongside the formatter. Verify with `bun run test src/client/utils/__tests__/pageTitle.test.ts`: T1 kills reversed directory precedence; T2 kills missing cwd fallback; T3 kills empty-default and trailing-slash failures; T4 kills accepting a nameless root as the workspace; T5 kills case/Unicode/space loss and repeated trailing-slash failures; T6 kills rendering an absent name; T7 kills rendering separator-only names. Include null and undefined variants for absent fields.

## 2. Apply the title in the running app

- [x] 2.1 Wire the formatter to `document.title` in `src/client/App.tsx` using successful server-info state and the existing reconnect fetch. Keep `index.html`'s fallback. Extend `src/client/__tests__/app.test.tsx` with the design's L1–L6 table verbatim, splitting L1 alternatives and L3 events into separate cases, and initialize/restore the document title in test setup. Verify with `bun run test src/client/__tests__/app.test.tsx`: L1 kills writing an absent-name prefix while loading; L2 kills omitting the production title effect; L3 kills deriving identity from the selected session, route, filter, or browser default; L4 kills failing to update the title after reconnect; L5 kills resetting title on failed refresh; L6 kills retaining a stale title after a successful nameless response.

## 3. Integration validation

- [x] 3.1 Run `bun run check` and report its result together with an oracle-to-test-title-and-killed-mutant map for T1–T7 and L1–L6 (including expanded cases). Confirm the focused tests reject the named mutations before reporting each as killed; no mutation-testing dependency is needed. Verify the integrated app still satisfies L2/L4 (mutant: remove title effect or its server-info dependency) and L3/L5 (mutant: replace the server-derived name with browser defaults or clear it on refresh failure). Keep the tables and tests with their corresponding implementation when committing.

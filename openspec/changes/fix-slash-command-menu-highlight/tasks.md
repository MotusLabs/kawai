# Tasks

## 1. Restore visible selection in the slash-command menu

- [x] 1.1 In `SlashCommandMenu.tsx`, replace `bg-primary-accent text-primary` on the highlighted row with the decided accent treatment and replace `hover:bg-elevated` with `hover:bg-hover`; verify the highlighted row's className carries the accent utility, the unhighlighted rows carry the hover utility, and `aria-selected` still tracks the highlight (extend `chatComponents.test.tsx`)
- [x] 1.2 Add a token-resolution unit test that every `bg-*` / `text-*` color utility used by `SlashCommandMenu.tsx` maps to a `theme.extend.colors` key or a default Tailwind palette color; verify it fails against a `bg-primary-accent` class and passes after 1.1

## 2. Visual confirmation

- [x] 2.1 Start the app and open a chat composer, type `/`, and confirm with a screenshot that one option is visibly marked, that ArrowDown/ArrowUp move the mark, and that hovering an unmarked option lifts it off the menu surface (dev-browser; light theme and chat palette)

## 3. Project checks

- [x] 3.1 Run `bun run lint && bun run typecheck && bun run test` and verify all three pass

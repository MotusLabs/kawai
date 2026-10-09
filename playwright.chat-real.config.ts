// Opt-in real SDK validation owns its server and isolated tmux/config/DB state.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['chat-real.spec.ts', 'chat-naming-real.spec.ts'],
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: 'list',
  use: { headless: true },
})

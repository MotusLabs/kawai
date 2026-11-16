// @reads: src/client/**
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function directIdLookup(source: string): boolean {
  return /\b(?:sessions|currentSessions)\s*\.\s*(?:find|some)\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\s*\.\s*id\s*===/i.test(source)
}
test('registry-row lookups use selectors across the current client inventory', async () => {
  const bad: string[] = []
  for await (const path of new Bun.Glob('src/client/**/*.{ts,tsx}').scan('.')) {
    if (path.includes('/__tests__/') || path.endsWith('/sessionStore.ts')) continue
    if (directIdLookup(readFileSync(path, 'utf8'))) bad.push(path)
  }
  expect(bad).toEqual([])
})
test('lookup guard detects compact and spaced component lookups', () => {
  expect(directIdLookup('state.sessions.find(s=>s.id===id)')).toBe(true)
  expect(directIdLookup('sessions.some((session) => session.id === selected)')).toBe(true)
  expect(directIdLookup('state.sessions[id]?.events')).toBe(false)
})

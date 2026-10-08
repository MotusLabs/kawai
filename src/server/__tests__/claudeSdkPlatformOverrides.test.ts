// The SDK's bundled platform CLI packages are excluded via package.json
// overrides to an empty local stub (chat runs a separately installed Claude
// Code executable). The override list must track the SDK's
// optionalDependencies: a new platform package in an SDK upgrade fails here
// until it is mapped, instead of silently reinstalling ~58 MB of binaries.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.join(import.meta.dir, '../../..')
const NO_CLI_OVERRIDE = 'file:./packages/claude-agent-sdk-no-cli'

describe('SDK platform CLI overrides', () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  )
  const sdkPackage = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
      'utf8'
    )
  )
  const overrides: Record<string, string> = rootPackage.overrides ?? {}

  test('every SDK platform optional dependency maps to the no-cli stub', () => {
    const names = Object.keys(sdkPackage.optionalDependencies ?? {})
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(overrides[name]).toBe(NO_CLI_OVERRIDE)
    }
  })

  test('the no-cli stub package exists at the override target', () => {
    const stub = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/claude-agent-sdk-no-cli/package.json'), 'utf8')
    )
    expect(stub.name).toBe('@motuslabs/claude-agent-sdk-no-cli')
  })
})

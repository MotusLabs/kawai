// installRoot.test.ts - install-root discovery for the update installer:
// the documented flat layout is accepted, partial or renamed layouts are
// refused with the named error, and source runs target ~/.agentboard/app
// without touching the checkout.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverInstallRoot, platformSlug } from '../updates/installRoot'

let tempRoot = ''

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-install-root-'))
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function makeCompiledLayout(root: string, { withClient = true, binaryName = 'agentboard', binDirName = 'bin' } = {}): string {
  const binDir = path.join(root, binDirName)
  fs.mkdirSync(binDir, { recursive: true })
  const execPath = path.join(binDir, binaryName)
  fs.writeFileSync(execPath, '#!/bin/sh\n')
  if (withClient) {
    fs.mkdirSync(path.join(root, 'dist', 'client'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dist', 'client', 'index.html'), '<html></html>')
  }
  return execPath
}

describe('discoverInstallRoot (compiled)', () => {
  test('accepts the documented bin/agentboard + dist/client layout', () => {
    const execPath = makeCompiledLayout(tempRoot)
    const found = discoverInstallRoot({ execPath, isCompiled: true })
    expect(found.compiled).toBe(true)
    expect(found.root).toBe(tempRoot)
    expect(found.binPath).toBe(execPath)
    expect(found.clientDir).toBe(path.join(tempRoot, 'dist', 'client'))
  })

  test('refuses a partial layout (missing dist/client) with the named error', () => {
    const execPath = makeCompiledLayout(tempRoot, { withClient: false })
    expect(() => discoverInstallRoot({ execPath, isCompiled: true })).toThrow(
      /ERR_UPDATE_UNEXPECTED_LAYOUT[\s\S]*client bundle not found/,
    )
  })

  test('refuses a binary outside a bin directory', () => {
    const execPath = makeCompiledLayout(tempRoot, { binDirName: 'libexec' })
    expect(() => discoverInstallRoot({ execPath, isCompiled: true })).toThrow(
      /not a "bin" directory/,
    )
  })

  test('refuses a renamed binary', () => {
    const execPath = makeCompiledLayout(tempRoot, { binaryName: 'agentboard2' })
    expect(() => discoverInstallRoot({ execPath, isCompiled: true })).toThrow(
      /not "agentboard"/,
    )
  })
})

describe('discoverInstallRoot (source run)', () => {
  test('targets ~/.agentboard/app without layout requirements', () => {
    const home = path.join(tempRoot, 'home')
    const found = discoverInstallRoot({ isCompiled: false, homeDir: home, execPath: '/ignored/bun' })
    expect(found.compiled).toBe(false)
    expect(found.root).toBe(path.join(home, '.agentboard', 'app'))
    expect(found.binPath).toBe(path.join(home, '.agentboard', 'app', 'bin', 'agentboard'))
    // The parent of the install root exists after discovery; the install
    // itself is created only by the update action.
    expect(fs.existsSync(path.join(home, '.agentboard'))).toBe(true)
    expect(fs.existsSync(found.root)).toBe(false)
  })
})

describe('platformSlug', () => {
  test('maps supported platforms to release asset slugs', () => {
    expect(platformSlug('darwin' as NodeJS.Platform, 'arm64')).toBe('darwin-arm64')
    expect(platformSlug('darwin' as NodeJS.Platform, 'x64')).toBe('darwin-x64')
    expect(platformSlug('linux' as NodeJS.Platform, 'x64')).toBe('linux-x64')
    expect(platformSlug('linux' as NodeJS.Platform, 'arm64')).toBe('linux-arm64')
    expect(platformSlug('win32' as NodeJS.Platform, 'x64')).toBeNull()
  })
})

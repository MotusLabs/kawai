import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isExistingDirectory, resolveProjectPath } from '../paths'

describe('resolveProjectPath', () => {
  test('returns empty for blank values', () => {
    expect(resolveProjectPath('')).toBe('')
    expect(resolveProjectPath('   ')).toBe('')
  })

  test('expands ~ to home directory', () => {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const expectedHome = homeDir ? path.resolve(homeDir) : path.resolve('~')
    const expectedProject = homeDir
      ? path.resolve(path.join(homeDir, 'project'))
      : path.resolve('~/project')
    expect(resolveProjectPath('~')).toBe(expectedHome)
    expect(resolveProjectPath('~/project')).toBe(expectedProject)
  })

  test('resolves relative paths', () => {
    const resolved = resolveProjectPath('tmp/project')
    expect(resolved.endsWith(path.join('tmp', 'project'))).toBe(true)
  })
})

describe('isExistingDirectory', () => {
  test('accepts only an existing directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'))
    try {
      const file = path.join(dir, 'file.txt')
      fs.writeFileSync(file, '')
      expect(isExistingDirectory(dir)).toBe(true)
      expect(isExistingDirectory(file)).toBe(false)
      expect(isExistingDirectory(path.join(dir, 'missing'))).toBe(false)
      expect(isExistingDirectory(`${dir} (deleted)`)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

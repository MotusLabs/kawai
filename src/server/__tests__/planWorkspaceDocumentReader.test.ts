// plan-workspace 2.3 reader tests: INVARIANT S over the permitted path,
// lexical escapes, symlink and swap-race containment (CP1 B2/B4), the FIFO
// refusal (B1), bounds, and decoding.
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readWorkspaceDocument } from '../plans/workspace/documentReader'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-reader-'))
const root = path.join(base, 'wt')
const outside = path.join(base, 'outside')
fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(root, 'tasks.md'), '# Tasks\n\n- [x] one\n')
fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE\n')
const rootReal = fs.realpathSync(root)

afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe('readWorkspaceDocument', () => {
  test('reads a contained markdown path whose .. stays inside the root', async () => {
    fs.mkdirSync(path.join(rootReal, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(rootReal, 'docs', 'note.md'), '# Note\n')
    const read = await readWorkspaceDocument(root, 'docs/../docs/note.md')
    expect(read).toMatchObject({ ok: true, kind: 'markdown', text: '# Note\n' })
    if (read.ok) {
      expect(read.hash).toBe(createHash('sha256').update('# Note\n').digest('hex'))
      expect(read.size).toBe(7)
    }
  })

  test('reads a permitted image with its allowlist content type', async () => {
    // A minimal PNG: the reader never decodes image bytes, only bounds them.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    fs.writeFileSync(path.join(rootReal, 'mockup.png'), png)
    const read = await readWorkspaceDocument(root, 'mockup.png')
    expect(read).toMatchObject({ ok: true, kind: 'image', contentType: 'image/png', size: 8 })
  })

  test('refuses absolute, drive-letter, backslash, URL-shaped and empty paths', async () => {
    for (const bad of ['', '/etc/passwd', 'C:\\x.md', 'x\\y.md', '//host/share/x.md', 'https://example.internal/x.md', '.']) {
      const read = await readWorkspaceDocument(root, bad)
      expect(read).toMatchObject({ ok: false, reason: 'invalid-path' })
    }
  })

  test('refuses .. that escapes the root as escape', async () => {
    expect(await readWorkspaceDocument(root, '../outside/secret.md')).toMatchObject({ ok: false, reason: 'escape' })
    expect(await readWorkspaceDocument(root, 'docs/../../outside/secret.md')).toMatchObject({ ok: false, reason: 'escape' })
    expect(await readWorkspaceDocument(root, 'a//..//../x.md')).toMatchObject({ ok: false, reason: 'escape' })
  })

  test('refuses a symlink resolving outside the root', async () => {
    fs.symlinkSync(outside, path.join(rootReal, 'leak'))
    try {
      expect(await readWorkspaceDocument(root, 'leak/secret.md')).toMatchObject({ ok: false, reason: 'containment-failed' })
    } finally {
      fs.unlinkSync(path.join(rootReal, 'leak'))
    }
  })

  test('a fifo is refused as not-regular without hanging the open', async () => {
    const fifo = path.join(rootReal, 'pipe.md')
    execFileSync('mkfifo', [fifo])
    const read = await Promise.race([
      readWorkspaceDocument(root, 'pipe.md'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fifo open hung')), 2_000)),
    ])
    expect(read).toMatchObject({ ok: false, reason: 'not-regular' })
  }, 10_000)

  test('a three-phase directory swap after the open is refused, never served', async () => {
    // The advisor's deterministic attack (logs/pw-b-probes/swapRace.ts),
    // driven through the two stated seams: phase A opens `sub/secret`
    // through sub→outside (the fd reads OUTSIDE bytes); seam 1 replaces sub
    // with a real dir holding a decoy, so the path now resolves inside;
    // seam 2 restores sub→outside before the final check. A path-based
    // check re-follows into the outside inode and serves; the kernel's fd
    // link names outside throughout, so the reader refuses.
    fs.symlinkSync(outside, path.join(rootReal, 'sub'))
    const swapPath = path.join(rootReal, 'sub')
    try {
      const read = await readWorkspaceDocument(root, 'sub/secret.md', {
        onOpened: () => {
          fs.unlinkSync(swapPath)
          fs.mkdirSync(swapPath)
          fs.writeFileSync(path.join(swapPath, 'secret.md'), 'DECOY\n')
        },
        readProcLink: async fd => {
          fs.rmSync(swapPath, { recursive: true, force: true })
          fs.symlinkSync(outside, swapPath)
          return fsp.readlink(`/proc/self/fd/${fd}`)
        },
      })
      expect(read).toMatchObject({ ok: false, reason: 'containment-failed' })
    } finally {
      fs.rmSync(swapPath, { recursive: true, force: true })
    }
  })

  test('a target deleted after the open refuses through the deleted suffix', async () => {
    fs.writeFileSync(path.join(rootReal, 'gone.md'), 'temporary\n')
    const read = await readWorkspaceDocument(root, 'gone.md', {
      onOpened: () => fs.unlinkSync(path.join(rootReal, 'gone.md')),
    })
    expect(read).toMatchObject({ ok: false, reason: 'containment-failed' })
  })

  test('an unavailable containment read refuses without any fallback', async () => {
    // The non-Linux seam (B4): no /proc/self/fd means no race-safe
    // containment answer, so the read fails closed.
    const read = await readWorkspaceDocument(root, 'tasks.md', {
      readProcLink: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(read).toMatchObject({ ok: false, reason: 'containment-unavailable' })
  })

  test('a containment link naming the deleted root also refuses', async () => {
    const read = await readWorkspaceDocument(root, 'tasks.md', {
      readProcLink: async () => `${rootReal} (deleted)`,
    })
    expect(read).toMatchObject({ ok: false, reason: 'containment-failed' })
  })

  test('content beyond the type bound is refused before any full read', async () => {
    // A 2 GiB sparse markdown file: a whole-file read would allocate it and
    // fail the test; the stat bound refuses it immediately.
    const huge = path.join(rootReal, 'huge.md')
    fs.writeFileSync(huge, '')
    fs.truncateSync(huge, 2 * 1024 * 1024 * 1024)
    try {
      expect(await readWorkspaceDocument(root, 'huge.md')).toMatchObject({ ok: false, reason: 'oversized' })
    } finally {
      fs.unlinkSync(huge)
    }
    const bigPng = path.join(rootReal, 'big.png')
    fs.writeFileSync(bigPng, '')
    fs.truncateSync(bigPng, 10 * 1024 * 1024 + 1)
    try {
      expect(await readWorkspaceDocument(root, 'big.png')).toMatchObject({ ok: false, reason: 'oversized' })
    } finally {
      fs.unlinkSync(bigPng)
    }
  })

  test('a file grown past the bound between the stat and the read still refuses', async () => {
    // Small at open and stat; the growth lands inside the containment seam,
    // after the stat guard, so the bounded read itself must catch it.
    const grown = path.join(rootReal, 'grown.md')
    fs.writeFileSync(grown, 'x')
    const read = await readWorkspaceDocument(root, 'grown.md', {
      readProcLink: async fd => {
        fs.appendFileSync(grown, 'y'.repeat(1024 * 1024 + 8))
        return fsp.readlink(`/proc/self/fd/${fd}`)
      },
    })
    expect(read).toMatchObject({ ok: false, reason: 'oversized' })
  })

  test('invalid UTF-8 markdown is refused, never lossily decoded', async () => {
    fs.writeFileSync(path.join(rootReal, 'bad.md'), Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe]))
    expect(await readWorkspaceDocument(root, 'bad.md')).toMatchObject({ ok: false, reason: 'invalid-utf8' })
  })

  test('unsupported extensions are refused by name, html and svg included', async () => {
    for (const name of ['page.html', 'vector.svg', 'script.js', 'archive.tar.gz', 'noext', '.hidden']) {
      fs.writeFileSync(path.join(rootReal, name), 'data')
      const read = await readWorkspaceDocument(root, name)
      expect(read).toMatchObject({ ok: false, reason: 'unsupported-type' })
      fs.unlinkSync(path.join(rootReal, name))
    }
  })

  test('a missing file refuses as missing without naming the target', async () => {
    expect(await readWorkspaceDocument(root, 'no/such/file.md')).toMatchObject({ ok: false, reason: 'missing' })
    expect(await readWorkspaceDocument(path.join(base, 'absent-root'), 'tasks.md')).toMatchObject({ ok: false, reason: 'missing' })
  })
})

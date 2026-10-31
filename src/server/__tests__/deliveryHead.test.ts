// @reads: openspec/changes/archive/**
// Process-free P witnesses for metadata resolution and supplied-text history.
// All filesystem inputs are owned temporary metadata, not repository file reads.
import { afterEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DeliverySourceResolver, normalizeFetchEvidence } from '../metrics/delivery/sourceResolver'
import { PackedRefIndex, parsePackedRefs, validRefName } from '../metrics/delivery/packedRefs'
import { MetadataError, MetadataRoot, reliableMetadataToken } from '../metrics/delivery/metadataFiles'
import { parseRepositoryConfig } from '../metrics/delivery/repositoryConfig'
import { parseCompleteGraph, validateArchiveHistory } from '../metrics/delivery/history'
import { DeliveryHistoryError } from '../metrics/delivery/types'
import { DELIVERY_METADATA_BOUND, FETCH_PROVENANCE } from '../metrics/delivery/readerTypes'
import type { SourceReason } from '../metrics/delivery/readerTypes'
import { DeliveryReaderRepo, SOURCE_NOW, literal, descriptorTarget, patchStat, ownedDescriptors, withOwnedFdEvidence, withCleanup } from './fixtures/deliveryReaderRepo'

const owned: DeliveryReaderRepo[] = []
function fixture(format: 'sha1' | 'sha256' = 'sha1'): DeliveryReaderRepo {
  const repo = new DeliveryReaderRepo(format)
  owned.push(repo)
  return repo
}
afterEach(() => { for (const repo of owned.splice(0)) repo.dispose() })

test('P public resolver composes physical source, head and independent fetch evidence', () => {
  const repo = fixture()
  repo.stamp(SOURCE_NOW - 1000)
  const state = new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW)
  expect(state.reason).toBeNull()
  expect(state.target?.H).toBe(literal('a'))
  expect(state.target?.repository).toBe(fs.realpathSync(repo.common))
  expect(state.target?.main).toBe(fs.realpathSync(repo.main))
  expect(state.target?.rootIdentity.ino).toBe(String(fs.statSync(repo.common, { bigint: true }).ino))
  expect(state.fetchAt).toBe(SOURCE_NOW - 1000)
  expect(state.fetchProvenance).toBe(FETCH_PROVENANCE)
})

test('H1-H6 missing, symbolic, packed peel, loose preference and direct literal', () => {
  for (const row of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']) {
    const repo = fixture()
    if (row === 'H1') repo.location.commonDir = path.join(repo.root, 'missing')
    if (row === 'H2') repo.remove('refs/remotes/origin/HEAD')
    if (row === 'H4') repo.packed(literal('b'))
    if (row === 'H5') repo.write('packed-refs', `${literal('b')} refs/remotes/origin/main\n`)
    if (row === 'H6') repo.write('refs/remotes/origin/HEAD', literal('c') + '\n')
    const state = new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW)
    if (row === 'H1' || row === 'H2') {
      expect(state.reason).toBe('no-default-branch')
      expect(state.detail).toContain('git remote set-head origin --auto')
      expect(state.target).toBeNull()
    } else expect(state.target?.H).toBe(literal(row === 'H4' ? 'b' : row === 'H6' ? 'c' : 'a'))
  }
})

test('H7 five edges succeed, sixth edge and loops refuse', () => {
  const repo = fixture(), resolver = new DeliverySourceResolver()
  repo.write('refs/remotes/origin/HEAD', 'ref: refs/test/0\n')
  for (let i = 0; i < 4; i++) repo.write(`refs/test/${i}`, `ref: refs/test/${i + 1}\n`)
  repo.write('refs/test/4', literal('a') + '\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
  repo.write('refs/test/4', 'ref: refs/test/5\n')
  repo.write('refs/test/5', literal('a') + '\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  repo.write('refs/test/0', 'ref: refs/test/1\n'); repo.write('refs/test/1', 'ref: refs/test/0\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
})

test('H7 whole-literal, ref-name, metadata-kind and byte limits fail closed', () => {
  for (const text of [literal('a').toUpperCase(), literal('a').slice(1), literal('a') + ' ',
    'ref: refs/../outside', 'ref: refs/a.lock', 'ref: refs/a@{b', 'ref: refs//a', 'x'.repeat(4097)]) {
    const repo = fixture()
    repo.write('refs/remotes/origin/HEAD', text + '\n')
    expect(new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  }
  const repo = fixture()
  repo.remove('refs/remotes/origin/main')
  fs.mkdirSync(repo.file('refs/remotes/origin/main'))
  expect(new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  fs.truncateSync(repo.file('config'), DELIVERY_METADATA_BOUND + 1)
  expect(new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
})

test('H8 source refuses shallow history', () => {
  const repo = fixture(); repo.write('shallow', literal('a') + '\n')
  expect(new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW).reason).toBe('history-incomplete:shallow')
})

// @covers: delivery-outcomes › Delivery source resolution is process-free and fail-closed › Partial metadata refuses source resolution
test('H9 each local partial marker refuses the exported resolver', () => {
  for (const marker of ['partialclone', 'promisor', 'filter', 'pack']) {
    const repo = fixture()
    if (marker === 'partialclone') repo.write('config', '[extensions]\npartialclone=origin\n')
    if (marker === 'promisor') repo.write('config', '[remote "origin"]\npromisor\n')
    if (marker === 'filter') repo.write('config', '[remote.origin]\npartialclonefilter=\n')
    if (marker === 'pack') repo.write('objects/pack/example.promisor', '')
    const state = new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW)
    expect(state.reason).toBe('history-incomplete:partial')
    expect(state.target).toBeNull()
  }
})

// @covers: delivery-outcomes › Delivery source resolution is process-free and fail-closed › Graft metadata refuses source resolution
test('H10 graft metadata refuses the exported resolver', () => {
  const repo = fixture(); repo.write('info/grafts', literal('a') + '\n')
  const state = new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW)
  expect(state.reason).toBe('history-incomplete:grafts'); expect(state.target).toBeNull()
})

// @covers: delivery-outcomes › Delivery source resolution is process-free and fail-closed › Unsupported ref storage refuses source resolution
test('H11 unsupported ref storage refuses the exported resolver', () => {
  const repo = fixture(); repo.write('config', '[core]\nrepositoryformatversion=1\n[extensions]\nrefstorage=reftable\n')
  const state = new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW)
  expect(state.reason).toBe('default-branch-unreadable'); expect(state.target).toBeNull()
})

// @covers: delivery-outcomes › Delivery source resolution is process-free and fail-closed › Internal metadata symlink refuses source resolution
test('R7 inner metadata symlinks refuse while host ancestor symlinks work', () => {
  const repo = fixture(), resolver = new DeliverySourceResolver()
  const alias = path.join(repo.root, 'alias')
  fs.symlinkSync(repo.main, alias, 'dir')
  expect(resolver.resolveHead({ commonDir: path.join(alias, '.git'), mainCheckout: alias }, SOURCE_NOW).target?.H).toBe(literal('a'))
  const destination = path.join(repo.root, 'owned-ref')
  fs.writeFileSync(destination, literal('b') + '\n')
  repo.remove('refs/remotes/origin/main')
  fs.symlinkSync(destination, repo.file('refs/remotes/origin/main'))
  const state = resolver.resolveHead(repo.location, SOURCE_NOW)
  expect(state.reason).toBe('default-branch-unreadable'); expect(state.target).toBeNull()
  repo.remove('config'); fs.symlinkSync(destination, repo.file('config'))
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  for (const component of ['refs', 'refs/remotes', 'refs/remotes/origin', 'objects/pack', 'info', 'info/grafts', 'shallow', 'packed-refs']) {
    const other = fixture(), outside = path.join(other.root, 'owned-directory')
    fs.mkdirSync(outside)
    if (component === 'packed-refs') other.remove('refs/remotes/origin/main')
    fs.mkdirSync(path.dirname(other.file(component)), { recursive: true })
    other.remove(component); fs.symlinkSync(outside, other.file(component), 'dir')
    expect(resolver.resolveHead(other.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  }
})

test('strict repository config handles quotes comments continuations booleans and versions', () => {
  expect(parseRepositoryConfig('[core]\nrepositoryformatversion=1\n[extensions]\nobjectformat="sha\\\n256" # folded\n'))
    .toEqual({ ok: true, objectFormat: 'sha256', version: 1 })
  for (const value of ['false', 'no', 'off', '0', '""']) {
    expect(parseRepositoryConfig(`[remote "origin"]\npromisor=${value}\n`).ok).toBe(true)
  }
  for (const value of ['true', 'yes', 'on', '1']) {
    expect(parseRepositoryConfig(`[remote "a#b"]\npromisor="${value}" ; comment\n`))
      .toEqual({ ok: false, reason: 'history-incomplete:partial' })
  }
  for (const config of ['[core]\nrepositoryformatversion=2', '[core]\nrepositoryformatversion=-1',
    '[extensions]\nobjectformat=sha256', '[extensions]\nrefstorage=files',
    '[include]\npath=other', '[includeIf "gitdir:x"]\npath=other', '[extensions]\nworktreeconfig=true',
    '[remote "x"]\npromisor=maybe', '[core]\nrepositoryformatversion=0\nrepositoryformatversion=1',
    '[broken', '[core] repositoryformatversion=0', '[core]\nx="unterminated', '[core]\nx=bare\r']) {
    expect(parseRepositoryConfig(config)).toEqual({ ok: false, reason: 'default-branch-unreadable' })
  }
  const repo = fixture('sha256'), resolver = new DeliverySourceResolver()
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a', 'sha256'))
  repo.write('refs/remotes/origin/main', literal('a'))
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
})

test('R1 reliable unchanged packed data parses once but is opened each lookup', () => {
  const repo = fixture(); repo.packed(literal('a'))
  const index = new PackedRefIndex(), resolver = new DeliverySourceResolver(index)
  const opens = spyOn(fs, 'openSync')
  try {
    expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
    expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
    expect(index.parseCount).toBe(1)
    expect(opens.mock.calls.filter(call => String(call[0]).endsWith('/packed-refs')).length).toBe(2)
  } finally { opens.mockRestore() }
})

test('R2-R5 atomic and in-place packed replacement, loose override and invalidation', () => {
  const repo = fixture(); repo.packed(literal('a'))
  const resolver = new DeliverySourceResolver()
  const packed = repo.file('packed-refs')
  fs.utimesSync(packed, 1700000000, 1700000000)
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
  const original = fs.statSync(packed, { bigint: true })
  const header = '# pack-refs with: peeled fully-peeled\n'
  repo.write('replacement', `${header}${literal('b')} refs/remotes/origin/main\n^${literal('c')}\n`)
  fs.utimesSync(repo.file('replacement'), 1700000000, 1700000000)
  fs.renameSync(repo.file('replacement'), packed)
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('b'))
  const replaced = fs.statSync(packed, { bigint: true })
  expect(replaced.ino).not.toBe(original.ino)
  expect(replaced.size).toBe(original.size); expect(replaced.mtimeNs).toBe(original.mtimeNs)
  const before = fs.statSync(packed, { bigint: true })
  repo.write('packed-refs', `${header}${literal('d')} refs/remotes/origin/main\n^${literal('c')}\n`)
  fs.utimesSync(packed, 1700000000, 1700000000)
  const after = fs.statSync(packed, { bigint: true })
  expect(after.ino).toBe(before.ino); expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(after.size).toBe(before.size)
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('d'))
  repo.write('refs/remotes/origin/main', literal('e') + '\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('e'))
  repo.remove('refs/remotes/origin/main'); repo.remove('packed-refs')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  repo.write('packed-refs', 'malformed\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  repo.packed(literal('f'))
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('f'))
})

test('R6 absent native token fields and malformed packed records cannot reuse', () => {
  expect(reliableMetadataToken({ dev: 1n, ino: 2n, size: 0n, mtimeNs: 0n })).toBeNull()
  for (const name of ['main', 'refs/a..b', 'refs/a.lock', 'refs/a\\b', 'refs/a\n', '/refs/a']) expect(validRefName(name)).toBe(false)
  for (const text of [`^${literal('c')}\n`, `${literal('a')} refs/x\n${literal('b')} refs/x\n`,
    `${literal('a')} refs/x\n^short\n`, `${literal('a').toUpperCase()} refs/x\n`]) {
    expect(() => parsePackedRefs(text, 'sha1')).toThrow()
  }
})

// @covers: delivery-outcomes › Delivery source timestamp provenance › Unsafe FETCH_HEAD keeps the head
test('S1-S4 common-only provenance, missing metadata and same-target timestamps', () => {
  const repo = fixture(), resolver = new DeliverySourceResolver()
  repo.write('worktrees/link/FETCH_HEAD', 'linked only\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).fetchReason).toBe('missing')
  repo.stamp(SOURCE_NOW - 10000)
  const old = resolver.resolveHead(repo.location, SOURCE_NOW)
  repo.stamp(SOURCE_NOW - 1000)
  const next = resolver.resolveHead(repo.location, SOURCE_NOW)
  expect(next.fetchAt).toBe(SOURCE_NOW - 1000); expect(next.target).toEqual(old.target)
  repo.write('refs/remotes/origin/main', literal('b') + '\n')
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).fetchAt).toBe(next.fetchAt)
  repo.remove('FETCH_HEAD'); fs.mkdirSync(repo.file('FETCH_HEAD'))
  const unknown = resolver.resolveHead(repo.location, SOURCE_NOW)
  expect(unknown.fetchAt).toBeNull(); expect(unknown.fetchReason).toBe('unsafe')
  expect(unknown.target?.H).toBe(literal('b'))
  repo.remove('FETCH_HEAD')
  const outside = path.join(repo.root, 'timestamp')
  fs.writeFileSync(outside, 'owned')
  fs.symlinkSync(outside, repo.file('FETCH_HEAD'))
  const unsafe = resolver.resolveHead(repo.location, SOURCE_NOW)
  expect(unsafe.fetchReason).toBe('unsafe'); expect(unsafe.fetchAt).toBeNull()
  expect(unsafe.target?.H).toBe(literal('b'))
})

test('S5-S6 finite nonnegative epoch/floor/future/invalid-now boundaries', () => {
  expect(normalizeFetchEvidence(0, 0)).toEqual({ fetchAt: 0, fetchReason: null })
  expect(normalizeFetchEvidence(1000.9, 1000.1)).toEqual({ fetchAt: 1000, fetchReason: null })
  expect(normalizeFetchEvidence(1001, 1000.9)).toEqual({ fetchAt: null, fetchReason: 'future-time' })
  for (const value of [-1, NaN, Infinity]) expect(normalizeFetchEvidence(value, SOURCE_NOW).fetchReason).toBe('invalid-time')
  for (const value of [-1, NaN, Infinity]) expect(normalizeFetchEvidence(0, value).fetchReason).toBe('invalid-now')
  const repo = fixture(); repo.stamp(SOURCE_NOW + 1000)
  const suppliedNow = Math.floor(fs.statSync(repo.file('FETCH_HEAD')).mtimeMs) - 1
  const state = new DeliverySourceResolver().resolveHead(repo.location, suppliedNow)
  expect(state.fetchReason).toBe('future-time'); expect(state.target?.H).toBe(literal('a'))
})

const H = literal('d'), merge = literal('c'), side = literal('b'), root = literal('a')
const graphText = `${H} 200 ${merge}\n${merge} 50 ${root} ${side}\n${side} 70 ${root}\n${root} 100 \n`
test('pure supplied history preserves integration count and composes accepted archive arrivals', () => {
  const history = parseCompleteGraph(graphText, H, 'sha1')
  expect(history.integrationCount).toBe(3)
  expect(history.positions.commits.get(side)).toEqual({ position: 2, at: 50000, bound: 100000 })
  const archive = 'openspec/changes/archive/2026-10-01-example/proposal.md'
  const arrivals = validateArchiveHistory(`@${merge}\n${archive}\n@${root}\n${archive}\n`, history, 'sha1')
  expect(arrivals.ok && arrivals.changes.get('example')?.position).toBe(1)
  expect(validateArchiveHistory('', history, 'sha1').ok).toBe(true)
  expect(validateArchiveHistory(`@${side}\n${archive}\n`, history, 'sha1')).toEqual({ ok: false, reason: 'archive-malformed' })
  expect(validateArchiveHistory(`@${H}\n${archive}/nested\n`, history, 'sha1')).toEqual({ ok: false, reason: 'archive-malformed' })
})

test('F6-F8 pure supplied graph rejects malformed, cyclic, extraneous and incomplete rows', () => {
  const rows: [string, string][] = [
    ['', 'history-malformed'], [`${H} 1 ${root}\n`, 'history-incomplete'],
    [`${root} 1\n`, 'history-malformed'], [`${H} 1 ${H}\n`, 'history-malformed'],
    [`${H} 1\n${root} 1\n`, 'history-malformed'], [`${H} 1\n${H} 2\n`, 'history-malformed'],
    [`${H} 1 ${root} ${root}\n${root} 0 \n`, 'history-malformed'],
    [`${H} 1e3\n`, 'history-malformed'], [`${H} 9007199254740991\n`, 'history-malformed'],
  ]
  for (const [text, reason] of rows) {
    let observed: string | null = null
    try { parseCompleteGraph(text, H, 'sha1') }
    catch (error) { if (!(error instanceof DeliveryHistoryError)) throw error; observed = error.reason }
    expect(observed).toBe(reason)
  }
})

test('SC1 missing bigint snapshot fields refuse before consumption and after reading', () => {
  const repo = fixture(); repo.packed(literal('a'))
  for (const bad of [undefined, 1]) for (const phase of [1, 2]) for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    const root = new MetadataRoot(repo.common), native = fs.fstatSync
    let calls = 0, consumed = false
    withCleanup(enroll => {
      enroll(() => root.close())
      const stat = spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
        const value = native(...args)
        return descriptorTarget(args[0])?.endsWith('/packed-refs') && ++calls === phase
          ? patchStat(value, { [field]: bad }) : value
      }) as typeof fs.fstatSync)
      enroll(() => stat.mockRestore())
      let observed: unknown
      try { root.withFile('packed-refs', DELIVERY_METADATA_BOUND, file => { consumed = true; return file.readText() }) }
      catch (error) { observed = error }
      expect(observed instanceof MetadataError && observed.kind).toBe('unsupported-platform')
      expect(consumed).toBe(phase === 2)
    })
  }
})

test('SC2 captured nanoseconds floor before Number without a second double stat', () => {
  for (const ns of [1800000000000999999n, -1n, undefined, 1]) {
    const repo = fixture(); repo.stamp(SOURCE_NOW)
    const native = fs.fstatSync
    let numericReads = 0
    const stat = spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const value = native(...args)
      if (!descriptorTarget(args[0])?.endsWith('/FETCH_HEAD')) return value
      if (!args[1]?.bigint) { numericReads++; return patchStat(value, { mtimeMs: 1800000000001 }) }
      return patchStat(value, { mtimeNs: ns, mtimeMs: ns === -1n ? -1n : 1800000000000n })
    }) as typeof fs.fstatSync)
    try {
      const state = new DeliverySourceResolver().resolveHead(repo.location, 1800000000000)
      expect(state.target?.H).toBe(literal('a'))
      expect(state.fetchAt).toBe(ns === 1800000000000999999n ? 1800000000000 : null)
      expect(state.fetchReason).toBe(ns === 1800000000000999999n ? null : ns === -1n ? 'invalid-time' : 'unreadable')
      expect(numericReads).toBe(0)
    } finally { stat.mockRestore() }
  }
})

test('T1 null cache token reparses actual unchanged lookups and observes rewrite', () => {
  const repo = fixture(); repo.packed(literal('a'))
  const index = new PackedRefIndex(() => null), resolver = new DeliverySourceResolver(index)
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
  expect(index.parseCount).toBe(2)
  repo.packed(literal('b'))
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('b'))
  expect(index.parseCount).toBe(3)
})

test('T2a actual lookup error invalidates cache with an unchanged file token', () => {
  const repo = fixture(); repo.packed(literal('a'))
  const root = new MetadataRoot(repo.common), index = new PackedRefIndex(), name = 'refs/remotes/origin/main'
  try {
    expect(index.lookup(root, name, 'sha1')).toBe(literal('a')); expect(index.parseCount).toBe(1)
    const before = fs.statSync(repo.file('packed-refs'), { bigint: true }), native = fs.fstatSync
    let errors = 0
    const stat = spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      if (!errors && descriptorTarget(args[0])?.endsWith('/packed-refs')) { errors++; throw Object.assign(new Error('owned stat fault'), { code: 'EIO' }) }
      return native(...args)
    }) as typeof fs.fstatSync)
    try { expect(() => index.lookup(root, name, 'sha1')).toThrow(MetadataError) }
    finally { stat.mockRestore() }
    expect(errors).toBe(1)
    const after = fs.statSync(repo.file('packed-refs'), { bigint: true })
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs])
      .toEqual([before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs])
    expect(index.lookup(root, name, 'sha1')).toBe(literal('a')); expect(index.parseCount).toBe(2)
  } finally { root.close() }
})

test('T2b valid data changed through readSync refuses the public source path', () => {
  const repo = fixture(); repo.packed(literal('a'))
  const index = new PackedRefIndex(), resolver = new DeliverySourceResolver(index), native = fs.readSync
  let mutations = 0
  const read = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = native(...args)
    if (count > 0 && !mutations && descriptorTarget(args[0])?.endsWith('/packed-refs')) {
      mutations++; fs.appendFileSync(repo.file('packed-refs'), '# valid mid-read comment\n')
    }
    return count
  }) as typeof fs.readSync)
  try {
    const state = resolver.resolveHead(repo.location, SOURCE_NOW)
    expect(mutations).toBe(1); expect(state.reason).toBe('default-branch-unreadable'); expect(state.target).toBeNull()
  } finally { read.mockRestore() }
  expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a'))
  expect(index.parseCount).toBe(2)
})

test('T3 public resolution closes owned kernel descriptors on success refusal and data error', () => {
  const reasons: Record<string, SourceReason | null> = { success: null, shallow: 'history-incomplete:shallow',
    grafts: 'history-incomplete:grafts', partial: 'history-incomplete:partial', 'bad-config': 'default-branch-unreadable',
    'missing-head': 'no-default-branch', 'bad-ref': 'default-branch-unreadable', 'data-error': 'default-branch-unreadable' }
  for (const kind of Object.keys(reasons)) {
    const repo = fixture()
    if (kind === 'shallow') repo.write('shallow', '')
    if (kind === 'grafts') repo.write('info/grafts', '')
    if (kind === 'partial') repo.write('objects/pack/example.promisor', '')
    if (kind === 'bad-config') repo.write('config', '[malformed')
    if (kind === 'missing-head') repo.remove('refs/remotes/origin/HEAD')
    if (kind === 'bad-ref') repo.write('refs/remotes/origin/HEAD', 'not-a-literal\n')
    withOwnedFdEvidence(repo.root, before => withCleanup(enroll => {
      const nativeOpen = fs.openSync, nativeRead = fs.readSync, kinds = new Set<string>()
      const physical = fs.realpathSync(repo.root)
      let errors = 0
      const opens = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        const fd = nativeOpen(...args)
        if (descriptorTarget(fd)?.startsWith(physical + '/')) kinds.add(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file')
        return fd
      })
      enroll(() => opens.mockRestore())
      const dirs = spyOn(fs, 'opendirSync')
      enroll(() => dirs.mockRestore())
      const reads = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (kind === 'data-error' && !errors && descriptorTarget(args[0])?.endsWith('/refs/remotes/origin/HEAD')) { errors++; throw new Error('owned data fault') }
        return nativeRead(...args)
      }) as typeof fs.readSync)
      enroll(() => reads.mockRestore())
      const state = new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW)
      expect(state.reason).toBe(reasons[kind])
      expect(kinds.has('dir') && kinds.has('file')).toBe(true)
      if (kind === 'success' || kind === 'partial') expect(dirs.mock.calls.length).toBeGreaterThan(0)
      if (kind === 'data-error') expect(errors).toBe(1)
      expect(ownedDescriptors(repo.root)).toEqual(before)
    }))
  }
})

test('T4 pinned common and main path replacement refuses then fresh resolution sees replacement', () => {
  for (const which of ['common', 'main'] as const) {
    const repo = fixture(), resolver = new DeliverySourceResolver(), native = fs.openSync
    let replacements = 0
    const open = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!replacements && String(args[0]).endsWith('/config')) { replacements++; repo.replacePinnedRoot(which, literal('b')) }
      return native(...args)
    })
    try {
      const state = resolver.resolveHead(repo.location, SOURCE_NOW)
      expect(replacements).toBe(1); expect(state.reason).toBe('default-branch-unreadable'); expect(state.target).toBeNull()
    } finally { open.mockRestore() }
    expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('b'))
  }
})

test('packed oversized sparse metadata and invalid UTF8 refuse source resolution', () => {
  const repo = fixture(); repo.packed(literal('a'))
  fs.truncateSync(repo.file('packed-refs'), DELIVERY_METADATA_BOUND + 1)
  expect(new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
  fs.writeFileSync(repo.file('packed-refs'), Buffer.from([0xff]))
  expect(new DeliverySourceResolver().resolveHead(repo.location, SOURCE_NOW).reason).toBe('default-branch-unreadable')
})

// @covers: delivery-outcomes › Delivery source resolution is process-free and fail-closed › Packed metadata collision still returns changed content
test('G5 equal metadata tokens cannot hide changed bytes and cache hits still read', () => {
  const repo = fixture(); repo.packed(literal('a'))
  const initial = fs.statSync(repo.file('packed-refs'), { bigint: true })
  const fields = { dev: initial.dev, ino: initial.ino, size: initial.size, mtimeNs: initial.mtimeNs, ctimeNs: initial.ctimeNs }
  const snapshots: bigint[][] = [], index = new PackedRefIndex(), resolver = new DeliverySourceResolver(index)
  const nativeStat = fs.fstatSync, nativeRead = fs.readSync
  let bytesRead = 0
  withCleanup(enroll => {
    const stat = spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const value = nativeStat(...args)
      if (!descriptorTarget(args[0])?.endsWith('/packed-refs') || !args[1]?.bigint) return value
      const collision = patchStat(value, fields) as fs.BigIntStats
      snapshots.push([collision.dev, collision.ino, collision.size, collision.mtimeNs, collision.ctimeNs])
      return collision
    }) as typeof fs.fstatSync)
    enroll(() => stat.mockRestore())
    const read = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = nativeRead(...args)
      if (descriptorTarget(args[0])?.endsWith('/packed-refs')) bytesRead += count
      return count
    }) as typeof fs.readSync)
    enroll(() => read.mockRestore())
    expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('a')); expect(index.parseCount).toBe(1)
    repo.packed(literal('b'))
    const actual = fs.statSync(repo.file('packed-refs'), { bigint: true })
    expect(actual.ino).toBe(initial.ino); expect(actual.size).toBe(initial.size)
    const changed = resolver.resolveHead(repo.location, SOURCE_NOW)
    expect(snapshots.length).toBe(4)
    for (const values of snapshots) expect(values).toEqual([initial.dev, initial.ino, initial.size, initial.mtimeNs, initial.ctimeNs])
    expect(changed.target?.H).toBe(literal('b')); expect(index.parseCount).toBe(2)
    const beforeUnchanged = bytesRead
    expect(resolver.resolveHead(repo.location, SOURCE_NOW).target?.H).toBe(literal('b')); expect(index.parseCount).toBe(2)
    expect(bytesRead).toBeGreaterThan(beforeUnchanged)
  })
})

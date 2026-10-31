// Owned source-resolution fixture. Construction occurs inside test bodies;
// imports allocate no metadata and this fixture invokes no Git process.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ObjectFormat } from '../../metrics/delivery/types'

export const SOURCE_NOW = Date.parse('2026-10-01T00:00:00Z')
export function literal(digit: string, format: ObjectFormat = 'sha1'): string {
  return digit.repeat(format === 'sha256' ? 64 : 40)
}

export class DeliveryReaderRepo {
  readonly root: string
  readonly main: string
  readonly common: string
  readonly location: { commonDir: string; mainCheckout: string }

  constructor(format: ObjectFormat = 'sha1') {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-source-'))
    fs.chmodSync(this.root, 0o700)
    this.main = path.join(this.root, 'main')
    this.common = path.join(this.main, '.git')
    this.location = { commonDir: this.common, mainCheckout: this.main }
    for (const name of ['objects/pack', 'refs/remotes/origin']) {
      fs.mkdirSync(this.file(name), { recursive: true, mode: 0o700 })
    }
    this.write('config', format === 'sha256'
      ? '[core]\nrepositoryformatversion=1\n[extensions]\nobjectformat=sha256\n'
      : '[core]\nrepositoryformatversion=0\n')
    this.write('refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/main\n')
    this.write('refs/remotes/origin/main', literal('a', format) + '\n')
  }

  file(relative: string): string { return path.join(this.common, relative) }
  write(relative: string, text: string): void {
    fs.mkdirSync(path.dirname(this.file(relative)), { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.file(relative), text, { mode: 0o600 })
  }
  remove(relative: string): void { fs.rmSync(this.file(relative), { recursive: true, force: true }) }
  packed(sha: string): void {
    this.remove('refs/remotes/origin/main')
    this.write('packed-refs', `# pack-refs with: peeled fully-peeled\n${sha} refs/remotes/origin/main\n^${literal('c')}\n`)
  }
  stamp(milliseconds: number): void {
    this.write('FETCH_HEAD', 'Synthetic timestamp evidence only\n')
    fs.utimesSync(this.file('FETCH_HEAD'), milliseconds / 1000, milliseconds / 1000)
  }
  replacePinnedRoot(which: 'common' | 'main', sha: string): void {
    fs.renameSync(which === 'common' ? this.common : this.main, path.join(this.root, `parked-${which}`))
    for (const name of ['objects/pack', 'refs/remotes/origin']) {
      fs.mkdirSync(this.file(name), { recursive: true, mode: 0o700 })
    }
    this.write('config', '[core]\nrepositoryformatversion=0\n')
    this.write('refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/main\n')
    this.write('refs/remotes/origin/main', sha + '\n')
  }
  dispose(): void { fs.rmSync(this.root, { recursive: true, force: true }) }
}

/** Test syscall identification reads THIS process only, never another pid. */
export function descriptorTarget(fd: number): string | null {
  try { return fs.readlinkSync(`/proc/self/fd/${fd}`) }
  catch (error) {
    if (['ENOENT', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

export function patchStat<T extends fs.Stats | fs.BigIntStats>(stat: T, changes: Record<string, unknown>): T {
  return new Proxy(Object.create(Object.getPrototypeOf(stat)) as T, {
    get(_target, key) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) return Reflect.get(changes, key)
      const value = Reflect.get(stat, key, stat)
      return typeof value === 'function' ? value.bind(stat) : value
    },
  })
}

/** Restore every enrolled resource even if a later spy setup/assertion fails. */
export function withCleanup(use: (enroll: (cleanup: () => void) => void) => void): void {
  const cleanups: (() => void)[] = [], errors: unknown[] = []
  try { use(cleanup => cleanups.push(cleanup)) } catch (error) { errors.push(error) }
  finally { for (const cleanup of cleanups.reverse()) { try { cleanup() } catch (error) { errors.push(error) } } }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'owned assertion and restoration failed')
}

function descriptorIdentity(fd: number, root: string): string | null {
  const target = descriptorTarget(fd)
  if (target === null || !(target === root || target.startsWith(root + '/'))) return null
  const stat = fs.fstatSync(fd, { bigint: true })
  return `${target}:${stat.dev}:${stat.ino}`
}

/** Filter unrelated runtime fd noise; observations precede any test cleanup. */
export function ownedDescriptors(root: string): Map<number, string> {
  const physical = fs.realpathSync(root), result = new Map<number, string>()
  for (const name of fs.readdirSync('/proc/self/fd')) {
    if (!/^[0-9]+$/.test(name)) continue
    const fd = Number(name), identity = descriptorIdentity(fd, physical)
    if (identity !== null) result.set(fd, identity)
  }
  return result
}

export function withOwnedFdEvidence(root: string, observe: (before: Map<number, string>) => void): void {
  const before = ownedDescriptors(root)
  let failed = false, original: unknown
  try { observe(before) } catch (error) { failed = true; original = error }
  try {
    // Teardown only extras enrolled under this exact fixture, rechecked before close.
    const physical = fs.realpathSync(root)
    for (const [fd, identity] of ownedDescriptors(root)) {
      if (before.get(fd) === identity) continue
      if (descriptorIdentity(fd, physical) !== identity) throw new Error('owned descriptor identity changed during cleanup')
      fs.closeSync(fd)
    }
  } catch (cleanup) {
    if (failed) throw new AggregateError([original, cleanup], 'owned assertion and descriptor cleanup failed')
    throw cleanup
  }
  if (failed) throw original
}

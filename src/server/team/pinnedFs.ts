// Descriptor-relative filesystem primitives for runTeamSetup (integration
// R5): the setup's write boundary must be a kernel-pinned directory inode,
// not a re-checked path, so a concurrent rename/symlink swap of any path
// component can never redirect a write. Node exposes no *at() syscalls, so
// the primitives come from the process libc through Bun's built-in FFI —
// no new package dependency. Bindings load lazily, on the first use; a
// platform whose libc cannot be loaded fails closed (the caller turns that
// into the existing setup result envelope — never an unpinned path write).
// Darwin is typechecked here but exercised only by its release build: this
// suite runs the Linux bindings natively (integration R5 limitation).
import { dlopen, FFIType, read, toArrayBuffer } from 'bun:ffi'
import fs from 'node:fs'

/** The libc name, errno-location symbol, and dirent reader ABI per platform. */
const PLATFORMS: Record<string, { library: string; errnoSymbol: string; dirSymbols: { fdopendir: string; readdir: string } } | undefined> = {
  linux: { library: 'libc.so.6', errnoSymbol: '__errno_location', dirSymbols: { fdopendir: 'fdopendir', readdir: 'readdir' } },
  // Apple xnu bsd/sys/fcntl.h:190/195: AT_FDCWD is -2 on Darwin (-100 on
  // Linux). darwin-x64 keeps the legacy inode ABI for dirent readers unless
  // the $INODE64-suffixed symbols are named; arm64 defaults are 64-bit.
  darwin: { library: 'libc.dylib', errnoSymbol: '__error', dirSymbols: { fdopendir: 'fdopendir$INODE64', readdir: 'readdir$INODE64' } },
}
const DARWIN = process.platform === 'darwin'
const DIR_SYMBOLS = DARWIN ? PLATFORMS.darwin!.dirSymbols : PLATFORMS.linux!.dirSymbols

interface Symbols {
  openat: (dirfd: number, path: string, flags: number, mode: number) => number
  mkdirat: (dirfd: number, path: string, mode: number) => number
  linkat: (olddirfd: number, oldpath: string, newdirfd: number, newpath: string, flags: number) => number
  unlinkat: (dirfd: number, path: string, flags: number) => number
  dup: (fd: number) => number
  fdopendir: (fd: number) => number
  readdir: (dir: number) => number
  closedir: (dir: number) => number
  readonly errnoLocation: () => number
}

let loaded: Symbols | null = null

function load(): Symbols {
  if (loaded) return loaded
  const platform = PLATFORMS[process.platform]
  if (!platform) throw new PinnedFsError(`Set up team has no pinned-directory backend for ${process.platform}`)
  const module = dlopen(platform.library, {
    openat: { args: [FFIType.int, FFIType.cstring, FFIType.int, FFIType.int], returns: FFIType.int },
    mkdirat: { args: [FFIType.int, FFIType.cstring, FFIType.int], returns: FFIType.int },
    linkat: { args: [FFIType.int, FFIType.cstring, FFIType.int, FFIType.cstring, FFIType.int], returns: FFIType.int },
    unlinkat: { args: [FFIType.int, FFIType.cstring, FFIType.int], returns: FFIType.int },
    dup: { args: [FFIType.int], returns: FFIType.int },
    [DIR_SYMBOLS.fdopendir]: { args: [FFIType.int], returns: FFIType.ptr },
    [DIR_SYMBOLS.readdir]: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.int },
    [platform.errnoSymbol]: { args: [], returns: FFIType.ptr },
  })
  const symbols = module.symbols as unknown as { readonly [symbol: string]: (...args: unknown[]) => unknown }
  loaded = {
    openat: (dirfd, path, flags, mode) => symbols.openat(dirfd, path, flags, mode) as number,
    mkdirat: (dirfd, path, mode) => symbols.mkdirat(dirfd, path, mode) as number,
    linkat: (olddirfd, oldpath, newdirfd, newpath, flags) => symbols.linkat(olddirfd, oldpath, newdirfd, newpath, flags) as number,
    unlinkat: (dirfd, path, flags) => symbols.unlinkat(dirfd, path, flags) as number,
    dup: fd => symbols.dup(fd) as number,
    fdopendir: fd => symbols[DIR_SYMBOLS.fdopendir](fd) as number,
    readdir: dir => symbols[DIR_SYMBOLS.readdir](dir) as number,
    closedir: dir => symbols.closedir(dir) as number,
    errnoLocation: () => symbols[platform.errnoSymbol]() as number,
  }
  return loaded
}

/** A foreign call failed; `errno` is the raw kernel errno right after it. */
export class PinnedFsError extends Error {
  constructor(message: string, readonly errno?: number) { super(message) }
}

function fail(operation: string): never {
  const errno = read.i32(load().errnoLocation())
  throw new PinnedFsError(`${operation} failed (errno ${errno})`, errno)
}

/** AT_FDCWD: -2 on Darwin (xnu bsd/sys/fcntl.h:190), -100 on Linux. */
export const AT_FDCWD = DARWIN ? -2 : -100
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW } = fs.constants
const DIRECTORY_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW

/** Errno values the setup maps to result outcomes (identical on both libcs). */
export const ENOENT = 2
export const EACCES = 13
export const EEXIST = 17
export const ENOTDIR = 20
/** ELOOP differs between ABIs: 40 on Linux, 32 on Darwin. */
export const ELOOP = DARWIN ? 32 : 40

/** Open `name` under `dirfd` (AT_FDCWD for a root path), directory only, never through a symlink. */
export function openDirAt(dirfd: number, name: string): number {
  const fd = load().openat(dirfd, name, DIRECTORY_FLAGS, 0)
  if (fd === -1) fail(`openat ${name}`)
  return fd
}

/** Create `name` under `dirfd` (mkdir(2) semantics; fails EEXIST on any existing entry). */
export function mkdirAt(dirfd: number, name: string): void {
  if (load().mkdirat(dirfd, name, 0o777) === -1) fail(`mkdirat ${name}`)
}

/** Hard-link `from` to `to`, both under `dirfd`; fails EEXIST when `to` exists. */
export function linkAt(dirfd: number, from: string, to: string): void {
  if (load().linkat(dirfd, from, dirfd, to, 0) === -1) fail(`linkat ${from} -> ${to}`)
}

/** Remove `name` under `dirfd`. Only ENOENT is swallowed, and only by the caller's choice. */
export function unlinkAt(dirfd: number, name: string): void {
  if (load().unlinkat(dirfd, name, 0) === -1) fail(`unlinkat ${name}`)
}

/** Open `name` under `dirfd` for exclusive creation; never follows a symlink. */
export function createExclusive(dirfd: number, name: string): number {
  const fd = load().openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
  if (fd === -1) fail(`create ${name}`)
  return fd
}

/** The raw errno of the most recent failing foreign call (0 after successes). */
export function lastErrno(): number {
  return read.i32(load().errnoLocation())
}

/** `name` under `dirfd`, opened without following a symlink, read-only; -1 with errno on refusal. */
export function openNoFollow(dirfd: number, name: string): number {
  return load().openat(dirfd, name, O_RDONLY | O_NOFOLLOW, 0)
}

/** Every name in the pinned directory at `dirfd` (`.` and `..` included). */
export function listDir(dirfd: number): string[] {
  const symbols = load()
  const dup = symbols.dup(dirfd)
  if (dup === -1) fail('dup')
  const dir = symbols.fdopendir(dup)
  // fdopendir consumed the duplicate; closedir releases it below.
  if (!dir || Number(dir) === 0) { try { fs.closeSync(dup) } catch { /* already gone */ } fail('fdopendir') }
  const names: string[] = []
  try {
    for (;;) {
      const entry = symbols.readdir(dir)
      if (!entry || Number(entry) === 0) break
      const reclen = read.u16(entry, 16)
      // dirent name offset: 19 on Linux (u64 ino, u64 off, u16 reclen, u8
      // type); 21 on Darwin (u64 ino, u64 seekoff, u16 reclen, u16 namlen,
      // u8 type) — xnu bsd/sys/dirent.h:97-104. reclen sits at 16 on both.
      const nameAt = DARWIN ? 21 : 19
      if (reclen < nameAt + 2 || reclen > 65536) throw new PinnedFsError(`unparsable dirent record (reclen ${reclen})`)
      const bytes = new Uint8Array(toArrayBuffer(entry, nameAt, reclen - nameAt))
      let end = 0
      while (end < bytes.length && bytes[end] !== 0) end++
      const name = new TextDecoder().decode(bytes.subarray(0, end))
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new PinnedFsError(`unparsable dirent name (${JSON.stringify(name)})`)
      names.push(name)
    }
  } finally {
    symbols.closedir(dir)
  }
  return names
}

// Dormant opt-in S4 owner. No application context, admission or recovery.
import { closeSync } from 'node:fs';
import { Socket } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { cleanGitEnv, GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS } from './gitCommand';
import type { AsyncGitCommandOptions, GitCommandResult } from './gitCommand';
import { decodeGitResultFrame } from './ownedGitProtocol';
import { prepareAnchorStartup } from './ownedGitStartup';
import { createRecord, lateAttempt, settleRecord } from './ownedGitRecord';
import type { OwnedRecord, OwnedReason, OwnedCleanupDetails } from './ownedGitRecord';

export type { OwnedCleanupDetails, OwnedReason };
export interface OwnedGitContext {
  run(args: string[], options: AsyncGitCommandOptions): Promise<GitCommandResult>;
  readonly retainedRecords: readonly Readonly<{
    phase: OwnedRecord['phase']; pid: number | null; queryUsed: boolean;
    joined: boolean; rootPending: boolean; cleanup: Readonly<OwnedCleanupDetails> | null;
  }>[];
}
class Context implements OwnedGitContext {
  #records = new Set<OwnedRecord>();
  get retainedRecords(): OwnedGitContext['retainedRecords'] {
    return Object.freeze([...this.#records].map(r => Object.freeze({
      phase: r.phase, pid: r.pid ?? null, queryUsed: r.queryUsed, joined: r.joined,
      rootPending: !r.rootDisposed, cleanup: r.result ? Object.freeze({ ...r.result.cleanupDetails }) : null,
    })));
  }
  async run(args: string[], options: AsyncGitCommandOptions): Promise<GitCommandResult> {
    const r = createRecord(options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES);
    this.#records.add(r);
    const query = (pid: number) => { process.kill(-pid, 0); };
    let wake!: () => void;
    const ready = new Promise<void>(resolve => { wake = resolve; });
    let control: Socket | undefined;
    const captureCloses: (() => void)[] = [];
    let controlClose: (() => void) | undefined;
    let controlClosed: Promise<void> | undefined;
    let finalScheduled = false;
    let graceStarted = false;
    let finalAttempted = false;
    let exitSeen!: Promise<void>;
    let markExit!: () => void;
    let settling = false;
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    function timer(fn: () => void, ms: number): void {
      const token = setTimeout(() => { r.timers.delete(token); if (!r.result) fn(); }, ms);
      r.timers.add(token);
    }
    function fault(reason: 'handshake' | 'protocol' | 'owner-lost'): void {
      r.fault ??= reason;
      adverse();
    }
    function rootDisposal(): void {
      if ((!r.invoked || r.joined) && r.root && !r.rootFailed) {
        try { r.root.dispose(); r.root = undefined; r.rootDisposed = true; }
        catch (error) { r.errors.push(error); r.rootFailed = true; r.disposalFault = true; }
      }
    }
    function disposal(): void {
      rootDisposal();
      if (!r.invoked || r.joined) {
        for (const fd of r.rawFds) {
          r.rawFds.delete(fd);
          try { closeSync(fd); } catch (error) {
            r.errors.push(error); r.uncertainFd = true; r.uncertainFds.add(fd); r.disposalFault = true;
          }
        }
      }
      r.physicalReady = r.rootDisposed && !r.uncertainFd && r.rawFds.size === 0
        && r.resources.every(resource => resource.closed) && r.actions === 0 && r.timers.size === 0
        && (!r.invoked || r.statusTerminal);
      if (r.physicalReady) { r.resources = []; r.waiters = []; r.handle = undefined; }
    }
    const terminal = (source: 'owner' | 'stdout' | 'stderr' | 'status') => {
      disposal();
      lateAttempt(r, source, query);
      if (r.retired) this.#records.delete(r);
      check();
    };
    function live(): boolean {
      return !r.result && r.hello && !r.ownerExited && !r.joined && r.handle !== undefined
        && r.handle.pid === r.pid && r.handle.exitCode === null && r.handle.signalCode === null
        && control !== undefined && !control.destroyed && control.writable;
    }
    function write(frame: object, done: () => void): void {
      if (!live() || !control) { fault(r.hello ? 'owner-lost' : 'handshake'); return; }
      const bytes = Buffer.from(JSON.stringify(frame) + '\n');
      if (bytes.length > 64 * 1024 * 1024) { fault('protocol'); return; }
      r.actions++;
      try {
        control.write(bytes, error => {
          r.actions--;
          if (error) { r.errors.push(error); fault('protocol'); }
          else if (!r.result) {
            try { done(); } catch (failure) { r.errors.push(failure); fault('protocol'); }
          }
          disposal(); // Action completion alone never triggers a query.
          check();
        });
      } catch (error) { r.actions--; r.errors.push(error); fault('protocol'); }
    }
    function release(): void {
      if (r.result || finalScheduled || !live()) return;
      finalScheduled = true;
      r.phase = 'releasing';
      write({ type: 'TERM' }, () => {
        timer(() => {
          if (!live()) { fault('owner-lost'); return; }
          finalAttempted = true;
          write({ type: 'FINAL' }, () => { r.finalSent = true; control?.end(); });
        }, 200);
      });
    }
    function cancelCaptures(): void {
      for (const k of [0, 1] as const) {
        if (!r.terminal[k] && !r.cancelled[k]) { r.cancelled[k] = true; captureCloses[k]?.(); }
      }
    }
    function adverse(): void {
      if (r.result) return;
      release();
      if (!graceStarted) {
        graceStarted = true;
        timer(() => {
          r.graceExpired = true;
          cancelCaptures();
          for (const resource of r.resources) if (!resource.closed) resource.close();
          wake();
        }, 1000);
      }
    }
    function check(): void {
      if (r.result || settling) return;
      if (r.timeout || r.spawnFault || r.captureFault || r.fault) adverse();
      else if (r.tuple && r.terminal.every(Boolean)) release();
      if (r.joined && r.terminal.every(Boolean) && r.statusTerminal && r.actions === 0
        && r.resources.every(resource => resource.closed)) wake();
    }
    function wrap(fd: number, readable: boolean): { socket: Socket; closed: Promise<void>; close(): void } {
      r.rawFds.delete(fd);
      let socket: Socket;
      try { socket = new Socket({ fd, readable, writable: !readable, allowHalfOpen: false }); }
      catch (error) { r.uncertainFd = true; r.uncertainFds.add(fd); r.errors.push(error); throw error; }
      let attempted = false;
      const resource = {
        closed: false,
        close(): void {
          if (attempted || resource.closed) return;
          attempted = true;
          try { socket.destroy(); }
          catch (error) { r.errors.push(error); r.disposalFault = true; }
        },
      };
      r.resources.push(resource);
      const closed = new Promise<void>(resolve => {
        socket.once('close', () => { resource.closed = true; resolve(); });
      });
      socket.on('error', () => {}); // Collector/control/status handlers preserve the actual failure.
      return { socket, closed, close: resource.close };
    }
    function collect(k: 0 | 1, socket: Socket, closed: Promise<void>, close: () => void): void {
      captureCloses[k] = close;
      let eof = false;
      socket.once('end', () => { eof = true; close(); });
      const work = (async () => {
        let text = '';
        try { text = await new Response(Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>).text(); }
        catch (error) {
          r.errors.push(error);
          if (!r.cancelled[k]) { r.captureFault = true; cancelCaptures(); adverse(); }
        }
        await closed;
        return { text, eof };
      })();
      r.waiters.push(work);
      void work.then(value => {
        r.output[k] = value.text;
        r.eof[k] = value.eof && !r.cancelled[k];
        r.terminal[k] = true;
        if (!value.eof && !r.cancelled[k]) { r.captureFault = true; cancelCaptures(); adverse(); }
        terminal(k === 0 ? 'stdout' : 'stderr');
      }, error => { r.errors.push(error); r.captureFault = true; r.terminal[k] = true; adverse(); terminal(k === 0 ? 'stdout' : 'stderr'); });
    }
    function meta(bytes: Buffer): Record<string, unknown> {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status');
      const names = [...text.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].map(match => JSON.parse(match[0].slice(0, -1).trim()));
      if (names.length !== Object.keys(value).length || new Set(names).size !== names.length) throw new Error('Duplicate status key');
      return value as Record<string, unknown>;
    }
    function exact(frame: Record<string, unknown>, fields: string[]): boolean {
      return Object.keys(frame).length === fields.length && fields.every(key => Object.hasOwn(frame, key));
    }
    let executable = '', cwd = '';
    let gitEnv: NodeJS.ProcessEnv = {};
    function frame(bytes: Buffer): void {
      if (r.result || r.fault) return;
      const value = meta(bytes);
      if (!r.hello) {
        if (!exact(value, ['type', 'v', 'pid', 'pgrp', 'session']) || value.type !== 'HELLO' || value.v !== 1
          || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 1
          || value.pid !== value.pgrp || value.pid !== value.session || value.pid !== r.handle?.pid || r.ownerExited) {
          fault('handshake'); return;
        }
        r.pid = value.pid; r.hello = true; r.phase = 'owner-valid';
        if (r.timeout || r.spawnFault || r.captureFault) { release(); return; }
        r.runSent = true;
        write({ type: 'RUN', executable, args, cwd, gitEnv }, () => {});
      } else if (value.type === 'STARTED' && exact(value, ['type']) && r.runSent && !r.started && !r.tuple && !r.closing && !r.ownerExited) {
        r.started = true; if (!finalScheduled) r.phase = 'running';
      } else if (value.type === 'GIT_RESULT' && r.started && !r.tuple && !r.closing && !r.ownerExited) {
        const tuple = decodeGitResultFrame(bytes);
        if (!tuple) { fault('protocol'); return; }
        r.tuple = tuple;
      } else if (value.type === 'SPAWN_ERROR' && exact(value, ['type']) && r.runSent && !r.started && !r.spawnFault && !r.closing) {
        r.spawnFault = true;
      } else if (value.type === 'CLOSING' && exact(value, ['type']) && finalAttempted && !r.closing) {
        r.closing = true;
      } else { fault('protocol'); }
      check();
    }
    function readStatus(socket: Socket, closed: Promise<void>, close: () => void): void {
      const work = (async () => {
        let pending = Buffer.alloc(0);
        try {
          for await (const data of socket) {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            let offset = 0;
            while (offset < chunk.length) {
              const end = chunk.indexOf(10, offset);
              const part = end < 0 ? chunk.subarray(offset) : chunk.subarray(offset, end);
              if (pending.length + part.length + (end < 0 ? 0 : 1) > 512) throw new Error('Oversized status');
              pending = Buffer.concat([pending, part]);
              if (end < 0) break;
              const bytes = pending; pending = Buffer.alloc(0); frame(bytes); offset = end + 1;
            }
          }
          if (pending.length || !r.hello || (!r.tuple && !r.spawnFault) || !r.closing) fault(r.hello ? 'protocol' : 'handshake');
        } catch (error) { r.errors.push(error); fault(r.hello ? 'protocol' : 'handshake'); }
        close();
        await closed;
        controlClose?.(); // Status EOF ends control authority, even before JOIN.
        if (controlClosed) await controlClosed;
      })();
      r.waiters.push(work);
      void work.then(() => { r.statusTerminal = true; terminal('status'); },
        error => { r.errors.push(error); r.statusTerminal = true; fault('protocol'); terminal('status'); });
    }
    function watchOwner(owner: NonNullable<OwnedRecord['handle']>): void {
      if (r.handle && r.handle !== owner) {
        r.spawnFault = true; r.uncertainFd = true;
        r.rootFailed = true; // An inconsistent second owner cannot release root custody.
        r.waiters.push(owner.exited.then(() => {}, error => { r.errors.push(error); }));
        return;
      }
      r.handle = owner; r.capturesStarted = true;
      if (r.joinWatching) return;
      r.joinWatching = true;
      const join = Promise.all([owner.exited, exitSeen]);
      r.waiters.push(join);
      void join.then(() => { r.joined = true; terminal('owner'); },
        error => { r.errors.push(error); fault('owner-lost'); });
    }
    // Only this callback, not elapsed time or a missing code, creates T.
    timer(() => { r.timeout = true; adverse(); }, timeoutMs);
    try {
      if (process.platform !== 'linux') { r.local = 'unsupported-platform'; throw new Error('Unsupported platform'); }
      r.local = 'executable';
      cwd = resolve(options.cwd ?? process.cwd());
      gitEnv = { ...cleanGitEnv(), ...options.env };
      const found = Bun.which('git', { cwd, ...(typeof gitEnv.PATH === 'string' ? { PATH: gitEnv.PATH } : {}) });
      if (!found || !isAbsolute(found)) { r.local = 'executable'; throw new Error('No absolute Git executable'); }
      executable = found;
      r.local = 'startup';
      const startup = prepareAnchorStartup();
      r.root = startup; r.rootDisposed = false; r.local = undefined;
      exitSeen = new Promise<void>(resolve => { markExit = resolve; });
      r.invoked = true; r.phase = 'spawn-invoked';
      const handle = Bun.spawn(startup.argv, {
        cwd: startup.cwd, env: startup.env, detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'socket-fd', 'socket-fd', 'socket-fd', 'socket-fd'],
        onExit: (owner, _code, signal, error) => {
          if (error) { r.errors.push(error); r.fault ??= 'protocol'; }
          watchOwner(owner); r.ownerExited = true;
          r.expectedExit = finalAttempted && (signal === 'SIGKILL' || signal === 9);
          if (!r.expectedExit || !r.tuple) r.fault ??= r.hello ? 'owner-lost' : 'handshake';
          markExit(); check();
        },
      });
      watchOwner(handle);
      const slots = handle.stdio; // Exactly one caller-ownership transfer.
      for (const fd of slots.slice(3)) {
        if (typeof fd === 'number' && Number.isSafeInteger(fd) && fd > 2) r.rawFds.add(fd);
        else if (typeof fd === 'number') { r.uncertainFd = true; r.uncertainFds.add(fd); }
      }
      const fds = slots.slice(3, 7);
      if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1 || slots.length !== 7 || fds.length !== 4
        || fds.some(fd => typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd <= 2) || new Set(fds).size !== 4) {
        r.spawnFault = true; throw new Error('Uncertain subprocess/fd layout');
      }
      const [outFd, errFd, controlFd, statusFd] = fds as [number, number, number, number];
      const out = wrap(outFd, true), err = wrap(errFd, true), input = wrap(controlFd, false), output = wrap(statusFd, true);
      control = input.socket; controlClosed = input.closed; controlClose = input.close;
      control.on('error', () => fault('protocol'));
      collect(0, out.socket, out.closed, out.close); collect(1, err.socket, err.closed, err.close);
      readStatus(output.socket, output.closed, output.close);
    } catch (error) {
      r.errors.push(error);
      if (!r.invoked) {
        if (r.local === 'startup' && error instanceof AggregateError && Object.hasOwn(error, 'startup')) {
          r.rootDisposed = false; r.rootFailed = true; r.disposalFault = true;
          const descriptor = Object.getOwnPropertyDescriptor(error, 'startup');
          const startup: unknown = descriptor?.value;
          if (startup && typeof startup === 'object' && 'dispose' in startup && typeof startup.dispose === 'function'
            && 'cwd' in startup && typeof startup.cwd === 'string') {
            r.root = startup as NonNullable<OwnedRecord['root']>; r.rootDisposed = false; r.rootFailed = true; r.disposalFault = true;
          }
        }
        wake();
      } else { r.spawnFault = true; adverse(); }
    }
    await ready;
    settling = true;
    for (const token of r.timers) clearTimeout(token);
    r.timers.clear();
    disposal();
    if (!r.local && !r.tuple && !r.spawnFault) r.fault ??= r.hello ? 'protocol' : 'handshake';
    const result = settleRecord(r, query);
    if (r.retired) this.#records.delete(r);
    return result;
  }
}
export function createOwnedGitContext(): OwnedGitContext { return new Context(); }

/**
 * Dormant S3 executable owner. Importing this file performs no process control.
 * Only this live entry may signal its own validated group. Git's tuple comes
 * only from its reaped child's exit event; anchor exit is never Git evidence.
 * Native FD/flag/order behavior and S4 parent validation remain unverified.
 */
import { spawn } from 'node:child_process';
import { closeSync, readFileSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { decodeGitResultFrame } from './ownedGitProtocol';

function runAnchor(): void {
  type Run = { type: 'RUN'; executable: string; args: string[]; cwd: string; gitEnv: NodeJS.ProcessEnv };
  const captures = new Set([3, 4]);
  let control: Socket | undefined;
  let statusOpen = true;
  let fault = false;
  let helloSent = false;
  let runSeen = false;
  let started = false;
  let spawnFailed = false;
  let termSent = false;
  let closing = false;
  let pending = Buffer.alloc(0);

  function selfIdentity(): { pid: number; pgrp: number; session: number } {
    if (process.platform !== 'linux') throw new Error('Linux SELF metadata required');
    const raw = readFileSync('/proc/self/stat', 'utf8');
    const begin = raw.indexOf('('), end = raw.lastIndexOf(')');
    if (begin < 1 || end <= begin) throw new Error('Invalid SELF metadata');
    const fields = raw.slice(end + 1).trim().split(/\s+/);
    const values = [raw.slice(0, begin).trim(), fields[2], fields[3]];
    if (values.some(value => !value || !/^[1-9][0-9]*$/.test(value))) {
      throw new Error('Invalid SELF identity fields');
    }
    const pid = Number(values[0]), pgrp = Number(values[1]), session = Number(values[2]);
    if (![pid, pgrp, session].every(Number.isSafeInteger)
      || pid <= 1 || pid !== process.pid || pgrp !== pid || session !== pid) {
      throw new Error('Anchor is not its own group and session leader');
    }
    return { pid, pgrp, session };
  }

  function closeCaptures(): void {
    let failed = false;
    for (const fd of captures) {
      captures.delete(fd);
      try { closeSync(fd); } catch { failed = true; }
    }
    if (failed) throw new Error('Capture handoff close failed');
  }

  function failClosed(): void {
    if (fault) return;
    fault = true;
    process.exitCode = 1;
    control?.destroy();
    try { closeCaptures(); } catch { /* The missing protocol is failure evidence. */ }
    if (statusOpen) {
      statusOpen = false;
      try { closeSync(6); } catch { /* No cleanup or retirement claim follows. */ }
    }
  }

  function send(frame: object): void {
    if (fault || !statusOpen) throw new Error('Status channel unavailable');
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > 512) throw new Error('Oversized status frame');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(6, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
        throw new Error('Incomplete status write');
      }
      offset += written;
    }
  }

  function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  }

  function keys(value: Record<string, unknown>, expected: string[]): boolean {
    return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
  }

  function parseControl(bytes: Buffer): Record<string, unknown> {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!record(value)) throw new Error('Control frame must be an object');
    // JSON.parse validates syntax; this scan also rejects duplicate decoded
    // names, including aliases such as "type" and "ty\u0070e", at every depth.
    const containers: (Set<string> | null)[] = [];
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 123) containers.push(new Set());
      else if (unit === 91) containers.push(null);
      else if (unit === 125 || unit === 93) containers.pop();
      else if (unit === 34) {
        const start = i++;
        for (; i < text.length; i++) {
          if (text.charCodeAt(i) === 92) i++;
          else if (text.charCodeAt(i) === 34) break;
        }
        let next = i + 1;
        while ([32, 9, 10, 13].includes(text.charCodeAt(next))) next++;
        if (text.charCodeAt(next) === 58) {
          const key: unknown = JSON.parse(text.slice(start, i + 1));
          const names = containers.at(-1);
          if (typeof key !== 'string' || !names || names.has(key)) {
            throw new Error('Duplicate control key');
          }
          names.add(key);
        }
      }
    }
    return value;
  }

  function validRun(frame: Record<string, unknown>): frame is Run {
    return keys(frame, ['type', 'executable', 'args', 'cwd', 'gitEnv']) && frame.type === 'RUN'
      && typeof frame.executable === 'string' && isAbsolute(frame.executable)
      && typeof frame.cwd === 'string' && isAbsolute(frame.cwd)
      && Array.isArray(frame.args) && frame.args.every(arg => typeof arg === 'string')
      && record(frame.gitEnv) && Object.values(frame.gitEnv).every(value => typeof value === 'string');
  }

  function startGit(frame: Run): void {
    selfIdentity();
    runSeen = true;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(frame.executable, frame.args, {
        argv0: 'git', cwd: frame.cwd, env: frame.gitEnv,
        detached: false, shell: false, stdio: ['ignore', 3, 4, 'ignore', 'ignore', 'ignore', 'ignore'],
      });
    } catch {
      closeCaptures();
      spawnFailed = true;
      send({ type: 'SPAWN_ERROR' });
      return;
    }
    child.once('error', () => {
      if (fault || closing) return;
      try {
        if (started) throw new Error('Child failed after STARTED');
        spawnFailed = true;
        send({ type: 'SPAWN_ERROR' });
      } catch { failClosed(); }
    });
    child.once('spawn', () => {
      if (fault || closing) return;
      try {
        if (started || spawnFailed) throw new Error('Invalid child start order');
        started = true;
        send({ type: 'STARTED' });
      } catch { failClosed(); }
    });
    child.once('exit', (code, signal) => {
      if (fault || closing || spawnFailed) return;
      try {
        if (!started) throw new Error('Child exited before STARTED');
        const bytes = Buffer.from(JSON.stringify({ type: 'GIT_RESULT', code, signal }));
        const tuple = decodeGitResultFrame(bytes);
        if (!tuple) throw new Error('Invalid reaped-child tuple');
        send(tuple);
      } catch { failClosed(); }
    });
    // Numeric stdio transfers copies to Git's stdout/stderr only. Git does
    // not inherit control/status fd5/fd6. The anchor retains neither capture.
    closeCaptures();
  }

  function command(frame: Record<string, unknown>): void {
    if (fault || closing) return; // Never replay a command after owner/channel loss.
    if (!helloSent) throw new Error('Control before HELLO');
    if (frame.type === 'RUN') {
      if (runSeen || termSent || !validRun(frame)) throw new Error('Invalid RUN');
      startGit(frame);
    } else if (keys(frame, ['type']) && frame.type === 'TERM') {
      if (termSent) throw new Error('Duplicate TERM');
      const owner = selfIdentity();
      termSent = true;
      process.kill(-owner.pid, 'SIGTERM');
    } else if (keys(frame, ['type']) && frame.type === 'FINAL') {
      if (!termSent) throw new Error('FINAL before TERM');
      const owner = selfIdentity();
      closing = true;
      // A CLOSING receipt is not proof the following syscall ran or reaped
      // any group member. Only S4's separate settlement can classify proof.
      send({ type: 'CLOSING' });
      process.kill(-owner.pid, 'SIGKILL');
      failClosed(); // A returning seam/failure must never synthesize success.
    } else {
      throw new Error('Unknown control action');
    }
  }

  try {
    // A caught handler is reset across exec; Git does not inherit SIG_IGN.
    process.on('SIGTERM', () => { if (!termSent) failClosed(); });
    const owner = selfIdentity();
    control = new Socket({ fd: 5, readable: true, writable: false });
    control.on('error', failClosed);
    control.on('end', () => { if (!closing) failClosed(); });
    control.on('close', () => { if (!closing) failClosed(); });
    control.on('data', (chunk: Buffer) => {
      if (fault || closing) return;
      try {
        let cursor = 0;
        while (cursor < chunk.length) {
          const end = chunk.indexOf(10, cursor);
          const part = end < 0 ? chunk.subarray(cursor) : chunk.subarray(cursor, end);
          if (pending.length + part.length > 64 * 1024 * 1024) {
            throw new Error('Oversized control frame');
          }
          pending = Buffer.concat([pending, part]);
          if (end < 0) break;
          const frame = pending;
          pending = Buffer.alloc(0);
          command(parseControl(frame));
          if (fault || closing) return;
          cursor = end + 1;
        }
      } catch { failClosed(); }
    });
    send({ type: 'HELLO', v: 1, ...owner });
    helloSent = true;
  } catch { failClosed(); }
}

if (import.meta.main) runAnchor();

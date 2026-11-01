// S2 filesystem/bootstrap witnesses only; no Git, anchor, signal or context proof.
// All files read below are owned temporary inputs, never repository data files.
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { prepareAnchorStartup } from '../git/ownedGitStartup';

function withOwnedRoot(run: (root: string, restore: (cleanup: () => void) => void) => void): void {
  const environment = { ...process.env };
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'owned-git-startup-test-')));
  const identity = fs.lstatSync(root, { bigint: true });
  const cleanups: (() => void)[] = [];
  const errors: unknown[] = [];
  try {
    run(root, cleanup => cleanups.push(cleanup));
  } catch (error) {
    errors.push(error);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(environment, key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const current = fs.lstatSync(root, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('Refusing teardown of an unowned unit-test root');
      }
      fs.rmSync(root, { recursive: true, force: false });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Unit assertion or owned teardown failed', { cause: errors[0] });
}

function bootstrapError(): unknown {
  let startup: ReturnType<typeof prepareAnchorStartup>;
  try { startup = prepareAnchorStartup(); } catch (error) { return error; }
  const unexpected = new Error('Expected the actual bootstrap call to throw');
  try { startup.dispose(); } catch (disposalError) {
    throw new AggregateError([unexpected, disposalError], 'Unexpected bootstrap success and teardown failure', { cause: unexpected });
  }
  throw unexpected;
}

test('S2 bootstrap isolates files, argv and env and disposes only its owned root', () => {
  withOwnedRoot((root, restore) => {
    const temporaryDirectory = spyOn(os, 'tmpdir');
    restore(() => temporaryDirectory.mockRestore());
    temporaryDirectory.mockReturnValue(root);
    process.env.BUN_OPTIONS = '--no-env-file';
    process.env.NODE_OPTIONS = '--no-warnings';
    const environment = { ...process.env };
    const sentinel = join(root, 'sibling-sentinel');
    fs.writeFileSync(sentinel, 'owned sibling', { mode: 0o600, flag: 'wx' });
    const sentinelIdentity = fs.lstatSync(sentinel, { bigint: true });

    const startup = prepareAnchorStartup();
    restore(() => startup.dispose());
    expect(dirname(startup.cwd)).toBe(root);
    const directories = ['home', 'config', 'cache', 'data', 'state', 'runtime', 'tmp'];
    for (const directory of [startup.cwd, ...directories.map(name => join(startup.cwd, name))]) {
      const metadata = fs.lstatSync(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o7777).toBe(0o700);
    }
    const bunfig = join(startup.cwd, 'bunfig.toml');
    const tsconfig = join(startup.cwd, 'tsconfig.json');
    for (const file of [bunfig, tsconfig]) {
      const metadata = fs.lstatSync(file);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o7777).toBe(0o600);
    }
    expect(fs.readdirSync(startup.cwd).sort()).toEqual([...directories, 'bunfig.toml', 'tsconfig.json'].sort());
    expect(Bun.TOML.parse(fs.readFileSync(bunfig, 'utf8'))).toEqual({
      preload: [], env: false, install: { auto: 'disable' },
    });
    expect(JSON.parse(fs.readFileSync(tsconfig, 'utf8'))).toEqual({});
    expect(startup.argv).toEqual([
      process.execPath,
      '--no-env-file',
      '--no-install',
      `--config=${bunfig}`,
      `--tsconfig-override=${tsconfig}`,
      resolve(import.meta.dir, '../git/gitCommandAnchor.ts'),
    ]);
    const privateEnvironment = {
      HOME: join(startup.cwd, 'home'),
      XDG_CONFIG_HOME: join(startup.cwd, 'config'),
      XDG_CACHE_HOME: join(startup.cwd, 'cache'),
      XDG_DATA_HOME: join(startup.cwd, 'data'),
      XDG_STATE_HOME: join(startup.cwd, 'state'),
      XDG_RUNTIME_DIR: join(startup.cwd, 'runtime'),
      TMPDIR: join(startup.cwd, 'tmp'),
      TMP: join(startup.cwd, 'tmp'),
      TEMP: join(startup.cwd, 'tmp'),
    };
    expect(startup.env).toEqual(privateEnvironment);
    expect(Object.keys(startup.env).sort()).toEqual(Object.keys(privateEnvironment).sort());
    expect(Object.hasOwn(startup.env, 'BUN_OPTIONS')).toBe(false);
    expect(Object.hasOwn(startup.env, 'NODE_OPTIONS')).toBe(false);
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(environment).sort());
    expect(Object.entries(environment).every(([key, value]) => process.env[key] === value)).toBe(true);

    startup.dispose();
    expect(fs.existsSync(startup.cwd)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('owned sibling');
    const preserved = fs.lstatSync(sentinel, { bigint: true });
    expect([preserved.dev, preserved.ino]).toEqual([sentinelIdentity.dev, sentinelIdentity.ino]);
    expect(() => startup.dispose()).not.toThrow();
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('owned sibling');
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(environment).sort());
    expect(Object.entries(environment).every(([key, value]) => process.env[key] === value)).toBe(true);
  });
});

test('S2 pre-root failure rethrows the original error without acquiring custody', () => {
  withOwnedRoot((root, restore) => {
    const temporaryDirectory = spyOn(os, 'tmpdir');
    restore(() => temporaryDirectory.mockRestore());
    temporaryDirectory.mockReturnValue(root);
    const original = new Error('injected mkdtemp failure');
    const native = fs.mkdtempSync;
    const allocation = spyOn(fs, 'mkdtempSync');
    restore(() => allocation.mockRestore());
    allocation.mockImplementation(((...args: Parameters<typeof fs.mkdtempSync>) => {
      if (args[0] === join(root, 'kawai-owned-git-')) {
        expect(args).toEqual([join(root, 'kawai-owned-git-')]);
        throw original;
      }
      return native(...args);
    }) as typeof fs.mkdtempSync);
    const removal = spyOn(fs, 'rmSync');
    restore(() => removal.mockRestore());

    const observed = bootstrapError();
    expect(observed).toBe(original);
    expect(Object.hasOwn(original, 'startup')).toBe(false);
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(removal).toHaveBeenCalledTimes(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

test('S2 setup failure disposes once and rethrows the same setup error', () => {
  withOwnedRoot((root, restore) => {
    const temporaryDirectory = spyOn(os, 'tmpdir');
    restore(() => temporaryDirectory.mockRestore());
    temporaryDirectory.mockReturnValue(root);
    const allocation = spyOn(fs, 'mkdtempSync');
    restore(() => allocation.mockRestore());
    const setupError = new Error('injected home setup failure');
    const native = fs.mkdirSync;
    const setup = spyOn(fs, 'mkdirSync');
    restore(() => setup.mockRestore());
    setup.mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      const acquired = allocation.mock.results[0]?.value;
      if (typeof acquired === 'string' && args[0] === join(acquired, 'home')) {
        expect(args).toEqual([join(acquired, 'home'), { mode: 0o700 }]);
        throw setupError;
      }
      return native(...args);
    }) as typeof fs.mkdirSync);
    const removal = spyOn(fs, 'rmSync');
    restore(() => removal.mockRestore());

    const observed = bootstrapError();
    expect(observed).toBe(setupError);
    expect(Object.hasOwn(setupError, 'startup')).toBe(false);
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(allocation).toHaveBeenCalledWith(join(root, 'kawai-owned-git-'));
    const acquired = allocation.mock.results[0]?.value as string;
    expect(dirname(acquired)).toBe(root);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(removal).toHaveBeenCalledTimes(1);
    expect(removal).toHaveBeenCalledWith(acquired, { recursive: true, force: false });
    expect(fs.existsSync(acquired)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

test('S2 double failure retains both causes and the same usable disposal handle', () => {
  withOwnedRoot((root, restore) => {
    const temporaryDirectory = spyOn(os, 'tmpdir');
    restore(() => temporaryDirectory.mockRestore());
    temporaryDirectory.mockReturnValue(root);
    const allocation = spyOn(fs, 'mkdtempSync');
    restore(() => allocation.mockRestore());
    const setupError = new Error('injected home setup failure');
    const disposalError = new Error('injected root removal failure');
    const nativeMkdir = fs.mkdirSync;
    const setup = spyOn(fs, 'mkdirSync');
    restore(() => setup.mockRestore());
    setup.mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      const acquired = allocation.mock.results[0]?.value;
      if (typeof acquired === 'string' && args[0] === join(acquired, 'home')) {
        expect(args).toEqual([join(acquired, 'home'), { mode: 0o700 }]);
        throw setupError;
      }
      return nativeMkdir(...args);
    }) as typeof fs.mkdirSync);
    const nativeRemove = fs.rmSync;
    let removalFault = true;
    const removal = spyOn(fs, 'rmSync');
    restore(() => removal.mockRestore());
    removal.mockImplementation((...args: Parameters<typeof fs.rmSync>) => {
      const acquired = allocation.mock.results[0]?.value;
      if (typeof acquired === 'string' && args[0] === acquired) {
        expect(args).toEqual([acquired, { recursive: true, force: false }]);
        if (removalFault) throw disposalError;
      }
      return nativeRemove(...args);
    });

    const observed = bootstrapError();
    expect(observed).toBeInstanceOf(AggregateError);
    const failure = observed as AggregateError;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(setupError);
    expect(failure.errors[1]).toBe(disposalError);
    expect(failure.cause).toBe(setupError);
    const descriptor = Object.getOwnPropertyDescriptor(failure, 'startup');
    expect(descriptor).toBeDefined();
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(Object.keys(failure)).not.toContain('startup');
    const retained = descriptor?.value as ReturnType<typeof prepareAnchorStartup>;
    const dispose = retained.dispose;
    const acquired = allocation.mock.results[0]?.value as string;
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(allocation).toHaveBeenCalledWith(join(root, 'kawai-owned-git-'));
    expect(setup).toHaveBeenCalledTimes(1);
    expect(retained.cwd).toBe(acquired);
    expect(dirname(retained.cwd)).toBe(root);
    expect(fs.existsSync(retained.cwd)).toBe(true);
    expect(removal).toHaveBeenCalledTimes(1);
    expect(Reflect.set(failure, 'startup', {})).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'startup')?.value).toBe(retained);

    removalFault = false;
    retained.dispose();
    expect(retained.dispose).toBe(dispose);
    expect(Object.getOwnPropertyDescriptor(failure, 'startup')?.value).toBe(retained);
    expect(removal).toHaveBeenCalledTimes(2);
    expect(removal).toHaveBeenLastCalledWith(acquired, { recursive: true, force: false });
    expect(fs.existsSync(acquired)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

test('S2 disposal refuses an identity replacement and preserves its owned sentinel', () => {
  withOwnedRoot((root, restore) => {
    const temporaryDirectory = spyOn(os, 'tmpdir');
    restore(() => temporaryDirectory.mockRestore());
    temporaryDirectory.mockReturnValue(root);
    const startup = prepareAnchorStartup();
    let displaced = false;
    restore(() => { if (!displaced) startup.dispose(); });
    expect(dirname(startup.cwd)).toBe(root);
    const originalIdentity = fs.lstatSync(startup.cwd, { bigint: true });
    const moved = join(root, 'moved-original-root');
    fs.renameSync(startup.cwd, moved);
    displaced = true;
    fs.mkdirSync(startup.cwd, { mode: 0o700 });
    const sentinel = join(startup.cwd, 'owned-replacement-sentinel');
    fs.writeFileSync(sentinel, 'owned replacement', { mode: 0o600, flag: 'wx' });
    const replacementIdentity = fs.lstatSync(startup.cwd, { bigint: true });
    expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([originalIdentity.dev, originalIdentity.ino]);
    const removal = spyOn(fs, 'rmSync');
    restore(() => removal.mockRestore());

    expect(() => startup.dispose()).toThrow('Cannot dispose an unverified anchor root');
    expect(removal).toHaveBeenCalledTimes(0);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('owned replacement');
    const preserved = fs.lstatSync(startup.cwd, { bigint: true });
    expect([preserved.dev, preserved.ino]).toEqual([replacementIdentity.dev, replacementIdentity.ino]);
    const original = fs.lstatSync(moved, { bigint: true });
    expect([original.dev, original.ino]).toEqual([originalIdentity.dev, originalIdentity.ino]);
  });
});

test('S2 fake Git ancestor refuses before root acquisition without invoking Git', () => {
  withOwnedRoot((root, restore) => {
    const temporary = join(root, 'nested', 'tmp');
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(root, '.git'), 'owned fake Git marker', { mode: 0o600, flag: 'wx' });
    const temporaryDirectory = spyOn(os, 'tmpdir');
    restore(() => temporaryDirectory.mockRestore());
    temporaryDirectory.mockReturnValue(temporary);
    const allocation = spyOn(fs, 'mkdtempSync');
    restore(() => allocation.mockRestore());

    expect(() => prepareAnchorStartup()).toThrow('Anchor temporary directory must be outside Git worktrees');
    expect(allocation).toHaveBeenCalledTimes(0);
    expect(fs.readdirSync(temporary)).toEqual([]);
    expect(fs.readFileSync(join(root, '.git'), 'utf8')).toBe('owned fake Git marker');
  });
});

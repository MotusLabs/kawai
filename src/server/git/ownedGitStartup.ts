/**
 * Per-operation anchor bootstrap, dormant S2 of delivery-outcome-metrics.
 * Git's environment is separate RUN data; this module never receives it.
 * The owner disposes before spawn or after JOIN, including retained failures.
 */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function prepareAnchorStartup(): {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  dispose(): void;
} {
  const temporaryDirectory = realpathSync(tmpdir());
  let ancestor = temporaryDirectory;
  for (;;) {
    if (lstatSync(join(ancestor, '.git'), { throwIfNoEntry: false })) {
      throw new Error('Anchor temporary directory must be outside Git worktrees');
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const anchor = resolve(import.meta.dir, 'gitCommandAnchor.ts');
  let disposed = false;
  let identity: { dev: bigint; ino: bigint } | undefined;
  const root = mkdtempSync(join(temporaryDirectory, 'kawai-owned-git-'));
  const startup = {
    argv: [] as string[],
    env: {} as Record<string, string>,
    cwd: root,
    dispose(): void {
      if (disposed) return;
      const current = lstatSync(root, { bigint: true, throwIfNoEntry: false });
      if (current) {
        if (!current.isDirectory() || current.isSymbolicLink()
          || !identity || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new Error('Cannot dispose an unverified anchor root');
        }
        rmSync(root, { recursive: true, force: false });
      }
      // A failed removal leaves the same closure and custody available.
      disposed = true;
    },
  };

  try {
    const current = lstatSync(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error('Anchor root must be a nonlink directory');
    }
    identity = { dev: current.dev, ino: current.ino };
    chmodSync(root, 0o700);

    const home = join(root, 'home');
    const config = join(root, 'config');
    const cache = join(root, 'cache');
    const data = join(root, 'data');
    const state = join(root, 'state');
    const runtime = join(root, 'runtime');
    const temporary = join(root, 'tmp');
    for (const directory of [home, config, cache, data, state, runtime, temporary]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }

    const bunfig = join(root, 'bunfig.toml');
    const tsconfig = join(root, 'tsconfig.json');
    for (const [path, contents] of [
      [bunfig, 'preload = []\nenv = false\n[install]\nauto = "disable"\n'],
      [tsconfig, '{}\n'],
    ] as const) {
      writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
      chmodSync(path, 0o600);
    }

    startup.argv.push(
      process.execPath,
      '--no-env-file',
      '--no-install',
      `--config=${bunfig}`,
      `--tsconfig-override=${tsconfig}`,
      anchor,
    );
    Object.assign(startup.env, {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      XDG_RUNTIME_DIR: runtime,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    });
    return startup;
  } catch (setupError) {
    try {
      startup.dispose();
    } catch (disposalError) {
      const failure = new AggregateError(
        [setupError, disposalError],
        'Anchor bootstrap and root disposal failed',
        { cause: setupError },
      );
      Object.defineProperty(failure, 'startup', {
        value: startup,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      throw failure;
    }
    throw setupError;
  }
}

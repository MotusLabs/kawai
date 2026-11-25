// @exercises: src/server/routes/credentials.ts, src/server/chat/credential*.ts, src/server/chat/secretNameRegistry.ts, src/shared/credentials.ts
// The credential surface through the REAL bootstrap (provider-credential-store
// PW1, U7, PW4): `bun src/server/index.ts` starts on a spare port with a
// disposable HOME, database, log file, and private tmux server — never the
// live data directory (I4). PW4 starts it on a disposable copy of a database
// seeded with a legacy Settings map, then restarts it. Mutants it kills:
// bootstrap mounts the old provider-env routes (U7 answers 200) or not the
// credential routes (PW1); bootstrap never runs the startup migration (PW4).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import type { CredentialListing, CredentialMutationOutcome } from '../../shared/credentials'
import { initDatabase } from '../db'
import { canBindLocalhost, createTmuxTmpDir, isTmuxAvailable } from './testEnvironment'

const host = '127.0.0.1'
const SENTINEL = 'zqxjkvw-boot-sentinel'
const SEED_SENTINEL = 'zqxjkvw-boot-seed'
const MAP_SENTINEL = 'zqxjkvw-boot-map'

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ port: 0, host }, () => {
      const address = server.address()
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

function drain(stream: ReadableStream<Uint8Array> | number | null | undefined, into: string[]): void {
  if (!stream || typeof stream === 'number') return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      into.push(decoder.decode(value))
    }
  })()
}

/** A server on disposable state; `stop` ends it and its private tmux server. */
async function startServer(root: string) {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const tmuxTmpDir = createTmuxTmpDir()
  const session = `kawai-cred-boot-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const port = await freePort()
  const output: string[] = []
  const child = Bun.spawn(['bun', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      TMUX_SESSION: session,
      TMUX_TMPDIR: tmuxTmpDir,
      DISCOVER_PREFIXES: '',
      AGENTBOARD_LOG_POLL_MS: '0',
      AGENTBOARD_DB_PATH: path.join(root, 'data', 'agentboard.db'),
      AGENTBOARD_TMUX_PID_FILE: path.join(root, 'data', 'tmux-server.pid'),
      LOG_FILE: path.join(root, 'data', 'agentboard.log'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      CODEX_HOME: path.join(root, 'codex-home'),
      AGENTBOARD_CHAT_ENV: `PCS_BOOT_SEED=${SEED_SENTINEL}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  drain(child.stdout, output)
  drain(child.stderr, output)
  const base = `http://${host}:${port}`
  const started = Date.now()
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch { /* not up yet */ }
    if (Date.now() - started > 60_000) throw new Error(`server did not start:\n${output.join('').slice(-2000)}`)
    await Bun.sleep(150)
  }
  const stop = async () => {
    child.kill()
    await child.exited
    Bun.spawnSync(['tmux', 'kill-server'], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } })
    fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
  }
  return { base, home, output, stop }
}

const runnable = isTmuxAvailable() && canBindLocalhost()

if (!runnable) {
  test.skip('tmux or localhost sockets unavailable - skipping the bootstrap credential test', () => {})
} else {
  describe('the credential surface through the real bootstrap', () => {
    let root: string
    let server: Awaited<ReturnType<typeof startServer>>

    beforeAll(async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-boot-')))
      server = await startServer(root)
    }, 90_000)

    afterAll(async () => {
      await server?.stop()
      fs.rmSync(root, { recursive: true, force: true })
    })

    // @covers: provider-credentials › Imported credentials live in the server-owned store › Import writes only the store
    test('PW1: a PUT through the served app writes the 0600 store under HOME and the listing returns metadata only', async () => {
      const put = await fetch(`${server.base}/api/settings/credentials/PCS_BOOT_TOKEN`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: SENTINEL, kind: 'secret-source' }),
      })
      const putText = await put.text()
      expect(put.status).toBe(200)
      expect(putText).not.toContain(SENTINEL)
      expect((JSON.parse(putText) as CredentialMutationOutcome)).toMatchObject({ applied: true, durable: true })
      const file = path.join(server.home, '.kawai', 'credentials.json')
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(file, 'utf8')).toContain(SENTINEL)

      const listText = await (await fetch(`${server.base}/api/settings/credentials`)).text()
      expect(listText).not.toContain(SENTINEL)
      expect(listText).not.toContain(SEED_SENTINEL)
      const rows = (JSON.parse(listText) as CredentialListing).rows
      expect(rows).toContainEqual({ name: 'PCS_BOOT_TOKEN', kind: 'secret-source', state: 'set', source: 'store', overriding: false, collision: false })
      expect(rows).toContainEqual({ name: 'PCS_BOOT_SEED', kind: null, state: 'set', source: 'seed', overriding: false, collision: false })

      // The value reached neither the database nor the server's log (I1).
      const copy = path.join(root, 'inspect.db')
      fs.copyFileSync(path.join(root, 'data', 'agentboard.db'), copy)
      const db = new Database(copy, { readonly: true })
      try {
        const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
        for (const { name } of tables) expect(JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).not.toContain(SENTINEL)
        const registered = db.query("SELECT value FROM app_settings WHERE key = 'registered_secret_names'").get() as { value: string } | null
        expect(registered?.value).toContain('PCS_BOOT_TOKEN')
      } finally {
        db.close()
      }
      const log = fs.existsSync(path.join(root, 'data', 'agentboard.log')) ? fs.readFileSync(path.join(root, 'data', 'agentboard.log'), 'utf8') : ''
      expect(log + server.output.join('')).not.toContain(SENTINEL)
    })

    test('U7: the retired /api/settings/chat-provider-env answers 404 on the served app', async () => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await fetch(`${server.base}/api/settings/chat-provider-env`, {
          method, ...(method === 'PUT' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: { PCS: 'x' } }) } : {}),
        })
        expect({ method, status: response.status }).toEqual({ method, status: 404 })
      }
    })
  })
}

/** A disposable copy of a database seeded with a legacy Settings map (PW4). */
function seededDatabaseCopy(root: string, map: Record<string, string>): void {
  const seed = path.join(root, 'seed.db')
  const db = initDatabase({ path: seed })
  db.setAppSetting('chat_provider_env', JSON.stringify(map))
  db.close()
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.copyFileSync(seed, path.join(root, 'data', 'agentboard.db'))
}

/** The migration's rows and every row's text, read from a copy of the server's database. */
function settingsOf(root: string): { rows: { key: string; value: string }[]; all: string } {
  const copy = path.join(root, `inspect-${Date.now()}.db`)
  fs.copyFileSync(path.join(root, 'data', 'agentboard.db'), copy)
  const db = new Database(copy, { readonly: true })
  try {
    const rows = db.query('SELECT key, value FROM app_settings ORDER BY key').all() as { key: string; value: string }[]
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    const all = tables.map(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).join('\n')
    return { rows, all }
  } finally {
    db.close()
    fs.rmSync(copy, { force: true })
  }
}

const migrationRows = (root: string) => settingsOf(root).rows.filter(row => row.key === 'chat_provider_env' || row.key === 'credential_store_migration')

/** The listing once this start's migration settled (it runs after the server answers health). */
async function listing(base: string): Promise<CredentialListing> {
  const started = Date.now()
  for (;;) {
    const body = await (await fetch(`${base}/api/settings/credentials`)).json() as CredentialListing
    if (body.migration.text !== 'The legacy Settings migration is running.') return body
    if (Date.now() - started > 30_000) throw new Error('the startup migration did not settle')
    await Bun.sleep(100)
  }
}

if (runnable) {
  describe('PW4 — the startup migration through the real bootstrap on a disposable database copy', () => {
    let root: string
    const servers: Awaited<ReturnType<typeof startServer>>[] = []

    beforeAll(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-pw4-')))
    })

    afterAll(async () => {
      for (const server of servers.splice(0)) await server.stop()
      fs.rmSync(root, { recursive: true, force: true })
    })

    async function boot(): Promise<Awaited<ReturnType<typeof startServer>>> {
      const server = await startServer(root)
      servers.push(server)
      return server
    }

    async function stop(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
      servers.splice(servers.indexOf(server), 1)
      await server.stop()
    }

    // @covers: provider-credentials › Legacy Settings credentials migrate to the store at upgrade › Migration moves the map once
    test('PW4: the seeded map moves into the store at startup, the map row is gone with the stamp set, and a restart writes nothing', async () => {
      seededDatabaseCopy(root, { PCS_MAP_ROUTE: MAP_SENTINEL, pcs_map_lower: `${MAP_SENTINEL}-lower` })
      const first = await boot()
      const file = path.join(first.home, '.kawai', 'credentials.json')
      expect((await listing(first.base)).migration).toEqual({ state: 'complete', text: null, skipped: [], ignored: [] })
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, { kind: string; value: string }> }
      expect(stored.entries).toEqual({
        PCS_MAP_ROUTE: { kind: 'launch-env', value: MAP_SENTINEL },
        pcs_map_lower: { kind: 'launch-env', value: `${MAP_SENTINEL}-lower` },
      })
      expect(migrationRows(root)).toEqual([{ key: 'credential_store_migration', value: JSON.stringify({ version: 1, skipped: [] }) }])
      expect(settingsOf(root).all).not.toContain(MAP_SENTINEL)
      const listText = await (await fetch(`${first.base}/api/settings/credentials`)).text()
      expect(listText).not.toContain(MAP_SENTINEL)
      expect((JSON.parse(listText) as CredentialListing).rows).toContainEqual({ name: 'PCS_MAP_ROUTE', kind: 'launch-env', state: 'set', source: 'store', overriding: false, collision: false })
      await stop(first)
      const log = fs.existsSync(path.join(root, 'data', 'agentboard.log')) ? fs.readFileSync(path.join(root, 'data', 'agentboard.log'), 'utf8') : ''
      expect(log + first.output.join('')).not.toContain(MAP_SENTINEL)

      // PM2 through the real restart: no store byte and no migration row changes.
      const before = { bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs, rows: migrationRows(root) }
      const second = await boot()
      expect((await listing(second.base)).migration).toEqual({ state: 'complete', text: null, skipped: [], ignored: [] })
      await stop(second)
      expect({ bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs, rows: migrationRows(root) }).toEqual(before)
    }, 240_000)

    test('PW4 (M10): an unusable store keeps the map and no stamp through the real bootstrap; once repaired, the next start commits', async () => {
      fs.rmSync(root, { recursive: true, force: true })
      fs.mkdirSync(root, { recursive: true })
      seededDatabaseCopy(root, { PCS_MAP_RETRY: MAP_SENTINEL })
      const kawai = path.join(root, 'home', '.kawai')
      fs.mkdirSync(kawai, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(kawai, 'credentials.json'), '{ not json', { mode: 0o600 })
      const first = await boot()
      const pending = await listing(first.base)
      expect(pending.store).toMatchObject({ ok: false, reason: 'malformed' })
      expect(pending.migration).toEqual({ state: 'pending', text: 'The legacy Settings migration is pending until the credential store can be read. It retries at the next start.', skipped: [], ignored: [] })
      await stop(first)
      expect(fs.readFileSync(path.join(kawai, 'credentials.json'), 'utf8')).toBe('{ not json')
      expect(migrationRows(root)).toEqual([{ key: 'chat_provider_env', value: JSON.stringify({ PCS_MAP_RETRY: MAP_SENTINEL }) }])

      // The operator removes the malformed file; the next start retries and commits.
      fs.rmSync(path.join(kawai, 'credentials.json'))
      const second = await boot()
      expect((await listing(second.base)).migration).toEqual({ state: 'complete', text: null, skipped: [], ignored: [] })
      await stop(second)
      expect(JSON.parse(fs.readFileSync(path.join(kawai, 'credentials.json'), 'utf8')).entries).toEqual({ PCS_MAP_RETRY: { kind: 'launch-env', value: MAP_SENTINEL } })
      expect(migrationRows(root)).toEqual([{ key: 'credential_store_migration', value: JSON.stringify({ version: 1, skipped: [] }) }])
    }, 240_000)
  })
}

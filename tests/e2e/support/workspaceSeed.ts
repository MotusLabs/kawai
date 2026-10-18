// Seeding helpers for the team-workspace walkthroughs: rows the SDK-free
// fixture agents cannot produce (mail with a priority, uncertain deliveries)
// are written with the server's own MailboxStore into the isolated database.
import { execFileSync } from 'node:child_process'

function isolatedDb(): string {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  if (!dbPath.startsWith(process.env.E2E_TMUX_TMPDIR!)) throw new Error('Refuse seeding a non-isolated database')
  return dbPath
}

export interface SeedMail {
  /** The repository root; the team id is its git common dir. */
  root: string
  fromSession: string
  fromGroup: string
  body: string
  toKind: 'session' | 'group'
  toId: string
  priority?: 'normal' | 'urgent'
  /** Walk the row to an uncertain delivery held for the human. */
  uncertainFor?: string
}

/** Enqueue one message into the isolated database; returns its id. */
export function seedMail(mail: SeedMail): string {
  return execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { MailboxStore } from './src/server/team/mailboxStore';
    const [file, mail] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000');
    const store = new MailboxStore(db);
    // One immediate transaction: the live e2e server polls this database, so
    // step-by-step autocommit would let it observe or claim a half-seeded row.
    const id = db.transaction(() => {
      const row = store.enqueue({ teamId: mail.root + '/.git', fromSession: mail.fromSession, fromGroup: mail.fromGroup,
        originPath: mail.root, body: mail.body, toKind: mail.toKind, toId: mail.toId, tags: [],
        ...(mail.priority ? { priority: mail.priority } : {}) });
      if (mail.uncertainFor) {
        store.claim(row.id, mail.uncertainFor); store.markPushed(row.id);
        store.holdUncertain(row.id, 'transcript-unavailable-or-torn');
      }
      return row.id;
    }).immediate();
    console.log(id); db.close();
  `], { cwd: process.cwd(), input: JSON.stringify([isolatedDb(), mail]), encoding: 'utf8' }).trim()
}

/** Discard an uncertain delivery as the human would from the Mailbox. */
export function discardMail(id: string): void {
  execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { MailboxStore } from './src/server/team/mailboxStore';
    const [file, id] = JSON.parse(await Bun.stdin.text());
    const db = new Database(file); db.exec('PRAGMA busy_timeout = 5000');
    // Same atomicity as seedMail: the discard and its event row commit together.
    db.transaction(() => {
      if (!new MailboxStore(db).discard(id, { kind: 'human' }, 'e2e')) throw new Error('discard refused');
    }).immediate();
    db.close();
  `], { cwd: process.cwd(), input: JSON.stringify([isolatedDb(), id]), encoding: 'utf8' })
}

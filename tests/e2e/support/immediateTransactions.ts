// Seed scripts write the database the live server is writing too. The
// database runs a rollback journal, where a deferred transaction that read
// first and then writes is refused SQLITE_BUSY at once — never waiting out
// busy_timeout — whenever the server is mid-commit (SQLite's deadlock
// avoidance). This snippet, spliced into a `bun -e` script after its
// busy_timeout pragma, makes every `db.transaction` on that connection begin
// IMMEDIATE, so a script's writes wait for the lock instead (nested calls
// still become savepoints).

/** JS source that turns `<db>.transaction` into BEGIN IMMEDIATE transactions. */
export function immediateTransactions(db: string): string {
  return `{ const begin = ${db}.transaction.bind(${db}); ${db}.transaction = fn => { const tx = begin(fn); return Object.assign((...args) => tx.immediate(...args), tx) } }`
}

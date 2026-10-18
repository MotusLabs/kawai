// Version comparison shared by the Claude and Codex executable gates. Its
// own module so a test mocking one executable module (a partial mock never
// carries the other's exports) cannot break the other gate's import.
/** Numeric triple comparison: negative when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1
    if (pa[i]! > pb[i]!) return 1
  }
  return 0
}

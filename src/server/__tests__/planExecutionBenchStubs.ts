// The manager bench's stub executables (plan-execution rev 5): `gh` answers
// exactly what the composed path asks — the probe's auth, repository, and
// tree reads, the round's PR and green CI — and anything else fails loudly;
// `openspec` answers the validation adapter's probe, strict validation,
// and delta reads with a valid, delta-free change.

/** The stub gh; `treeFile` mirrors origin's base tree for the changes-on-base check. */
export function benchGhStub(treeFile: string): string {
  const run = (name: string) => `{"name":"${name}","status":"completed","conclusion":"success","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:01Z"}`
  return `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *check-runs*) printf '%s' '[{"check_runs":[${run('ci')},${run('e2e')}]}]' ;;
  *"/status"*) printf '%s' '{"statuses":[]}' ;;
  *"git/trees/"*) cat "${treeFile}" ;;
  *"git/commits/"*) printf '%s' '{"tree":{"sha":"ttt-0000"}}' ;;
  *"pr create"*) printf '%s' '{"number":7,"url":"https://example.internal/pr/7"}' ;;
  *"pr list"*) printf '%s' '[]' ;;
  *"repos/acme/app"*) printf '%s' '{"default_branch":"master","permissions":{"push":true}}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`
}

/** The stub openspec: version 1.14.2, every change valid, no deltas. */
export function benchOpenspecStub(): string {
  return `#!/bin/sh
case "$1" in
  --version) echo "1.14.2" ;;
  validate) printf '{"items":[{"id":"%s","type":"change","valid":true,"issues":[]}],"summary":{}}' "$2" ;;
  show) printf '{"deltas":[]}' ;;
  *) printf 'unknown command'; exit 2 ;;
esac
`
}

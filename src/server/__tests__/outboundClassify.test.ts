// The outbound classifier (execution-safety-recovery D4) over a corpus of
// the spike's command shapes, rewritten with reserved example names: every
// rule's send and non-send forms, targets resolved by position and flag,
// values never targets, variable-pinned targets unknown, and the strongest
// verdict with the full match list for compound commands.
import { describe, expect, test } from 'bun:test'
import {
  CLASSIFIER_VERSION,
  judge,
  mcpCallCandidate,
  parseGitUrl,
  strongest,
} from '../outbound/classify'
import { parseCommand } from '../outbound/parse'
import { parseSends } from '../outbound/rules'
import { facts, judged, verdictOf } from './outboundClassifyFacts'
import { redact } from '../outbound/redact'

describe('parseGitUrl', () => {
  test('https, ssh, and scp forms normalize to one host and owner/repo', () => {
    expect(parseGitUrl('https://github.com/acme/kawai.git')).toEqual({ host: 'github.com', repo: 'acme/kawai' })
    expect(parseGitUrl('https://git.example.internal:8443/team/kawai.git')).toEqual({ host: 'git.example.internal', repo: 'team/kawai', port: 8443 })
    expect(parseGitUrl('ssh://git@github.com/acme/kawai')).toEqual({ host: 'github.com', repo: 'acme/kawai' })
    expect(parseGitUrl('git@github.com:acme/kawai.git')).toEqual({ host: 'github.com', repo: 'acme/kawai' })
    // A one-component path names no owner/repo; the host alone judges it.
    expect(parseGitUrl('https://git.example.internal/kawai.git')).toEqual({ host: 'git.example.internal', repo: null })
    expect(parseGitUrl('example.internal')).toBeNull()
  })
})

describe('git-push', () => {
  test('a plain push resolves through origin and is allowed', () => {
    expect(verdictOf('git push')).toEqual({ rule: 'git-push', verdict: 'allowed', destination: 'github:origin' })
    expect(verdictOf('git push origin main')).toEqual({ rule: 'git-push', verdict: 'allowed', destination: 'github:origin' })
    expect(verdictOf('git push origin HEAD:refs/heads/main')).toEqual({ rule: 'git-push', verdict: 'allowed', destination: 'github:origin' })
    expect(verdictOf('git push --force origin')).toEqual({ rule: 'git-push', verdict: 'allowed', destination: 'github:origin' })
  })

  test('a named remote, a URL, an scp target, and --repo each name their destination', () => {
    expect(verdictOf('git push fork main')).toEqual({ rule: 'git-push', verdict: 'violation', destination: 'github:other/fork' })
    expect(verdictOf('git push https://github.com/other/repo.git')).toEqual({ rule: 'git-push', verdict: 'violation', destination: 'github:other/repo' })
    expect(verdictOf('git push git@github.com:other/repo.git')).toEqual({ rule: 'git-push', verdict: 'violation', destination: 'github:other/repo' })
    expect(verdictOf('git push --repo=https://git.example.internal/kawai.git')).toEqual({ rule: 'git-push', verdict: 'allowed', destination: 'internal:git.example.internal' })
    expect(verdictOf('git push --repo fork')).toEqual({ rule: 'git-push', verdict: 'violation', destination: 'github:other/fork' })
    // An internal mirror remote is an internal destination.
    expect(verdictOf('git push mirror')).toEqual({ rule: 'git-push', verdict: 'allowed', destination: 'internal:git.example.internal' })
  })

  test('reads are not sends: git status, git pull, git clone, git fetch', () => {
    for (const command of ['git status', 'git pull', 'git pull origin main', 'git clone https://github.com/other/repo.git', 'git fetch --all']) {
      expect(parseSends(command, '/repo')).toEqual([])
    }
  })

  test('a variable target and an unknown remote read unknown, never allowed', () => {
    expect(verdictOf('git push "$REMOTE" main')).toEqual({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:the target is a variable or command substitution',
    })
    expect(verdictOf('git push $(remote-name)')).toEqual({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:the target is a variable or command substitution',
    })
    expect(verdictOf('git push upstream main')).toEqual({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:remote upstream is not configured',
    })
  })

  test('no repository at the cwd, a failed read, and GIT_DIR each read unknown', () => {
    expect(verdictOf('git push', '/plain/dir')).toEqual({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:no repository at the cwd',
    })
    expect(verdictOf('GIT_DIR=/x/.git git push')).toEqual({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:GIT_DIR is set',
    })
    const unreadable = { ...facts, repos: new Map([['/repo', { root: '/repo', originUrls: [], remotes: new Map(), pushRemote: null, unreadable: true }]]) }
    const candidate = parseSends('git push', '/repo')[0]!
    expect(judge(candidate, unreadable).destination).toBe('unresolved:the facts read failed')
  })
})

describe('gh-write and gh-api-write', () => {
  test('origin-implicit writes are allowed; reads are not sends', () => {
    expect(verdictOf('gh pr create --title x')).toEqual({ rule: 'gh-write', verdict: 'allowed', destination: 'github:origin' })
    expect(verdictOf('gh issue comment 62 --body "see https://github.com/other/repo"')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
    for (const command of ['gh pr list', 'gh issue view 3', 'gh run watch 41', 'gh repo view', 'gh api repos/acme/kawai']) {
      expect(parseSends(command, '/repo')).toEqual([])
    }
  })

  test('-R, a URL -R, and a github.com positional name their repository', () => {
    expect(verdictOf('gh issue create -R other/repo --title x')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'github:other/repo',
    })
    expect(verdictOf('gh pr comment -R https://github.com/other/repo 62 --body hi')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'github:other/repo',
    })
    expect(verdictOf('gh repo rename github.com/other/repo --yes')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'github:other/repo',
    })
    expect(verdictOf('gh release create v1 -R acme/kawai')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
  })

  test('body, body-file, title, and heredoc values are never targets', () => {
    expect(verdictOf('gh pr comment 62 --body "repo: other/repo"')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
    expect(verdictOf('gh pr comment 62 --body-file /tmp/notes.md')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
    expect(verdictOf('gh pr create --title "github.com/other/repo"')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
    expect(verdictOf('gh pr comment 62 --body-file - <<NOTES\nsee github.com/other/repo\nNOTES')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
  })

  test('GH_REPO and GH_HOST pin the target unknown: prefix, env, and earlier segment', () => {
    for (const command of [
      'GH_REPO=other/repo gh pr create --title x',
      'env GH_REPO=other/repo gh pr create --title x',
      'export GH_REPO=other/repo; gh pr create --title x',
      'GH_REPO=; gh pr create --title x',
    ]) {
      expect(verdictOf(command)).toEqual({
        rule: 'gh-write', verdict: 'unknown-destination', destination: 'unresolved:GH_REPO is set',
      })
    }
    expect(verdictOf('export GH_HOST=example.com; gh issue create --title x')).toEqual({
      rule: 'gh-write', verdict: 'unknown-destination', destination: 'unresolved:GH_HOST is set',
    })
    // The pin dies with the segment that set it.
    expect(verdictOf('GH_REPO=other/repo true; gh pr create --title x')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
  })

  test('gh api: methods, fields, and the repository path', () => {
    expect(verdictOf('gh api -X POST repos/acme/kawai/issues -f title=x')).toEqual({
      rule: 'gh-api-write', verdict: 'allowed', destination: 'github:origin',
    })
    expect(verdictOf('gh api repos/acme/kawai/issues -F body=@file.md')).toEqual({
      rule: 'gh-api-write', verdict: 'allowed', destination: 'github:origin',
    })
    expect(verdictOf('gh api -X POST repos/other/repo/issues')).toEqual({
      rule: 'gh-api-write', verdict: 'violation', destination: 'github:other/repo',
    })
    expect(verdictOf('gh api -X PUT repos/{owner}/{repo}/labels -f name=x')).toEqual({
      rule: 'gh-api-write', verdict: 'allowed', destination: 'github:origin',
    })
    expect(verdictOf('gh api graphql -f query="{viewer{login}}"')).toEqual({
      rule: 'gh-api-write', verdict: 'unknown-destination', destination: 'unresolved:the API path names no repository',
    })
    expect(verdictOf('GH_REPO=other/repo gh api -X POST repos/acme/kawai/issues')).toEqual({
      rule: 'gh-api-write', verdict: 'unknown-destination', destination: 'unresolved:GH_REPO is set',
    })
  })
})

describe('registry-publish', () => {
  test('npm, twine, cargo, docker, podman, helm, buildctl, and buildx', () => {
    expect(verdictOf('npm publish')).toEqual({ rule: 'registry-publish', verdict: 'violation', destination: 'registry:registry.npmjs.org' })
    expect(verdictOf('npm publish --registry https://npm.example.internal')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:npm.example.internal',
    })
    expect(verdictOf('yarn publish')).toEqual({ rule: 'registry-publish', verdict: 'violation', destination: 'registry:registry.yarnpkg.com' })
    expect(verdictOf('twine upload dist/*')).toEqual({ rule: 'registry-publish', verdict: 'violation', destination: 'registry:pypi.org' })
    expect(verdictOf('twine upload --repository-url https://pypi.example.internal dist/*')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:pypi.example.internal',
    })
    expect(verdictOf('twine upload -r internal-name dist/*')).toEqual({
      rule: 'registry-publish', verdict: 'unknown-destination', destination: 'unresolved:the twine repository is a name, not a URL',
    })
    expect(verdictOf('cargo publish')).toEqual({ rule: 'registry-publish', verdict: 'violation', destination: 'registry:crates.io' })
    expect(verdictOf('cargo publish --registry example-registry')).toEqual({
      rule: 'registry-publish', verdict: 'violation', destination: 'registry:example-registry',
    })
    expect(verdictOf('docker push registry.example.internal/team/app:2')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
    expect(verdictOf('docker push team/app:2')).toEqual({ rule: 'registry-publish', verdict: 'violation', destination: 'registry:docker.io' })
    expect(verdictOf('podman push team/app')).toEqual({ rule: 'registry-publish', verdict: 'violation', destination: 'registry:docker.io' })
    expect(verdictOf('docker buildx build --push -t registry.example.internal/team/app .')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
    expect(verdictOf('buildctl build --output type=image,name=registry.example.internal/team/app,push=true')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
    expect(verdictOf('helm push chart.tgz https://charts.example.internal')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:charts.example.internal',
    })
  })

  test('installs and builds are not sends', () => {
    for (const command of ['npm install', 'npm ci', 'npm run build', 'docker build -t team/app .', 'docker pull team/app', 'cargo build']) {
      expect(parseSends(command, '/repo')).toEqual([])
    }
  })
})

describe('http-send and mail-send', () => {
  test('bodies and non-GET methods send; plain GETs and HEADs do not', () => {
    expect(verdictOf('curl -d x https://example.internal/api')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('curl -X POST https://example.internal/api')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf("curl --request PUT --json '{\"a\":1}' https://llm.example.com/v1/x")).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'model-provider:llm.example.com',
    })
    expect(verdictOf('curl -T file.tar https://host.example.org/upload')).toEqual({
      rule: 'http-send', verdict: 'violation', destination: 'host:host.example.org',
    })
    expect(verdictOf('wget --post-data=x https://example.internal/hook')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('wget --method=DELETE https://example.internal/r/1')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('http DELETE example.internal/x')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('https example.internal/api name=value')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    for (const command of [
      'curl https://example.internal/api',
      'curl -I https://example.internal',
      'curl -G -d q=x https://example.internal/search',
      'wget https://example.internal/file',
      'http example.internal/x',
      'http GET example.internal/x',
    ]) {
      expect(parseSends(command, '/repo')).toEqual([])
    }
  })

  test('mail in every listed shape', () => {
    for (const command of [
      'sendmail to@example.com',
      'msmtp to@example.com',
      'mailx -s hi to@example.com',
      'ssmtp to@example.com',
      'mail -s "report" to@example.com',
      'python -m smtpd -n -c DebuggingServer localhost:1025',
      'curl smtp://mail.example.internal --mail-from a@example.internal',
    ]) {
      expect(verdictOf(command)).toEqual({ rule: 'mail-send', verdict: 'violation', destination: 'mail' })
    }
  })

  test('variables and command substitution read unknown', () => {
    expect(verdictOf('curl -d @data.json "$TARGET"')).toEqual({
      rule: 'http-send', verdict: 'unknown-destination', destination: 'unresolved:the target is a variable or command substitution',
    })
    expect(verdictOf('curl -X POST $(endpoint)')).toEqual({
      rule: 'http-send', verdict: 'unknown-destination', destination: 'unresolved:the target is a variable or command substitution',
    })
  })
})

describe('mcp-call and the whole-command reduction', () => {
  test('an external MCP call is allowed only when its server is configured', () => {
    const allowed = judge(mcpCallCandidate('docs-search', '/repo', 'mcp__docs-search__search'), facts)
    expect(allowed).toMatchObject({ verdict: 'allowed', destination: 'mcp:docs-search' })
    const foreign = judge(mcpCallCandidate('web-lookup', '/repo', 'mcp__web-lookup__fetch'), facts)
    expect(foreign).toMatchObject({ verdict: 'violation', destination: 'mcp:web-lookup' })
  })

  test('a compound command keeps its strongest verdict and lists every match', () => {
    const matches = judged('git push && npm publish')
    expect(matches).toHaveLength(2)
    expect(matches.map(match => match.rule)).toEqual(['git-push', 'registry-publish'])
    const best = strongest(matches)!
    expect(best.rule).toBe('registry-publish')
    expect(best.verdict).toBe('violation')
    expect(best.destination).toBe('registry:registry.npmjs.org')
    // violation > unknown-destination > allowed, then rule order.
    const mixed = judged('git push "$REMOTE" main; curl https://example.internal/x; gh api graphql -f q=x')
    expect(strongest(mixed)!.destination).toBe('unresolved:the target is a variable or command substitution')
    // The plain GET sent nothing: only the push and the gh api call matched.
    expect(mixed.map(match => match.rule)).toEqual(['git-push', 'gh-api-write'])
    expect(CLASSIFIER_VERSION).toBe(2)
  })

  test('cd and git -C carry the effective cwd into the repository facts', () => {
    expect(verdictOf('cd /plain/dir && git push')).toEqual({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:no repository at the cwd',
    })
    expect(verdictOf('git -C /repo push')).toEqual({
      rule: 'git-push', verdict: 'allowed', destination: 'github:origin',
    })
    // A subshell tracks its own cwd; the parent keeps its own, and the
    // compound call keeps its strongest verdict (the subshell's unknown).
    const both = judged('bash -c "cd /plain/dir && git push"; git push')
    expect(both.map(match => match.destination)).toEqual([
      'unresolved:no repository at the cwd', 'github:origin',
    ])
    expect(strongest(both)!.destination).toBe('unresolved:no repository at the cwd')
  })
})

describe('CC checkpoint findings: curl targets, clusters, and unwrapping', () => {
  test('every URL argument is judged, scheme URLs preferred, values consumed (H2)', () => {
    // The write-out flag's value is not a URL; the second URL is judged too.
    expect(verdictOf('curl -w example.internal -d @f https://x.example.com')).toEqual({
      rule: 'http-send', verdict: 'violation', destination: 'host:x.example.com',
    })
    const both = judged('curl -d x https://hook.example.internal https://x.example.com')
    expect(both.map(match => match.destination)).toEqual(['internal:hook.example.internal', 'host:x.example.com'])
    expect(strongest(both)).toMatchObject({ verdict: 'violation', destination: 'host:x.example.com' })
    expect(verdictOf('curl -K config.cfg -D headers.txt -c jar.txt --resolve a.example.internal:443:192.0.2.1 -d x https://hook.example.internal')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:hook.example.internal',
    })
  })

  test('short flag clusters walk every letter (H3)', () => {
    expect(verdictOf('curl -sX POST https://example.internal/api')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('curl -sd x https://example.internal/api')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('curl -sfL https://example.internal/api')).toEqual(null)
  })

  test('a registry port splits from the host and pins the match (M4)', () => {
    expect(verdictOf('docker push registry.example.internal:5000/team/app:2')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
  })

  test('bash -lc unwraps; groups and subshells keep their cwd; brackets tokenize (M5)', () => {
    expect(verdictOf('bash -lc "curl -d x https://example.internal/hook"')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('(cd /repo && git push fork)')).toEqual({
      rule: 'git-push', verdict: 'violation', destination: 'github:other/fork',
    })
    // A subshell's cd never moves the parent's cwd.
    const both = judged('(cd /plain/dir && git push); git push')
    expect(both.map(match => match.cwd)).toEqual(['/plain/dir', '/repo'])
    // Wrapping prefixes fall away.
    expect(verdictOf('sudo curl -d x https://example.internal/hook')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('timeout 30 curl -d x https://example.internal/hook')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('nohup npm publish >/dev/null 2>&1')).toEqual({
      rule: 'registry-publish', verdict: 'violation', destination: 'registry:registry.npmjs.org',
    })
  })

  test('git configuration pins read unknown (M6)', () => {
    for (const command of [
      'git --git-dir=/x/.git push',
      'git -c remote.origin.url=https://github.com/other/r push',
      'git -c url.https://github.com/.insteadOf=https://example.internal/ push',
      'git --work-tree=/x --git-dir=/y/.git push',
    ]) {
      expect(verdictOf(command)).toMatchObject({
        rule: 'git-push', verdict: 'unknown-destination',
      })
    }
  })

  test('publish forms with flags before the subcommand (M9)', () => {
    expect(verdictOf('npm --registry https://npm.example.internal publish')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:npm.example.internal',
    })
    expect(verdictOf('pnpm -r publish')).toEqual({
      rule: 'registry-publish', verdict: 'violation', destination: 'registry:registry.npmjs.org',
    })
    expect(verdictOf('yarn npm publish')).toEqual({
      rule: 'registry-publish', verdict: 'violation', destination: 'registry:registry.yarnpkg.com',
    })
    expect(verdictOf('docker image push registry.example.internal/team/app')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
    expect(verdictOf('docker -H ssh://builder.example.internal push registry.example.internal/team/app')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
    expect(verdictOf('docker build --push -t registry.example.internal/team/app .')).toEqual({
      rule: 'registry-publish', verdict: 'allowed', destination: 'internal:registry.example.internal',
    })
  })

  test('low items: leading slash, case, httpie items, -G with a method (LOW)', () => {
    expect(verdictOf('gh api -X POST /repos/other/repo/issues')).toEqual({
      rule: 'gh-api-write', verdict: 'violation', destination: 'github:other/repo',
    })
    expect(verdictOf('gh issue create -R Acme/Kawai --title x')).toEqual({
      rule: 'gh-write', verdict: 'allowed', destination: 'github:origin',
    })
    // Header and query items are not bodies.
    expect(verdictOf('http example.internal/x Accept:application/json page==2')).toEqual(null)
    expect(verdictOf('http example.internal/x name=value')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
    expect(verdictOf('curl -G -X POST https://example.internal/api')).toEqual({
      rule: 'http-send', verdict: 'allowed', destination: 'internal:example.internal',
    })
  })

  test('repo creates, forks, and gists never fall back to origin (lead decision, D1)', () => {
    expect(verdictOf('gh repo create acme/new-repo --private')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'github:acme/new-repo',
    })
    expect(verdictOf('gh repo create new-repo')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: "github:the caller's account/new-repo",
    })
    expect(verdictOf('gh repo fork')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: "github:the caller's account/the source name",
    })
    expect(verdictOf('gh repo fork --clone=false')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: "github:the caller's account/the source name",
    })
    // The source's owner never carries over: only its name, as the fork's.
    expect(verdictOf('gh repo fork other/repo')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: "github:the caller's account/repo",
    })
    expect(verdictOf('gh gist create notes.md')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'host:gist.github.com',
    })
    expect(verdictOf('gh gist edit abc123 -f notes.md')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'host:gist.github.com',
    })
  })

  test('each repo.pinned check is load-bearing: all four target kinds (round 6 L2)', () => {
    const pinned = {
      ...facts,
      repos: new Map([['/repo', {
        root: '/repo',
        originUrls: ['https://github.com/acme/kawai.git'],
        remotes: new Map([
          ['origin', ['https://github.com/acme/kawai.git']],
          ['fork', ['https://github.com/other/fork.git']],
        ]),
        pushRemote: 'origin',
        pinned: 'an insteadOf rewrite could change this target',
      }]]),
    }
    expect(judge(parseSends('git push https://github.com/other/fork.git', '/repo')[0]!, pinned)).toMatchObject({
      verdict: 'unknown-destination', destination: 'unresolved:an insteadOf rewrite could change this target',
    })
    expect(judge(parseSends('git push', '/repo')[0]!, pinned)).toMatchObject({ verdict: 'unknown-destination' })
    expect(judge(parseSends('git push fork', '/repo')[0]!, pinned)).toMatchObject({ verdict: 'unknown-destination' })
    expect(judge(parseSends('gh pr create --title x', '/repo')[0]!, pinned)).toMatchObject({ verdict: 'unknown-destination' })
  })

  test('the tokenizer reads ANSI-C strings as one word with escapes (round 7 L-b)', () => {
    // Removing the ANSI-C branch retokenizes: the escaped quote ends the
    // single-quoted run early and the word splits, failing these pins.
    const segments = parseCommand("echo $'A\\'B' C", '/repo')
    expect(segments[0]!.argv).toEqual(["echo", "$'A\\'B'", 'C'])
    // A secret inside $'…' survives as one span, so redaction sees it whole.
    expect(redact("curl -H $'Authorization: Bearer S7X' https://example.internal")).not.toContain('S7X')
  })

  test('a push to a remote with several urls judges every one, strongest wins (CC round 4 C)', () => {
    const multiUrl = {
      ...facts,
      repos: new Map([['/repo', {
        root: '/repo',
        originUrls: ['https://github.com/acme/kawai.git'],
        remotes: new Map([
          ['origin', ['https://github.com/acme/kawai.git']],
          ['fork', ['https://git.example.internal/kawai.git', 'https://github.com/other/fork.git']],
        ]),
        pushRemote: 'origin',
      }]]),
    }
    const candidate = parseSends('git push fork main', '/repo')[0]!
    expect(judge(candidate, multiUrl)).toMatchObject({
      rule: 'git-push', verdict: 'violation', destination: 'github:other/fork',
    })
    // The internal mirror alone stays allowed.
    const forkOnly = {
      root: '/repo',
      originUrls: ['https://github.com/acme/kawai.git'],
      remotes: new Map([
        ['origin', ['https://github.com/acme/kawai.git']],
        ['fork', ['https://git.example.internal/kawai.git']],
      ]),
      pushRemote: 'origin',
    }
    const internalOnly = { ...facts, repos: new Map([['/repo', forkOnly]]) }
    expect(judge(parseSends('git push fork main', '/repo')[0]!, internalOnly)).toMatchObject({
      verdict: 'allowed', destination: 'internal:git.example.internal',
    })
  })
})

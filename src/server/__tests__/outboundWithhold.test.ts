// The withholding gate (execution-safety-recovery D8, task 3.6): each
// trigger answers its fixed reason code, ordinary commands pass to
// redaction untouched, and `storeText` is placeholder-or-redacted, never
// both. Reserved example names throughout.
import { describe, expect, test } from 'bun:test'
import { storeText, withheld, withholdReason } from '../outbound/withhold'

describe('withholdReason', () => {
  test('each trigger answers its reason code', () => {
    const cases: Array<[string, string]> = [
      ['curl -d @- https://example.internal <<EOF\nx\nEOF', 'heredoc'],
      ['gh secret set N <<< value', 'heredoc'],
      ['wget --header "X-A: b" https://example.internal', 'header'],
      ['curl -H "X-A: b" https://example.internal', 'header'],
      ['curl -sH X-A:b https://example.internal', 'header'],
      ['curl -HX-A:b https://example.internal', 'header'],
      ['http POST https://example.internal X-A:b', 'header'],
      ['curl -H "Authorization: Bearer x" https://example.internal', 'credential'],
      ['cargo publish --token x', 'credential'],
      ['tool --api-key x', 'credential'],
      ['curl -u user:x https://example.internal', 'credential'],
      ['mytool -u admin:x', 'credential'],
      // Generous on purpose (D8): any -u user:pass shape withholds, uid:gid too.
      ['docker run -u 1000:1000 img', 'credential'],
      ['curl -d x https://user:x@example.internal', 'credential'],
      ['docker login -p x registry.example.internal', 'credential'],
      ['echo ghp_abcdefghijklmnop', 'token'],
      ['echo glpat-abcdefghijkl', 'token'],
      ['echo AKIAABCDEFGHIJKLMNOP', 'token'],
    ]
    for (const [text, reason] of cases) expect({ text, reason: withholdReason(text) as string | null }).toEqual({ text, reason })
  })

  test('ordinary commands are not withheld', () => {
    for (const text of [
      'git push origin main', 'gh pr create --title "fix: parser" --body-file f', 'sort -u file.txt',
      'git add -u', 'curl -d x https://example.internal/hook', 'echo failed: exit 7', 'npm publish --registry https://npm.example.internal',
      'curl -d x https://registry.example.internal/@scope/pkg',
    ]) {
      expect({ text, reason: withholdReason(text) }).toEqual({ text, reason: null })
    }
  })
})

describe('storeText', () => {
  test('withheld text stores only the placeholder, untruncated', () => {
    expect(storeText('curl -H "X-A: b" https://example.internal')).toEqual({ text: withheld('header'), truncated: false })
    expect(storeText(`${'x '.repeat(5000)}<<EOF`)).toEqual({ text: '‹withheld: heredoc›', truncated: false })
  })

  test('other text is redacted and cut at the cap', () => {
    expect(storeText('git push origin main')).toEqual({ text: 'git push origin main', truncated: false })
    const long = storeText(`echo ${'word '.repeat(1000)}`, 1024)
    expect(long.truncated).toBe(true)
    expect(long.text.length).toBeLessThanOrEqual(1024)
    expect(long.text.endsWith('word')).toBe(true)
  })
})

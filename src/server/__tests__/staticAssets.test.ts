import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'
import { staticAssetsMiddleware } from '../staticAssets'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'kawai-static-'))
  roots.push(base)
  const root = join(base, 'assets', 'custom-static-root')
  mkdirSync(join(root, 'assets'), { recursive: true })
  const files = new Map<string, Buffer>([
    ['assets/index-abc123.js', Buffer.from('console.log("fixture — exact bytes")')],
    ['index.html', Buffer.from('<html>fixture — shell</html>')],
    ['sw.js', Buffer.from('/* service worker */')],
    ['manifest.webmanifest', Buffer.from('{"name":"fixture"}')],
    ['icon.png', Buffer.from([0, 1, 255, 3])],
    ['workbox-abc123.js', Buffer.from('/* root worker chunk */')],
  ])
  for (const [file, bytes] of files) {
    writeFileSync(join(root, file), bytes)
    if (file === 'assets/index-abc123.js' || file === 'index.html' || file === 'manifest.webmanifest') {
      writeFileSync(join(root, file + '.br'), brotliCompressSync(bytes))
      writeFileSync(join(root, file + '.gz'), gzipSync(bytes))
    }
  }
  const app = new Hono()
  app.use('/*', staticAssetsMiddleware(root))
  return { app, files }
}
// @covers: web-asset-delivery › Static assets are served compressed › A browser accepting brotli
// @covers: web-asset-delivery › Static assets are served compressed › A client accepting only gzip
// @covers: web-asset-delivery › Static assets are served compressed › A client accepting no encoding
// @covers: web-asset-delivery › Static assets are served compressed › An asset without a compressed copy
// @covers: web-asset-delivery › Content-hashed assets are cached as immutable › A hashed bundle
// @covers: web-asset-delivery › Content-hashed assets are cached as immutable › The app shell
// @covers: web-asset-delivery › Content-hashed assets are cached as immutable › An update changes only the shell's references
test('E1-E7: real static mount preserves source bytes, encoding, Vary and root-relative cache policy', async () => {
  const { app, files } = fixture()
  const immutable = 'public, max-age=31536000, immutable'
  const cases = [
    ['E1', '/assets/index-abc123.js', 'gzip, deflate, br', 'br', immutable],
    ['E2', '/assets/index-abc123.js', 'gzip', 'gzip', immutable],
    ['E3', '/assets/index-abc123.js', '', null, immutable],
    ['E4', '/', 'br', 'br', 'no-cache'],
    ['E5', '/sw.js', 'br', null, 'no-cache'],
    ['E6', '/icon.png', 'br', null, null],
    ['E7', '/assets/index-abc123.js', 'br;q=1', null, immutable],
  ] as const
  for (const [id, path, accepted, encoding, cache] of cases) {
    const response = await app.request(path, { headers: accepted ? { 'Accept-Encoding': accepted } : {} })
    expect(response.status, id).toBe(200)
    expect(response.headers.get('Content-Encoding'), id).toBe(encoding)
    expect(response.headers.get('Cache-Control'), id).toBe(cache)
    expect(response.headers.get('Vary'), id).toBe(encoding ? 'Accept-Encoding' : null)
    const bytes = Buffer.from(await response.arrayBuffer())
    const decoded = encoding === 'br' ? brotliDecompressSync(bytes) : encoding === 'gzip' ? gunzipSync(bytes) : bytes
    expect([...decoded], id).toEqual([...files.get(path === '/' ? 'index.html' : path.slice(1))!])
  }
})
test('static root containing assets does not make root workers immutable and missing files stay uncached', async () => {
  const { app } = fixture()
  const worker = await app.request('/workbox-abc123.js')
  expect(worker.status).toBe(200)
  expect(worker.headers.get('Cache-Control')).toBeNull()
  const manifest = await app.request('/manifest.webmanifest', { headers: { 'Accept-Encoding': 'br' } })
  expect(manifest.headers.get('Cache-Control')).toBe('no-cache')
  expect(manifest.headers.get('Content-Encoding')).toBe('br')
  const missing = await app.request('/assets/missing.js')
  expect(missing.status).toBe(404)
  expect(missing.headers.get('Cache-Control')).toBeNull()
})

// Serve build-time compressed siblings and classify cache headers relative to
// the configured static root, even when that root itself contains "assets".
import { relative, resolve, sep } from 'node:path'
import { serveStatic } from 'hono/bun'

export function staticAssetsMiddleware(root: string) {
  const resolvedRoot = resolve(root)
  return serveStatic({
    root: resolvedRoot,
    precompressed: true,
    onFound(found, context) {
      const asset = relative(resolvedRoot, resolve(found)).split(sep).join('/')
      if (asset.startsWith('assets/')) {
        context.header('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (['index.html', 'sw.js', 'manifest.webmanifest'].includes(asset)) {
        context.header('Cache-Control', 'no-cache')
      }
    },
  })
}

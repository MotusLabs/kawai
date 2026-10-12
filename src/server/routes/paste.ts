// Host clipboard paste routes under `/api`: `/paste-image` stores an
// uploaded image (iOS clipboard paste) under /tmp with a server-chosen
// extension, and `/clipboard-file-path` reads the macOS pasteboard directly
// (Finder file URLs via osascript, else an embedded Swift script) because
// browser paste events hide AppKit pasteboard types. Browser-supplied file
// uploads live in ./pasteFile.
import { Hono } from 'hono'
import { config } from '../config'

// Allowed paste-image types; the extension written to /tmp comes from this map,
// never from client-supplied values. Note Bun's multipart parser derives
// File.type from the part filename's extension, not the declared blob type.
const pasteImageExtensionByMime = new Map([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

const macPasteboardSwiftScript = `
import AppKit
import Foundation

let maxBytes = Int(ProcessInfo.processInfo.environment["AGENTBOARD_PASTE_IMAGE_MAX_BYTES"] ?? "") ?? 0
let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"]

func emit(path: String?, isImage: Bool) {
  let payload: [String: Any?] = ["path": path, "isImage": isImage]
  let data = try! JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 })
  print(String(data: data, encoding: .utf8)!)
}

let pasteboard = NSPasteboard.general
let items = pasteboard.pasteboardItems ?? []

for item in items {
  if let fileURLString = item.string(forType: .fileURL),
     let url = URL(string: fileURLString),
     url.isFileURL {
    let path = url.path
    let lowerExt = url.pathExtension.lowercased()
    let hasImageType = item.types.contains(.png) || item.types.contains(.tiff)
    emit(path: path, isImage: hasImageType || imageExtensions.contains(lowerExt))
    exit(0)
  }
}

for item in items {
  if let data = item.data(forType: .png), data.count > 0, (maxBytes <= 0 || data.count <= maxBytes) {
    let path = NSTemporaryDirectory() + "agentboard-paste-" + UUID().uuidString + ".png"
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    emit(path: path, isImage: true)
    exit(0)
  }
}

emit(path: nil, isImage: false)
`

const MAC_PASTEBOARD_TIMEOUT_MS = 10000

function isImageFilePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(filePath)
}

export function createPasteRoutes() {
  const routes = new Hono()

  // Image upload endpoint for iOS clipboard paste
  routes.post('/paste-image', async (c) => {
    // Early reject before buffering the multipart body. The header is
    // client-controlled, so image.size below remains the authoritative check.
    const contentLength = Number(c.req.header('content-length'))
    if (Number.isFinite(contentLength) && contentLength > config.pasteImageMaxBytes) {
      return c.json({ error: 'Image too large' }, 413)
    }

    try {
      const formData = await c.req.formData()
      const image = formData.get('image')
      if (!(image instanceof File)) {
        return c.json({ error: 'No image provided' }, 400)
      }
      if (image.size > config.pasteImageMaxBytes) {
        return c.json({ error: 'Image too large' }, 413)
      }
      const ext = pasteImageExtensionByMime.get(image.type)
      if (!ext) {
        return c.json({ error: 'Unsupported image type' }, 415)
      }

      // Generate unique filename in temp directory
      const filename = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const filepath = `/tmp/${filename}`
      await Bun.write(filepath, image)

      return c.json({ path: filepath })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Upload failed' },
        500
      )
    }
  })

  // Get file path from macOS clipboard (for Finder file copies and screenshot apps).
  // Browser paste events can hide AppKit pasteboard types such as public.file-url
  // and public.png, so this endpoint reads NSPasteboard directly.
  routes.get('/clipboard-file-path', async (c) => {
    if (process.platform !== 'darwin') {
      return c.json({ path: null, isImage: false })
    }
    try {
      // Finder file URLs do not need the Swift interpreter. Resolve them first
      // so cold Swift startup cannot delay ordinary document pastes.
      const fileProc = Bun.spawn(
        ['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'],
        { stdout: 'pipe', stderr: 'pipe', timeout: MAC_PASTEBOARD_TIMEOUT_MS }
      )
      const fileText = await new Response(fileProc.stdout).text()
      const fileExitCode = await fileProc.exited
      const filePath = fileText.trim()
      if (fileExitCode === 0 && filePath.startsWith('/')) {
        const file = Bun.file(filePath)
        if (await file.exists()) {
          c.header('Cache-Control', 'no-store')
          return c.json({ path: filePath, isImage: isImageFilePath(filePath) })
        }
      }

      const proc = Bun.spawn(
        ['swift', '-e', macPasteboardSwiftScript],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: MAC_PASTEBOARD_TIMEOUT_MS,
          env: {
            ...process.env,
            AGENTBOARD_PASTE_IMAGE_MAX_BYTES: String(config.pasteImageMaxBytes),
          },
        }
      )
      const text = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode === 0) {
        const payload = JSON.parse(text) as { path?: unknown; isImage?: unknown }
        const filePath = typeof payload.path === 'string' ? payload.path : null
        // Verify the file actually exists
        if (filePath?.startsWith('/')) {
          const file = Bun.file(filePath)
          if (await file.exists()) {
            c.header('Cache-Control', 'no-store')
            return c.json({ path: filePath, isImage: payload.isImage === true })
          }
        }
      }

      return c.json({ path: null, isImage: false })
    } catch {
      return c.json({ path: null, isImage: false })
    }
  })

  return routes
}

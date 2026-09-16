import { createLogger, defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import fs from 'node:fs'
import { shouldSuppressProxyLog } from './src/shared/devProxyErrors'

// Backend restarts and browser reloads tear down proxied sockets mid-write.
// Vite logs the resulting ECONNREFUSED/EPIPE/ECONNRESET as a stack trace even
// though it recovers on its own, so filter those lines out of the dev log.
function createDevLogger() {
  const logger = createLogger()
  const logError = logger.error.bind(logger)
  logger.error = (msg, options) => {
    if (shouldSuppressProxyLog(msg, options?.error)) return
    logError(msg, options)
  }
  return logger
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const allowedHosts = [
    '5173--main--kawai--shakirov-ruslan.dev.ruslan.casa',
    ...(env.VITE_ALLOWED_HOSTS
      ? env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim())
      : []),
  ]
  const backendPort = env.PORT || '4040'

  return {
    customLogger: createDevLogger(),
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Kawai',
          short_name: 'Kawai',
          description: 'Web GUI for tmux optimized for AI agent TUIs',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          icons: [
            {
              src: '/icons/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: '/icons/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: '/icons/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/ws(?:\/|$)/],
        },
      }),
    ],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    server: {
      allowedHosts,
      https: (() => {
        const homeDir = process.env.HOME
        if (!homeDir) {
          return undefined
        }
        const certFile = path.join(homeDir, '.agentboard', 'tls-cert.pem')
        const keyFile = path.join(homeDir, '.agentboard', 'tls-key.pem')
        if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
          try {
            return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
          } catch {
            // Fall back to HTTP when local certs are unreadable/invalid.
            return undefined
          }
        }
        return undefined
      })(),
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          // Preserve Vite string-shorthand behavior.
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://localhost:${backendPort}`,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
  }
})

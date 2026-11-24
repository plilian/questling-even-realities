/// <reference types="vitest/config" />
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev-only: mounts the stateless Questling API (server/app.ts) on the Vite dev
 * server so `npm run dev` serves client + API from one origin (no CORS in dev,
 * and the official simulator can load http://localhost:5173 directly).
 * Production uses `npm run build && npm start` (server/main.ts).
 */
function questlingApi(): Plugin {
  return {
    name: 'questling-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/') && !url.startsWith('/link') && url !== '/health') return next()
        try {
          const mod = (await server.ssrLoadModule('/server/app.ts')) as typeof import('./server/app')
          await mod.handle(req, res)
        } catch (err) {
          console.error('[questling-api] handler crashed:', (err as Error).message)
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
          }
          res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
        }
      })
    },
  }
}

export default defineConfig(({ isSsrBuild }) => ({
  base: './',
  plugins: [react(), questlingApi()],
  server: { host: true, port: 5173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0, sourcemap: false, copyPublicDir: !isSsrBuild, chunkSizeWarningLimit: 700 },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
}))

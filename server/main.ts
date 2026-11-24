import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { config } from './config'
import { getRuntime, handle } from './app'
import { messageProvidersConfigured, taskProvidersConfigured } from './tasks'

/**
 * Production entry: serves the built client (dist/) and the stateless API.
 * Put it behind an HTTPS reverse proxy (see docs/DEPLOYMENT.md).
 */
const cfg = config()
if (cfg.production && !cfg.accessCodes.length) {
  console.warn('[questling] NODE_ENV=production without ACCESS_CODES: AI and Calendar endpoints will refuse sessions.')
}

const DIST = resolve(process.cwd(), 'dist')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

async function serveStatic(pathname: string, res: import('node:http').ServerResponse) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, rel)
  if (!file.startsWith(DIST)) {
    res.statusCode = 403
    return res.end()
  }
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html')
  }
  try {
    const data = await readFile(file)
    res.statusCode = 200
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    res.setHeader('x-content-type-options', 'nosniff')
    if (file.includes(`${DIST}/assets/`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/api/') || url.startsWith('/link') || url === '/health') {
    void handle(req, res)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.end()
    return
  }
  void serveStatic(new URL(url, 'http://x').pathname, res)
})
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.listen(cfg.port, () => {
  // names only — never keys
  const rt = getRuntime()
  const ai = rt.providers.size ? `${[...rt.providers.keys()].join(', ')} (default ${rt.defaultAi})` : 'not configured'
  const tasks = Object.entries(taskProvidersConfigured(cfg))
    .filter(([, on]) => on)
    .map(([k]) => k)
  const inbox = Object.entries(messageProvidersConfigured(cfg))
    .filter(([, on]) => on)
    .map(([k]) => k)
  console.log(`[questling] listening on :${cfg.port} (AI ${ai}; Calendar ${cfg.googleClientId ? 'configured' : 'not configured'}; task lists ${tasks.length ? tasks.join(', ') : 'none'}; mail & chat ${inbox.length ? inbox.join(', ') : 'none'})`)
})

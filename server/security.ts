import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config'

/** All server state is bounded, in-memory and expires. Restart clears everything. */

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function securityHeaders(res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-frame-options', 'DENY')
}

/** CORS for an explicit allowlist. CORS is not authorization — every API route also requires an access token. */
export function applyCors(req: IncomingMessage, res: ServerResponse, cfg: ServerConfig): boolean {
  const origin = req.headers.origin
  if (origin && cfg.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-lq-session, x-lq-calendar, x-lq-tasks, x-lq-link')
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS')
    res.setHeader('access-control-max-age', '600')
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = origin && cfg.allowedOrigins.includes(origin) ? 204 : 403
    res.end()
    return true
  }
  return false
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? ''
  if (!type.includes('application/json')) throw new HttpError(415, 'json_required')
  const len = Number(req.headers['content-length'] ?? 0)
  if (len > maxBytes) throw new HttpError(413, 'payload_too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

/** Small urlencoded form body (the /link page's Telegram token form). */
export async function readForm(req: IncomingMessage, maxBytes: number): Promise<URLSearchParams> {
  const type = req.headers['content-type'] ?? ''
  if (!type.includes('application/x-www-form-urlencoded')) throw new HttpError(415, 'form_required')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large')
    chunks.push(chunk as Buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export function randomId(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// ---- short-lived access tokens (operator access code → signed token) ----
const ACCESS_TTL_MS = 12 * 3600_000

export function issueAccessToken(cfg: ServerConfig, now = Date.now()): { token: string; expiresAt: number; sid: string } {
  const sid = randomId(12)
  const expiresAt = now + ACCESS_TTL_MS
  const payload = `${sid}.${expiresAt}`
  const sig = createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url')
  return { token: `${payload}.${sig}`, expiresAt, sid }
}

export function verifyAccessToken(cfg: ServerConfig, token: string | undefined, now = Date.now()): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [sid, exp, sig] = parts as [string, string, string]
  const expected = createHmac('sha256', cfg.sessionSecret).update(`${sid}.${exp}`).digest('base64url')
  if (!safeEqual(sig, expected)) return null
  if (!/^\d+$/.test(exp) || Number(exp) < now) return null
  return sid
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return undefined
  return h.slice(7).trim()
}

// ---- rate limiting & budget ----
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private limit: number,
    private windowMs: number,
    private maxKeys = 5000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (arr.length >= this.limit) {
      this.hits.set(key, arr)
      return false
    }
    arr.push(now)
    this.hits.set(key, arr)
    if (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value
      if (first !== undefined) this.hits.delete(first)
    }
    return true
  }
}

export class DailyBudget {
  private day = ''
  private used = 0
  constructor(private limit: number) {}
  take(now = Date.now()): boolean {
    const d = new Date(now).toISOString().slice(0, 10)
    if (d !== this.day) {
      this.day = d
      this.used = 0
    }
    if (this.used >= this.limit) return false
    this.used++
    return true
  }
  remaining(now = Date.now()): number {
    const d = new Date(now).toISOString().slice(0, 10)
    return d === this.day ? Math.max(0, this.limit - this.used) : this.limit
  }
}

/** Redacted access log: method, route, status, duration. Never bodies, headers, tokens or query strings. */
export function logRequest(method: string, path: string, status: number, ms: number) {
  const route = path.split('?')[0]!.replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id')
  console.log(`[api] ${method} ${route} ${status} ${ms}ms`)
}

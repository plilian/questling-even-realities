import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Contract fake of the Google OAuth token/revoke endpoints and Calendar v3 events
 * endpoints used by Questling. Implements the behaviours the adapter relies on:
 * PKCE verification, client-supplied event IDs (409 on duplicate), etags + If-Match (412),
 * 401 for revoked tokens, field-less JSON.
 */
export interface FakeEvent {
  id: string
  summary: string
  status: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  etag: string
  extendedProperties?: { private?: Record<string, string> }
  attendees?: unknown[]
  description?: string
}

export class FakeGoogle {
  server!: Server
  base = ''
  events = new Map<string, FakeEvent>()
  codes = new Map<string, { challenge: string; scope: string }>()
  validTokens = new Set<string>()
  revoked = new Set<string>()
  insertCalls = 0
  failNextInsertAfterWrite = false
  forceStatus: number | null = null
  grantedScope = 'https://www.googleapis.com/auth/calendar.events.owned'
  lastAuthCodeVerifier: string | null = null
  private etagN = 1

  issueCode(challenge: string): string {
    const code = `code-${Math.random().toString(36).slice(2)}`
    this.codes.set(code, { challenge, scope: this.grantedScope })
    return code
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      const send = (status: number, body: unknown) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/token') {
        const p = new URLSearchParams(raw)
        const rec = this.codes.get(p.get('code') ?? '')
        const verifier = p.get('code_verifier') ?? ''
        this.lastAuthCodeVerifier = verifier
        if (!rec) return send(400, { error: 'invalid_grant' })
        this.codes.delete(p.get('code')!)
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (challenge !== rec.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        if (p.get('client_secret') !== 'test-secret') return send(401, { error: 'invalid_client' })
        const token = `at-${Math.random().toString(36).slice(2)}`
        this.validTokens.add(token)
        return send(200, { access_token: token, expires_in: 3599, scope: rec.scope, token_type: 'Bearer' })
      }
      if (url.pathname === '/revoke') {
        const t = new URLSearchParams(raw).get('token') ?? ''
        this.validTokens.delete(t)
        this.revoked.add(t)
        return send(200, {})
      }
      if (url.pathname.startsWith('/calendar/v3/calendars/primary/events')) {
        if (this.forceStatus) return send(this.forceStatus, { error: { code: this.forceStatus } })
        const auth = (req.headers.authorization ?? '').replace('Bearer ', '')
        if (!this.validTokens.has(auth)) return send(401, { error: { code: 401 } })
        const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '')
        if (req.method === 'GET' && !id) {
          const min = Date.parse(url.searchParams.get('timeMin')!)
          const max = Date.parse(url.searchParams.get('timeMax')!)
          const items = [...this.events.values()].filter((e) => Date.parse(e.end.dateTime) > min && Date.parse(e.start.dateTime) < max)
          // emulate `fields`: omit attendees/description when fields param present
          const fields = url.searchParams.get('fields')
          return send(200, { items: fields ? items.map(({ attendees: _a, description: _d, ...rest }) => rest) : items })
        }
        if (req.method === 'POST' && !id) {
          this.insertCalls++
          const body = JSON.parse(raw) as FakeEvent
          if (!/^[a-v0-9]{5,1024}$/.test(body.id)) return send(400, { error: { message: 'Invalid resource id value.' } })
          if (this.events.has(body.id)) return send(409, { error: { code: 409, message: 'The requested identifier already exists.' } })
          const ev = { ...body, status: 'confirmed', etag: `"${this.etagN++}"` }
          this.events.set(body.id, ev)
          if (this.failNextInsertAfterWrite) {
            this.failNextInsertAfterWrite = false
            return send(503, { error: { code: 503 } })
          }
          return send(200, ev)
        }
        if (req.method === 'GET' && id) {
          const ev = this.events.get(id)
          return ev ? send(200, ev) : send(404, { error: { code: 404 } })
        }
        if (req.method === 'PATCH' && id) {
          const ev = this.events.get(id)
          if (!ev) return send(404, { error: { code: 404 } })
          const ifMatch = req.headers['if-match']
          if (ifMatch && ifMatch !== ev.etag) return send(412, { error: { code: 412 } })
          const body = JSON.parse(raw) as Partial<FakeEvent>
          const next = { ...ev, ...body, etag: `"${this.etagN++}"` }
          this.events.set(id, next)
          return send(200, next)
        }
      }
      send(404, { error: 'not_found' })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  addEvent(e: Omit<FakeEvent, 'etag' | 'status'> & { status?: string }) {
    this.events.set(e.id, { status: 'confirmed', ...e, etag: `"${this.etagN++}"` })
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeGoogle } from './google'

/**
 * Contract fakes of the Gmail API v1 (metadata format, send) and the Slack Web API (oauth.v2.access,
 * search.messages, users.info, chat.postMessage, auth.revoke) as used by Questling. TEST DOUBLES only.
 */
interface GMsg {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: string
  headers: Record<string, string>
  body: string
}

export class FakeMessages {
  server!: Server
  base = ''
  calls: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }> = []
  gmail = new Map<string, GMsg>()
  sentRaw: string[] = []
  dropSentLabel = false
  slackCodes = new Set<string>()
  slackTokens = new Set<string>()
  slackRevoked = new Set<string>()
  slackScope = 'search:read,chat:write,users:read'
  slackPosts: Array<Record<string, string>> = []
  private n = 1

  constructor(private google: FakeGoogle) {}

  reset() {
    this.calls = []
    this.gmail.clear()
    this.sentRaw = []
    this.slackPosts = []
    this.dropSentLabel = false
    this.slackScope = 'search:read,chat:write,users:read'
    const now = Date.now()
    this.gmail.set('m1', { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'], internalDate: String(now - 600_000), headers: { From: '"Sam Lee" <sam@example.com>', Subject: 'Budget review — numbers by 3?', Date: new Date(now - 600_000).toUTCString(), 'Message-ID': '<abc123@mail.example.com>', 'Reply-To': 'finance@example.com' }, body: 'SECRET BODY TEXT' })
    this.gmail.set('m2', { id: 'm2', threadId: 't2', labelIds: ['INBOX', 'UNREAD'], internalDate: String(now - 3_600_000), headers: { From: 'news@shop.example', Subject: 'Weekly deals', Date: new Date(now - 3_600_000).toUTCString(), 'Message-ID': '<n1@shop>' }, body: 'deals' })
  }

  issueSlackCode() {
    const c = `slc-${Math.random().toString(36).slice(2)}`
    this.slackCodes.add(c)
    return c
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      this.calls.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body: raw })
      const send = (status: number, body: unknown) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const p = url.pathname

      // ---------------- Gmail
      if (p.startsWith('/gmail/v1/users/me/messages')) {
        if (!this.google.validTokens.has(bearer)) return send(401, { error: { code: 401 } })
        const rest = p.slice('/gmail/v1/users/me/messages'.length)
        if (rest === '' && req.method === 'GET') {
          const labels = url.searchParams.getAll('labelIds')
          if (url.searchParams.get('q')) return send(403, { error: { message: 'Metadata scope does not support q parameter' } })
          const items = [...this.gmail.values()].filter((m) => labels.every((l) => m.labelIds.includes(l)))
          return send(200, { messages: items.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: items.length })
        }
        if (rest === '/send' && req.method === 'POST') {
          const b = JSON.parse(raw || '{}')
          const decoded = Buffer.from(b.raw, 'base64url').toString('utf8')
          this.sentRaw.push(decoded)
          const id = `s${this.n++}`
          this.gmail.set(id, { id, threadId: b.threadId ?? id, labelIds: this.dropSentLabel ? [] : ['SENT'], internalDate: String(Date.now()), headers: { To: (decoded.match(/^To: (.*)$/m) ?? [])[1] ?? '' }, body: '' })
          return send(200, { id, threadId: b.threadId, labelIds: ['SENT'] })
        }
        const id = decodeURIComponent(rest.slice(1))
        const m = this.gmail.get(id)
        if (!m) return send(404, { error: { code: 404 } })
        if (url.searchParams.get('format') !== 'metadata') return send(403, { error: { message: 'Metadata scope only allows format=metadata' } })
        const wanted = url.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase())
        const headers = Object.entries(m.headers)
          .filter(([k]) => !wanted.length || wanted.includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value }))
        return send(200, { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, payload: { headers } })
      }

      // ---------------- Slack
      if (p === '/slack/api/oauth.v2.access' && req.method === 'POST') {
        const f = new URLSearchParams(raw)
        if (f.get('client_id') !== 'slack-client' || f.get('client_secret') !== 'slack-secret') return send(200, { ok: false, error: 'invalid_client_id' })
        if (!this.slackCodes.delete(f.get('code') ?? '')) return send(200, { ok: false, error: 'invalid_code' })
        if (f.get('redirect_uri') !== 'http://app.test/api/auth/slack/callback') return send(200, { ok: false, error: 'bad_redirect_uri' })
        const t = `xoxp-${Math.random().toString(36).slice(2)}`
        this.slackTokens.add(t)
        return send(200, { ok: true, app_id: 'A1', authed_user: { id: 'UME', scope: this.slackScope, access_token: t, token_type: 'user' }, team: { id: 'T1', name: 'Acme' } })
      }
      if (p.startsWith('/slack/api/')) {
        const method = p.slice('/slack/api/'.length)
        if (!this.slackTokens.has(bearer)) return send(200, { ok: false, error: 'invalid_auth' })
        if (method === 'auth.revoke') {
          this.slackTokens.delete(bearer)
          this.slackRevoked.add(bearer)
          return send(200, { ok: true, revoked: true })
        }
        if (method === 'search.messages') {
          const ts = (Date.now() / 1000 - 300).toFixed(6)
          const old = (Date.now() / 1000 - 10 * 86400).toFixed(6)
          return send(200, {
            ok: true,
            query: url.searchParams.get('query'),
            messages: {
              total: 3,
              matches: [
                { type: 'message', ts, text: '<@UME> can you review the deck before 3? <https://x.example/deck|deck link> &amp; thanks', user: 'USAM', username: 'sam', channel: { id: 'CDESIGN', name: 'design' } },
                { type: 'message', ts: (Number(ts) - 60).toFixed(6), text: 'note to self <@UME>', user: 'UME', username: 'me', channel: { id: 'CDESIGN', name: 'design' } },
                { type: 'message', ts: old, text: 'ancient <@UME>', user: 'USAM', channel: { id: 'COLD', name: 'old' } },
              ],
            },
          })
        }
        if (method === 'users.info') {
          const u = url.searchParams.get('user')
          return send(200, { ok: true, user: { id: u, name: u === 'USAM' ? 'sam' : 'me', real_name: u === 'USAM' ? 'Sam Lee' : 'Me', profile: { display_name: u === 'USAM' ? 'Sam' : 'Me' } } })
        }
        if (method === 'chat.postMessage') {
          if (!this.slackScope.includes('chat:write')) return send(200, { ok: false, error: 'missing_scope' })
          const b = JSON.parse(raw || '{}')
          this.slackPosts.push(b)
          const ts = (Date.now() / 1000).toFixed(6)
          return send(200, { ok: true, channel: b.channel, ts, message: { text: b.text, ts, thread_ts: b.thread_ts } })
        }
        return send(200, { ok: false, error: 'unknown_method' })
      }
      send(404, { error: 'not_found' })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()))
  }
}

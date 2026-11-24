import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeGoogle } from './google'

/**
 * Contract fakes of the Todoist API v1, Notion API (2025-09-03 data sources) and Google Tasks v1
 * endpoints Questling uses, plus their OAuth token/revoke endpoints. They encode the documented
 * behaviour the adapters rely on.
 */

interface TodoistTask {
  id: string
  content: string
  description: string
  checked: boolean
  due: { date: string; datetime?: string | null; is_recurring: boolean; string: string } | null
}
interface NotionPage {
  id: string
  title: string
  done: boolean
  due: string | null
  secret: string
}
interface GTask {
  id: string
  title: string
  status: 'needsAction' | 'completed'
  due?: string
  notes?: string
}

export class FakeTasks {
  server!: Server
  base = ''
  calls: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }> = []
  // Todoist
  todoistCodes = new Set<string>()
  todoistTokens = new Set<string>()
  todoistRevoked = new Set<string>()
  todoist = new Map<string, TodoistTask>()
  // Notion
  notionCodes = new Set<string>()
  notionTokens = new Set<string>()
  notionRevoked = new Set<string>()
  notionPages = new Map<string, NotionPage>()
  notionStatusMode = false
  // Google Tasks
  gtasks = new Map<string, GTask>()
  failClose = false

  constructor(private google: FakeGoogle) {}

  reset() {
    this.calls = []
    this.todoist.clear()
    this.notionPages.clear()
    this.gtasks.clear()
    this.failClose = false
    this.notionStatusMode = false
    this.todoist.set('t1', { id: 't1', content: 'Pay electricity bill', description: 'account 12345', checked: false, due: { date: '2026-11-25', is_recurring: false, string: 'tomorrow' } })
    this.todoist.set('t2', { id: 't2', content: 'Water plants', description: '', checked: false, due: { date: '2026-11-24', is_recurring: true, string: 'every day' } })
    this.todoist.set('t3', { id: 't3', content: 'Old done thing', description: '', checked: true, due: null })
    this.notionPages.set('11111111-aaaa-bbbb-cccc-000000000001', { id: '11111111-aaaa-bbbb-cccc-000000000001', title: 'Draft chapter 3', done: false, due: '2026-11-26', secret: 'private body text' })
    this.notionPages.set('11111111-aaaa-bbbb-cccc-000000000002', { id: '11111111-aaaa-bbbb-cccc-000000000002', title: 'Already shipped', done: true, due: null, secret: '' })
    this.gtasks.set('g1', { id: 'g1', title: 'Renew passport', status: 'needsAction', due: '2026-11-27T00:00:00.000Z', notes: 'bring photos' })
  }

  issueTodoistCode() {
    const c = `tdc-${Math.random().toString(36).slice(2)}`
    this.todoistCodes.add(c)
    return c
  }
  issueNotionCode() {
    const c = `ntc-${Math.random().toString(36).slice(2)}`
    this.notionCodes.add(c)
    return c
  }
  count(method: string, pathPart: string) {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length
  }

  private notionDataSources() {
    const done = this.notionStatusMode
      ? { Status: { id: 's', type: 'status', status: { options: [{ id: 'o1', name: 'Not started' }, { id: 'o2', name: 'In progress' }, { id: 'o3', name: 'Shipped' }], groups: [{ name: 'To-do', option_ids: ['o1'] }, { name: 'In progress', option_ids: ['o2'] }, { name: 'Complete', option_ids: ['o3'] }] } } }
      : { Done: { id: 'c', type: 'checkbox', checkbox: {} } }
    return [
      { object: 'data_source', id: '22222222-aaaa-bbbb-cccc-000000000009', title: [{ plain_text: 'Reading list' }], properties: { Title: { id: 't', type: 'title', title: {} }, Notes: { id: 'n', type: 'rich_text', rich_text: {} } } },
      { object: 'data_source', id: '22222222-aaaa-bbbb-cccc-000000000001', title: [{ plain_text: 'Tasks' }], properties: { Name: { id: 'title', type: 'title', title: {} }, ...done, Due: { id: 'd', type: 'date', date: {} } } },
    ]
  }

  private notionPageJson(p: NotionPage) {
    const doneProp = this.notionStatusMode ? { Status: { type: 'status', status: { name: p.done ? 'Shipped' : 'Not started' } } } : { Done: { type: 'checkbox', checkbox: p.done } }
    return { object: 'page', id: p.id, in_trash: false, properties: { Name: { type: 'title', title: [{ plain_text: p.title }] }, ...doneProp, Due: { type: 'date', date: p.due ? { start: p.due } : null }, Body: { type: 'rich_text', rich_text: [{ plain_text: p.secret }] } } }
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      this.calls.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body: raw })
      const send = (status: number, body?: unknown) => {
        res.statusCode = status
        if (body === undefined) return res.end()
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const p = url.pathname

      // ---------------- Todoist
      if (p === '/todoist/oauth/access_token' && req.method === 'POST') {
        const f = new URLSearchParams(raw)
        if (f.get('client_id') !== 'todo-client' || f.get('client_secret') !== 'todo-secret') return send(401, { error: 'invalid_client' })
        const code = f.get('code') ?? ''
        if (!this.todoistCodes.delete(code)) return send(400, { error: 'invalid_grant' })
        const t = `td-${Math.random().toString(36).slice(2)}`
        this.todoistTokens.add(t)
        return send(200, { access_token: t, token_type: 'Bearer' })
      }
      if (p.startsWith('/todoist/api/v1/')) {
        const rest = p.slice('/todoist/api/v1'.length)
        if (rest === '/access_tokens' && req.method === 'DELETE') {
          const t = url.searchParams.get('access_token') ?? ''
          this.todoistTokens.delete(t)
          this.todoistRevoked.add(t)
          return send(200)
        }
        if (!this.todoistTokens.has(bearer)) return send(401, { error: 'unauthorized' })
        if (rest === '/tasks' && req.method === 'GET') return send(200, { results: [...this.todoist.values()].filter((t) => !t.checked), next_cursor: null })
        const m = rest.match(/^\/tasks\/([^/]+)(\/close)?$/)
        if (m) {
          const t = this.todoist.get(decodeURIComponent(m[1]!))
          if (!t) return send(404, { error: 'not_found' })
          if (m[2] && req.method === 'POST') {
            if (this.failClose) return send(204)
            if (t.due?.is_recurring) t.due = { ...t.due, date: '2026-11-25' }
            else t.checked = true
            return send(204)
          }
          if (req.method === 'GET') return send(200, t)
        }
        return send(404, { error: 'not_found' })
      }

      // ---------------- Notion
      if (p === '/notion/v1/oauth/token' && req.method === 'POST') {
        const expected = `Basic ${Buffer.from('notion-client:notion-secret').toString('base64')}`
        if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' })
        const b = JSON.parse(raw || '{}')
        if (b.grant_type !== 'authorization_code' || !this.notionCodes.delete(b.code)) return send(400, { error: 'invalid_grant' })
        if (b.redirect_uri !== 'http://app.test/api/auth/notion/callback') return send(400, { error: 'invalid_request' })
        const t = `nt-${Math.random().toString(36).slice(2)}`
        this.notionTokens.add(t)
        return send(200, { access_token: t, token_type: 'bearer', bot_id: 'b', workspace_name: 'Studio', workspace_id: 'w', refresh_token: 'never-kept', owner: { type: 'user' } })
      }
      if (p === '/notion/v1/oauth/revoke' && req.method === 'POST') {
        const t = JSON.parse(raw || '{}').token
        this.notionTokens.delete(t)
        this.notionRevoked.add(t)
        return send(200, {})
      }
      if (p.startsWith('/notion/v1/')) {
        if (!this.notionTokens.has(bearer)) return send(401, { object: 'error', code: 'unauthorized' })
        if (!req.headers['notion-version']) return send(400, { object: 'error', code: 'missing_version' })
        const rest = p.slice('/notion/v1'.length)
        if (rest === '/search' && req.method === 'POST') return send(200, { object: 'list', results: this.notionDataSources(), has_more: false })
        const q = rest.match(/^\/data_sources\/([^/]+)\/query$/)
        if (q && req.method === 'POST') {
          if (q[1] !== '22222222-aaaa-bbbb-cccc-000000000001') return send(404, { object: 'error' })
          const b = JSON.parse(raw || '{}')
          let pages = [...this.notionPages.values()]
          if (b.filter?.checkbox?.equals === false) pages = pages.filter((x) => !x.done)
          if (b.filter?.and) pages = pages.filter((x) => !x.done)
          return send(200, { object: 'list', results: pages.map((x) => this.notionPageJson(x)), has_more: false })
        }
        const pg = rest.match(/^\/pages\/([^/]+)$/)
        if (pg) {
          const page = this.notionPages.get(decodeURIComponent(pg[1]!))
          if (!page) return send(404, { object: 'error' })
          if (req.method === 'PATCH') {
            const b = JSON.parse(raw || '{}')
            if (this.failClose) return send(200, this.notionPageJson(page))
            if (b.properties?.Done?.checkbox === true) page.done = true
            if (b.properties?.Status?.status?.name === 'Shipped') page.done = true
            return send(200, this.notionPageJson(page))
          }
          return send(200, this.notionPageJson(page))
        }
        return send(404, { object: 'error' })
      }

      // ---------------- Google Tasks (tokens come from FakeGoogle)
      if (p.startsWith('/gtasks/tasks/v1/lists/@default/tasks')) {
        if (!this.google.validTokens.has(bearer)) return send(401, { error: { code: 401 } })
        const id = decodeURIComponent(p.split('/tasks/v1/lists/@default/tasks')[1]?.replace(/^\//, '') ?? '')
        if (!id && req.method === 'GET') return send(200, { kind: 'tasks#tasks', items: [...this.gtasks.values()].filter((t) => url.searchParams.get('showCompleted') !== 'false' || t.status !== 'completed') })
        const t = this.gtasks.get(id)
        if (!t) return send(404, { error: { code: 404 } })
        if (req.method === 'PATCH') {
          const b = JSON.parse(raw || '{}')
          if (!this.failClose && b.status === 'completed') t.status = 'completed'
          return send(200, t)
        }
        return send(200, t)
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

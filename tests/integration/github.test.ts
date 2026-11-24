import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handle, setRuntimeForTests } from '../../server/app'
import { loadConfig } from '../../server/config'
import { resetTaskStateForTests } from '../../server/tasks'
import { FAKE_GH_TOKEN, FakeGitHub } from '../fakes/github'

const gh = new FakeGitHub()
let api: Server
let base = ''

async function call(path: string, init: RequestInit & { token?: string; link?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.link) headers['x-lq-link'] = init.link
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'
  const r = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
  const text = await r.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { html: text }
  }
  return { status: r.status, body, text }
}
const session = async () => (await call('/api/session', { method: 'POST', body: '{}' })).body.token as string
const form = (code: string, token: string) => call('/api/auth/github', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, token }).toString() })

async function start(tok: string) {
  const s = await call('/api/connect/start', { method: 'POST', body: JSON.stringify({ provider: 'github' }), token: tok })
  return s.body as Record<string, string>
}
async function link(tok: string): Promise<string> {
  const { linkId, pollSecret, userCode } = await start(tok)
  const page = await call(`/api/auth/start?code=${encodeURIComponent(userCode!)}`)
  expect(page.text).toContain('action="/api/auth/github"')
  expect(page.text).toContain('notifications')
  const ok = await form(userCode!, FAKE_GH_TOKEN)
  expect(ok.text).toContain('connected as @octo-tester')
  const done = await call('/api/connect/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })
  expect(done.body).toMatchObject({ status: 'connected', provider: 'github', label: 'GitHub · @octo-tester', canSend: false })
  expect(JSON.stringify(done.body)).not.toContain(FAKE_GH_TOKEN)
  return done.body.sessionHandle as string
}

beforeAll(async () => {
  await gh.start()
  api = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(async () => {
  await gh.stop()
  await new Promise<void>((r) => api.close(() => r()))
})
beforeEach(() => {
  setRuntimeForTests({ cfg: loadConfig({ NODE_ENV: 'test', APP_BASE_URL: 'http://app.test', GITHUB_API_BASE: gh.base }) })
  resetTaskStateForTests()
  gh.reset()
})

describe('GitHub notifications', () => {
  it('link: classic token with the notifications scope only; wrong or scope-less tokens are refused', async () => {
    const tok = await session()
    const { userCode } = await start(tok)
    expect((await form(userCode!, 'github_pat_fine_grained_123')).text).toContain('classic personal access token')
    gh.scopes = 'read:user'
    expect((await form(userCode!, FAKE_GH_TOKEN)).text).toContain('no “notifications” scope')
    gh.scopes = 'notifications'
    await link(tok)
  })

  it('lists only unread review requests, mentions and assignments — minimized; replies are refused', async () => {
    const tok = await session()
    const h = await link(tok)
    const r = await call('/api/messages', { token: tok, link: h })
    expect(r.status).toBe(200)
    const items = r.body.items as Array<Record<string, unknown>>
    expect(items.map((i) => i.id).sort()).toEqual(['101', '103'])
    expect(items.find((i) => i.id === '101')).toMatchObject({ provider: 'github', where: 'acme/web', title: 'Add billing export (#128)', preview: 'Review requested · Pull Request', canReply: false })
    const reply = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_github00000001', messageId: '101', body: 'hi' }) })
    expect(reply.status).toBe(403)
  })

  it('mark as read: verified by reading the thread back, idempotent, honest when GitHub ignores it', async () => {
    const tok = await session()
    const h = await link(tok)
    const body = { proposalId: 'prop_github00000002', messageId: '101' }
    const ok = await call('/api/messages/read', { method: 'POST', token: tok, link: h, body: JSON.stringify(body) })
    expect(ok.body).toMatchObject({ ok: true, verified: true, reconciled: false })
    expect(gh.threads.find((t) => t.id === '101')!.unread).toBe(false)
    const again = await call('/api/messages/read', { method: 'POST', token: tok, link: h, body: JSON.stringify(body) })
    expect(again.body.reconciled).toBe(true)
    gh.ignoreWrites = true
    const bad = await call('/api/messages/read', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_github00000003', messageId: '103' }) })
    expect(bad.status).toBe(502)
    expect(bad.body.error).toBe('write_unverified')
  })
})

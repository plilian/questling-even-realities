import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handle, setRuntimeForTests } from '../../server/app'
import { loadConfig, type ServerConfig } from '../../server/config'
import { resetGoogleStateForTests } from '../../server/google'
import { resetTaskStateForTests } from '../../server/tasks'
import { buildGmailReply, displayName, slackPlain } from '../../server/messages'
import { FakeGoogle } from '../fakes/google'
import { FakeMessages } from '../fakes/messages'

const google = new FakeGoogle()
const fake = new FakeMessages(google)
let api: Server
let base = ''
let cfg: ServerConfig

function makeCfg(over: Partial<NodeJS.ProcessEnv> = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://app.test',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: 'http://app.test/api/auth/google/callback',
    GOOGLE_AUTH_URL: `${google.base}/auth`,
    GOOGLE_TOKEN_URL: `${google.base}/token`,
    GOOGLE_REVOKE_URL: `${google.base}/revoke`,
    GMAIL_API_BASE: `${fake.base}/gmail/v1`,
    SLACK_CLIENT_ID: 'slack-client',
    SLACK_CLIENT_SECRET: 'slack-secret',
    SLACK_AUTH_URL: `${fake.base}/slack/oauth/v2/authorize`,
    SLACK_API_BASE: `${fake.base}/slack/api`,
    ...over,
  })
}

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
  return { status: r.status, body, headers: r.headers }
}
const token = async () => (await call('/api/session', { method: 'POST', body: '{}' })).body.token as string

const GMAIL = 'https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/gmail.send'

async function link(tok: string, provider: 'gmail' | 'slack', grantedGoogle = GMAIL): Promise<string> {
  const start = await call('/api/connect/start', { method: 'POST', body: JSON.stringify({ provider }), token: tok })
  expect(start.status).toBe(200)
  const { linkId, pollSecret, userCode } = start.body as Record<string, string>
  const redirect = await call(`/api/auth/start?code=${encodeURIComponent(userCode!)}`)
  expect(redirect.status).toBe(302)
  const auth = new URL(redirect.headers.get('location')!)
  const state = auth.searchParams.get('state')!
  let cb: string
  if (provider === 'gmail') {
    expect(auth.searchParams.get('scope')).toBe(GMAIL)
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('redirect_uri')).toBe('http://app.test/api/auth/google/callback')
    google.grantedScope = grantedGoogle
    cb = `/api/auth/google/callback?code=${google.issueCode(auth.searchParams.get('code_challenge')!)}&state=${state}`
  } else {
    expect(auth.searchParams.get('user_scope')).toBe('search:read,chat:write,users:read')
    expect(auth.searchParams.get('redirect_uri')).toBe('http://app.test/api/auth/slack/callback')
    cb = `/api/auth/slack/callback?code=${fake.issueSlackCode()}&state=${state}`
  }
  expect((await call(cb)).status).toBe(200)
  const done = await call('/api/connect/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })
  expect(done.body.status).toBe('connected')
  const body = JSON.stringify(done.body)
  for (const t of [...fake.slackTokens, ...google.validTokens]) expect(body).not.toContain(t) // the real issued tokens never leave the server
  return done.body.sessionHandle as string
}

beforeAll(async () => {
  await google.start()
  await fake.start()
  api = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(async () => {
  await google.stop()
  await fake.stop()
  await new Promise<void>((r) => api.close(() => r()))
})
beforeEach(() => {
  cfg = makeCfg()
  setRuntimeForTests({ cfg })
  resetGoogleStateForTests()
  resetTaskStateForTests()
  fake.reset()
})

describe('mail & chat: helpers', () => {
  it('keeps only display names and builds a safe threaded reply', () => {
    expect(displayName('"Sam Lee" <sam@example.com>')).toBe('Sam Lee')
    expect(displayName('news@shop.example')).toBe('news')
    const raw = buildGmailReply({ from: 'Sam <sam@x.com>', replyTo: 'evil@x.com\r\nBcc: victim@x.com', subject: 'Budget\r\nBcc: a@b.c', messageId: '<m1@x>', references: '' }, 'On it, by 3.')
    expect(raw).not.toMatch(/\r\nBcc:/)
    expect(raw).toMatch(/^To: evil@x\.com\r\n/) // exactly one address, nothing smuggled in
    expect(raw).not.toContain('victim')
    expect(raw).toContain('Subject: Re: Budget Bcc: a@b.c')
    expect(raw).toContain('In-Reply-To: <m1@x>')
    expect(raw).toContain(Buffer.from('On it, by 3.').toString('base64'))
  })
  it('turns Slack markup into plain text', async () => {
    expect(await slackPlain('<@U1> see <#C1|design> and <https://a.b|this> &amp; <!here>', async () => 'Sam')).toBe('@Sam see #design and this & @here')
  })
})

describe('Gmail', () => {
  it('links with metadata + send, lists unread as sender/subject only — never bodies or addresses', async () => {
    const t = await token()
    const h = await link(t, 'gmail')
    const r = await call('/api/messages', { token: t, link: h })
    expect(r.status).toBe(200)
    const items = r.body.items as Array<Record<string, unknown>>
    expect(items.map((i) => i.title)).toEqual(['Budget review — numbers by 3?', 'Weekly deals'])
    expect(items[0]).toMatchObject({ provider: 'gmail', from: 'Sam Lee', important: true, canReply: true, preview: '' })
    const json = JSON.stringify(r.body)
    expect(json).not.toContain('SECRET BODY TEXT')
    expect(json).not.toMatch(/@example\.com|finance@/)
    // metadata scope: no `q` search, only format=metadata
    expect(fake.calls.filter((c) => c.path.includes('/gmail/')).every((c) => !c.path.includes('q=') && (!c.path.includes('/messages/m') || c.path.includes('format=metadata')))).toBe(true)
  })
  it('sends a confirmed reply to Reply-To in the same thread, verifies SENT, and is idempotent', async () => {
    const t = await token()
    const h = await link(t, 'gmail')
    const body = { proposalId: 'prop_MAILREPLY01', messageId: 'm1', body: 'Numbers coming at 2:30. — Sent from Questling' }
    const r = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify(body), token: t, link: h })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ verified: true, reconciled: false })
    expect((r.body.sent as { to: string }).to).toBe('finance')
    expect(fake.sentRaw[0]).toMatch(/^To: finance@example.com/)
    expect(fake.sentRaw[0]).toContain('In-Reply-To: <abc123@mail.example.com>')
    expect(fake.sentRaw[0]).toContain('Subject: =?UTF-8?B?')
    const again = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify(body), token: t, link: h })
    expect(again.body.reconciled).toBe(true)
    expect(fake.sentRaw).toHaveLength(1)
  })
  it('refuses profanity in outgoing mail, unverified sends, and read-only grants', async () => {
    const t = await token()
    const h = await link(t, 'gmail')
    const dirty = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_MAILDIRTY1', messageId: 'm1', body: 'shit, fine' }), token: t, link: h })
    expect(dirty.status).toBe(422)
    expect(dirty.body.error).toBe('outgoing_message_must_be_clean')
    fake.dropSentLabel = true
    const unverified = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_MAILUNVER1', messageId: 'm1', body: 'ok' }), token: t, link: h })
    expect(unverified.status).toBe(502)
    expect(unverified.body.error).toBe('message_send_unverified')
    const ro = await link(t, 'gmail', 'https://www.googleapis.com/auth/gmail.metadata')
    const list = await call('/api/messages', { token: t, link: ro })
    expect((list.body.items as Array<{ canReply: boolean }>)[0]!.canReply).toBe(false)
    const denied = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_MAILRO0001', messageId: 'm1', body: 'ok' }), token: t, link: ro })
    expect(denied.status).toBe(403)
  })
  it('a task session cannot read mail (and vice versa)', async () => {
    const t = await token()
    const h = await link(t, 'gmail')
    expect((await call('/api/tasks', { token: t, headers: { 'x-lq-tasks': h } })).status).toBe(400)
  })
})

describe('Slack', () => {
  it('lists recent mentions as plain text with names, skipping own and old messages', async () => {
    const t = await token()
    const h = await link(t, 'slack')
    const r = await call('/api/messages', { token: t, link: h })
    expect(r.status).toBe(200)
    expect(r.body.label).toBe('Slack · Acme')
    const items = r.body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ provider: 'slack', from: 'Sam', where: '#design', preview: '@Me can you review the deck before 3? deck link & thanks', canReply: true })
    expect(fake.calls.find((c) => c.path.startsWith('/slack/api/search.messages'))!.path).toContain(encodeURIComponent('<@UME>'))
  })
  it('replies in the thread after confirmation, verified by Slack’s echo; revoke on disconnect', async () => {
    const t = await token()
    const h = await link(t, 'slack')
    const items = (await call('/api/messages', { token: t, link: h })).body.items as Array<{ id: string }>
    const r = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_SLACKREPL1', messageId: items[0]!.id, body: 'On it — before 3.' }), token: t, link: h })
    expect(r.status).toBe(200)
    expect(fake.slackPosts[0]).toMatchObject({ channel: 'CDESIGN', text: 'On it — before 3.' })
    expect(fake.slackPosts[0]!.thread_ts).toMatch(/^\d+\.\d+$/)
    const bad = await call('/api/messages/reply', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_SLACKBAD01', messageId: 'not-an-id', body: 'x' }), token: t, link: h })
    expect(bad.status).toBe(400)
    const d = await call('/api/connect/disconnect', { method: 'POST', body: '{}', token: t, link: h })
    expect(d.body.revoked).toBe(true)
    expect(fake.slackRevoked.size).toBe(1)
  })
  it('without chat:write the inbox is read-only', async () => {
    fake.slackScope = 'search:read,users:read'
    const t = await token()
    const h = await link(t, 'slack')
    const items = (await call('/api/messages', { token: t, link: h })).body.items as Array<{ canReply: boolean; id: string }>
    expect(items[0]!.canReply).toBe(false)
    expect((await call('/api/messages/reply', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_SLACKRO001', messageId: items[0]!.id, body: 'x' }), token: t, link: h })).status).toBe(403)
  })
  it('reports configuration in /api/status', async () => {
    expect((await call('/api/status')).body.messages).toEqual({ gmail: true, slack: true, telegram: true, github: true })
    setRuntimeForTests({ cfg: makeCfg({ SLACK_CLIENT_ID: '', GMAIL_ENABLED: 'false', TELEGRAM_ENABLED: 'false', GITHUB_ENABLED: 'false' }) })
    expect((await call('/api/status')).body.messages).toEqual({ gmail: false, slack: false, telegram: false, github: false })
  })
})

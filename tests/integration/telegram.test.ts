import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handle, setRuntimeForTests } from '../../server/app'
import { loadConfig } from '../../server/config'
import { resetTaskStateForTests } from '../../server/tasks'
import { FAKE_BOT_TOKEN, FakeTelegram } from '../fakes/telegram'

const tg = new FakeTelegram()
let api: Server
let base = ''
const OWNER = 777001

function cfg(over: Partial<NodeJS.ProcessEnv> = {}) {
  return loadConfig({ NODE_ENV: 'test', APP_BASE_URL: 'http://app.test', TELEGRAM_API_BASE: tg.base, ...over })
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
  return { status: r.status, body, text }
}
const session = async () => (await call('/api/session', { method: 'POST', body: '{}' })).body.token as string
const form = (code: string, token: string) => call('/api/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, token }).toString() })

async function link(tok: string): Promise<string> {
  const start = await call('/api/connect/start', { method: 'POST', body: JSON.stringify({ provider: 'telegram' }), token: tok })
  expect(start.status).toBe(200)
  const { linkId, pollSecret, userCode } = start.body as Record<string, string>
  // the shared /link page shows a token form for Telegram instead of an OAuth redirect
  const page = await call(`/api/auth/start?code=${encodeURIComponent(userCode!)}`)
  expect(page.status).toBe(200)
  expect(page.text).toContain('action="/api/auth/telegram"')
  expect(page.text).toContain('Business Mode')
  const ok = await form(userCode!, FAKE_BOT_TOKEN)
  expect(ok.status).toBe(200)
  expect(ok.text).toContain('connected as @questling_test_bot')
  const done = await call('/api/connect/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })
  expect(done.body).toMatchObject({ status: 'connected', provider: 'telegram', label: 'Telegram · @questling_test_bot' })
  expect(JSON.stringify(done.body)).not.toContain(FAKE_BOT_TOKEN.split(':')[1])
  return done.body.sessionHandle as string
}

beforeAll(async () => {
  await tg.start()
  api = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(async () => {
  await tg.stop()
  await new Promise<void>((r) => api.close(() => r()))
})
beforeEach(() => {
  setRuntimeForTests({ cfg: cfg() })
  resetTaskStateForTests()
  tg.reset()
})

describe('Telegram link (own bot token on the /link page)', () => {
  it('rejects malformed and unknown tokens, refuses bots with a webhook, never returns the token', async () => {
    const tok = await session()
    const start = await call('/api/connect/start', { method: 'POST', body: JSON.stringify({ provider: 'telegram' }), token: tok })
    const { linkId, pollSecret, userCode } = start.body as Record<string, string>
    const bad = await form(userCode!, 'not-a-token')
    expect(bad.status).toBe(400)
    expect(bad.text).toContain('does not look like a bot token')
    const wrong = await form(userCode!, ['123456789', 'AAWrongTokenWrongTokenWrongToken_xyz'].join(':'))
    expect(wrong.status).toBe(400)
    expect(wrong.text).toContain('did not accept that token')
    tg.webhookUrl = 'https://example.org/hook'
    const hooked = await form(userCode!, FAKE_BOT_TOKEN)
    expect(hooked.text).toContain('webhook')
    for (const r of [bad, wrong, hooked]) expect(r.text).not.toContain(FAKE_BOT_TOKEN)
    const still = await call('/api/connect/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })
    expect(still.body.status).toBe('pending')
  })

  it('the /link token form is only shown for Telegram codes and the form needs a valid pending code', async () => {
    const r = await form('ZZZZ-ZZZZ', FAKE_BOT_TOKEN)
    expect(r.text).toContain('expired')
    expect(tg.calls).toEqual([]) // never touched Telegram without a valid code
  })

  it('reports configuration in /api/status and can be switched off', async () => {
    expect(((await call('/api/status')).body.messages as Record<string, boolean>).telegram).toBe(true)
    setRuntimeForTests({ cfg: cfg({ TELEGRAM_ENABLED: 'false' }) })
    expect(((await call('/api/status')).body.messages as Record<string, boolean>).telegram).toBe(false)
  })
})

describe('Telegram bot mode', () => {
  it('lists DMs to the bot and group mentions only; replies are confirmed by Telegram’s echo and idempotent', async () => {
    const tok = await session()
    const h = await link(tok)
    tg.message({ chatId: 4242, fromId: 4242, first: 'Alice', text: 'Can you send me the slides?' })
    tg.message({ chatId: -100777, type: 'supergroup', title: 'Launch crew', fromId: 5151, first: 'Bob', text: 'lunch anyone?' })
    tg.message({ chatId: -100777, type: 'supergroup', title: 'Launch crew', fromId: 5151, first: 'Bob', text: '@questling_test_bot is the venue confirmed?' })
    tg.message({ chatId: -100777, type: 'supergroup', title: 'Launch crew', fromId: 6161, first: 'Cleo', text: 'answering the bot', replyToBot: true })
    const list = await call('/api/messages', { token: tok, link: h })
    expect(list.status).toBe(200)
    const items = list.body.items as Array<Record<string, unknown>>
    expect(items.map((i) => i.from).sort()).toEqual(['Alice', 'Bob', 'Cleo'])
    expect(items.find((i) => i.from === 'Alice')).toMatchObject({ provider: 'telegram', where: '@questling_test_bot', canReply: true, important: true })
    expect(items.find((i) => i.from === 'Bob')).toMatchObject({ where: 'Launch crew', preview: '@questling_test_bot is the venue confirmed?' })
    expect(JSON.stringify(list.body)).not.toContain(FAKE_BOT_TOKEN)
    // updates are confirmed with the next offset; the buffer keeps them for the inbox
    const again = await call('/api/messages', { token: tok, link: h })
    expect((again.body.items as unknown[]).length).toBe(3)

    const alice = items.find((i) => i.from === 'Alice')!
    const body = { proposalId: 'prop_abcdefgh12345678', messageId: alice.id, body: 'Sending them in 10 minutes.' }
    const sent = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify(body) })
    expect(sent.status).toBe(200)
    expect(sent.body).toMatchObject({ verified: true, reconciled: false })
    expect(tg.sent[0]).toMatchObject({ chat_id: 4242, text: 'Sending them in 10 minutes.', reply_parameters: { message_id: expect.any(Number) } })
    expect(tg.sent[0]!.business_connection_id).toBeUndefined()
    const replay = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify(body) })
    expect(replay.body.reconciled).toBe(true)
    expect(tg.sent).toHaveLength(1)
    // answered messages leave the inbox
    expect(((await call('/api/messages', { token: tok, link: h })).body.items as unknown[]).length).toBe(2)
  })

  it('refuses profanity and unverified sends; maps a polling conflict honestly', async () => {
    const tok = await session()
    const h = await link(tok)
    tg.message({ chatId: 4242, fromId: 4242, first: 'Alice', text: 'ping' })
    const item = ((await call('/api/messages', { token: tok, link: h })).body.items as Array<{ id: string }>)[0]!
    const dirty = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_abcdefgh00000001', messageId: item.id, body: 'damn right' }) })
    expect(dirty.status).toBe(422)
    tg.alterEcho = true
    const unverified = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_abcdefgh00000002', messageId: item.id, body: 'On it.' }) })
    expect(unverified.status).toBe(502)
    expect(unverified.body.error).toBe('message_send_unverified')
    tg.conflict = true
    const c = await call('/api/messages', { token: tok, link: h })
    expect(c.status).toBe(409)
    expect(c.body.error).toBe('telegram_conflict')
  })
})

describe('Telegram Business mode (replies as the user)', () => {
  it('private chats via a business connection: reply carries the connection id; answering in Telegram clears it; 24 h window and rights are enforced', async () => {
    const tok = await session()
    const h = await link(tok)
    tg.businessConnection('bc1', OWNER, true)
    tg.businessMessage({ connection: 'bc1', chatId: 9001, fromId: 9001, first: 'Mira', text: 'Still on for 12:30?' })
    tg.businessMessage({ connection: 'bc1', chatId: 9002, fromId: 9002, first: 'Jonas', text: 'Approve the quote?' })
    tg.businessMessage({ connection: 'bc1', chatId: 9003, fromId: 9003, first: 'Old', text: 'from yesterday', ageSec: 25 * 3600 })
    let list = await call('/api/messages', { token: tok, link: h })
    expect(list.body.label).toBe('Telegram · @questling_test_bot · Business')
    let items = list.body.items as Array<Record<string, unknown>>
    expect(items.find((i) => i.from === 'Mira')).toMatchObject({ where: 'Telegram', canReply: true })
    expect(items.find((i) => i.from === 'Old')).toMatchObject({ canReply: false })
    const mira = items.find((i) => i.from === 'Mira')!
    const ok = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_business00000001', messageId: mira.id, body: 'Yes, see you then.' }) })
    expect(ok.status).toBe(200)
    expect(tg.sent[0]).toMatchObject({ business_connection_id: 'bc1', chat_id: 9001 })
    const old = items.find((i) => i.from === 'Old')!
    const late = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_business00000002', messageId: old.id, body: 'Sorry, late.' }) })
    expect(late.status).toBe(403)
    expect(late.body.error).toBe('telegram_reply_window_closed')
    // the owner answers Jonas in Telegram itself → no longer pending in Questling
    tg.businessMessage({ connection: 'bc1', chatId: 9002, fromId: OWNER, first: 'Owner', text: 'Approved', ageSec: 1 })
    list = await call('/api/messages', { token: tok, link: h })
    items = list.body.items as Array<Record<string, unknown>>
    expect(items.some((i) => i.from === 'Jonas')).toBe(false)
  })

  it('without “reply” rights the chats are read-only; a disabled connection drops its chats', async () => {
    const tok = await session()
    const h = await link(tok)
    tg.businessConnection('bc2', OWNER, false)
    tg.businessMessage({ connection: 'bc2', chatId: 9100, fromId: 9100, first: 'Nora', text: 'hello' })
    const items = (await call('/api/messages', { token: tok, link: h })).body.items as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ from: 'Nora', canReply: false })
    const denied = await call('/api/messages/reply', { method: 'POST', token: tok, link: h, body: JSON.stringify({ proposalId: 'prop_business00000003', messageId: items[0]!.id, body: 'hi' }) })
    expect(denied.status).toBe(403)
    tg.businessConnection('bc2', OWNER, false, false)
    expect(((await call('/api/messages', { token: tok, link: h })).body.items as unknown[]).length).toBe(0)
  })

  it('disconnect forgets the token (nothing to revoke: it is the user’s own bot)', async () => {
    const tok = await session()
    const h = await link(tok)
    const d = await call('/api/connect/disconnect', { method: 'POST', token: tok, link: h, body: '{}' })
    expect(d.body).toMatchObject({ ok: true, revoked: false })
    expect((await call('/api/messages', { token: tok, link: h })).status).toBe(401)
  })
})

describe('Telegram capture', () => {
  it('“/quest …” sent to your own bot is a capture, not an inbox message; it stays until the app acknowledges it', async () => {
    const tok = await session()
    const h = await link(tok)
    tg.message({ chatId: 4242, fromId: 4242, first: 'Pili', text: '/quest Call the bank about the card' })
    tg.message({ chatId: 4242, fromId: 4242, first: 'Pili', text: 'just chatting' })
    const r = await call('/api/messages', { token: tok, link: h })
    expect((r.body.captures as Array<Record<string, unknown>>).map((c) => c.text)).toEqual(['Call the bank about the card'])
    expect((r.body.items as Array<Record<string, unknown>>).map((i) => i.preview)).toEqual(['just chatting'])
    const id = (r.body.captures as Array<{ id: string }>)[0]!.id
    expect(((await call('/api/messages', { token: tok, link: h })).body.captures as unknown[]).length).toBe(1)
    expect(((await call(`/api/messages?ack=${encodeURIComponent(id)}`, { token: tok, link: h })).body.captures as unknown[]).length).toBe(0)
    expect(tg.sent).toHaveLength(0) // capturing never writes to Telegram
  })
})

describe('Telegram channel digest', () => {
  it('collects channel posts and group chatter the bot can read; mentions still reach the inbox; private chats never appear', async () => {
    const tok = await session()
    const h = await link(tok)
    tg.channelPost({ chatId: -100500, title: 'Even Realities News', text: 'G2 firmware 1.8 is out: faster text rendering.', ageSec: 3600 })
    tg.channelPost({ chatId: -100500, title: 'Even Realities News', text: 'Hackathon submissions close Sunday.', ageSec: 600 })
    tg.message({ chatId: -100777, type: 'supergroup', title: 'Launch crew', fromId: 5151, first: 'Bob', text: 'venue is confirmed for Friday', ageSec: 300 })
    tg.message({ chatId: -100777, type: 'supergroup', title: 'Launch crew', fromId: 6161, first: 'Cleo', text: '@questling_test_bot can you check the guest list?', ageSec: 200 })
    tg.message({ chatId: 4242, fromId: 4242, first: 'Alice', text: 'private note to the bot' })
    tg.channelPost({ chatId: -100600, title: 'Old news', text: 'from last week', ageSec: 3 * 86400 })
    const d = await call('/api/messages/digest', { token: tok, link: h })
    expect(d.status).toBe(200)
    const ch = d.body.channels as Array<{ id: string; title: string; kind: string; posts: Array<{ text: string }> }>
    expect(ch.map((c) => [c.title, c.kind])).toEqual([
      ['Launch crew', 'group'],
      ['Even Realities News', 'channel'],
    ])
    expect(ch[1]!.posts.map((p) => p.text)).toEqual(['Hackathon submissions close Sunday.', 'G2 firmware 1.8 is out: faster text rendering.'])
    expect(ch[0]!.posts.map((p) => p.text)).toEqual(['@questling_test_bot can you check the guest list?', 'venue is confirmed for Friday'])
    expect(JSON.stringify(d.body)).not.toContain('private note to the bot')
    expect(JSON.stringify(d.body)).not.toContain(FAKE_BOT_TOKEN)
    expect(tg.bodies.find((c) => c.method === 'getUpdates')!.body.allowed_updates).toContain('channel_post')
    // the digest pull did not lose inbox messages: the DM and the mention are still there
    const inbox = (await call('/api/messages', { token: tok, link: h })).body.items as Array<{ from: string }>
    expect(inbox.map((i) => i.from).sort()).toEqual(['Alice', 'Cleo'])
    // reading the digest again keeps the posts (buffer), without duplicates
    const again = (await call('/api/messages/digest', { token: tok, link: h })).body.channels as Array<{ posts: unknown[] }>
    expect(again.map((c) => c.posts.length)).toEqual([2, 2])
    expect(tg.sent).toHaveLength(0)
  })
  it('is bounded per chat and only for Telegram connections', async () => {
    const tok = await session()
    const h = await link(tok)
    for (let i = 0; i < 40; i++) tg.channelPost({ chatId: -100900, title: 'Busy channel', text: `post ${i}`, ageSec: 1000 - i })
    const ch = (await call('/api/messages/digest', { token: tok, link: h })).body.channels as Array<{ posts: Array<{ text: string }> }>
    expect(ch[0]!.posts).toHaveLength(10)
    expect(ch[0]!.posts[0]!.text).toBe('post 39')
    const r = await call('/api/messages/digest', { token: tok })
    expect(r.status).toBe(401)
  })
})

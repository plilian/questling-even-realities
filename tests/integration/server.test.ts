import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handle, setRuntimeForTests } from '../../server/app'
import { loadConfig, type ServerConfig } from '../../server/config'
import { resetGoogleStateForTests } from '../../server/google'
import type { AiProvider } from '../../server/gemini'
import { FakeGoogle } from '../fakes/google'
import type { AiRequest } from '../../src/shared/ai'

let api: Server
let base = ''
const google = new FakeGoogle()
let cfg: ServerConfig

function makeCfg(over: Partial<NodeJS.ProcessEnv> = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://app.test',
    ALLOWED_ORIGINS: 'http://app.test',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: 'http://app.test/api/auth/google/callback',
    GOOGLE_AUTH_URL: `${google.base}/auth`,
    GOOGLE_TOKEN_URL: `${google.base}/token`,
    GOOGLE_REVOKE_URL: `${google.base}/revoke`,
    GOOGLE_CALENDAR_BASE: `${google.base}/calendar/v3`,
    AI_DAILY_BUDGET: '3',
    AI_RATE_PER_MINUTE: '50',
    ...over,
  })
}

const goodAiResponse = {
  transcript: null,
  dialogue: 'Meeting in 15 minutes. Want to review it?',
  cleanDialogue: null,
  emotion: 'annoyed',
  intent: 'schedule',
  needsClarification: false,
  actions: [
    { type: 'propose_calendar_event', title: 'Focus: slides', startLocal: '2026-11-24T14:00', durationMinutes: 30, questRef: 'Q1' },
    { type: 'enable_adult_mode' },
    { type: 'create_local_quest', title: 'x'.repeat(200), category: 'work', difficulty: 'normal', estimatedMinutes: 20 },
  ],
  memoryCandidates: [],
}

class FakeAi implements AiProvider {
  readonly id = 'gemini' as const
  readonly model = 'fake-model'
  readonly audio = true
  calls: AiRequest[] = []
  async generate(req: AiRequest) {
    this.calls.push(req)
    const { parseAiResponse, normalizeModelActions } = await import('../../src/shared/ai')
    return { ok: true as const, response: parseAiResponse(normalizeModelActions(goodAiResponse))! }
  }
}
const fakeAi = new FakeAi()

async function call(path: string, init: RequestInit & { token?: string; cal?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.cal) headers['x-lq-calendar'] = init.cal
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

async function token(): Promise<string> {
  const r = await call('/api/session', { method: 'POST', body: '{}' })
  expect(r.status).toBe(200)
  return r.body.token as string
}

/** Drive the full external-browser link flow against the fake provider. */
async function connectCalendar(tok: string): Promise<string> {
  const start = await call('/api/calendar/link/start', { method: 'POST', body: '{}', token: tok })
  expect(start.status).toBe(200)
  const { linkId, pollSecret, userCode } = start.body as Record<string, string>
  expect((await call('/api/calendar/link/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })).body.status).toBe('pending')
  const redirect = await call(`/api/auth/google/start?code=${encodeURIComponent(userCode!)}`)
  expect(redirect.status).toBe(302)
  const authUrl = new URL(redirect.headers.get('location')!)
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events.owned')
  expect(authUrl.searchParams.get('access_type')).toBe('online')
  const code = google.issueCode(authUrl.searchParams.get('code_challenge')!)
  const cb = await call(`/api/auth/google/callback?code=${code}&state=${authUrl.searchParams.get('state')}`)
  expect(cb.status).toBe(200)
  // state replay is rejected
  const replay = await call(`/api/auth/google/callback?code=${code}&state=${authUrl.searchParams.get('state')}`)
  expect(replay.status).toBe(400)
  const done = await call('/api/calendar/link/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })
  expect(done.body.status).toBe('connected')
  // single-use redemption
  expect((await call('/api/calendar/link/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })).body.status).toBe('expired')
  return done.body.sessionHandle as string
}

beforeAll(async () => {
  await google.start()
  api = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(async () => {
  await google.stop()
  await new Promise<void>((r) => api.close(() => r()))
})
beforeEach(() => {
  cfg = makeCfg()
  setRuntimeForTests({ cfg, ai: fakeAi })
  resetGoogleStateForTests()
})

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

describe('access control', () => {
  it('rejects API calls without a valid token', async () => {
    expect((await call('/api/calendar/link/start', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await call('/api/calendar/link/start', { method: 'POST', body: '{}', token: 'a.b.c' })).status).toBe(401)
  })
  it('requires an operator access code in production', async () => {
    setRuntimeForTests({ cfg: makeCfg({ NODE_ENV: 'production', ACCESS_CODES: 'judge-2026' }), ai: fakeAi })
    expect((await call('/api/session', { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await call('/api/session', { method: 'POST', body: JSON.stringify({ accessCode: 'nope' }) })).status).toBe(403)
    expect((await call('/api/session', { method: 'POST', body: JSON.stringify({ accessCode: 'judge-2026' }) })).status).toBe(200)
  })
  it('CORS only for allowlisted origins; never an arbitrary proxy', async () => {
    const ok = await fetch(`${base}/api/status`, { headers: { origin: 'http://app.test' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://app.test')
    const bad = await fetch(`${base}/api/status`, { headers: { origin: 'http://evil.test' } })
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call('/api/proxy?url=http://example.com', { token: await token() })).status).toBe(404)
  })
  it('status does not leak secrets', async () => {
    const r = await call('/api/status')
    const text = JSON.stringify(r.body)
    expect(text).not.toContain('test-secret')
    expect(r.body.calendar).toEqual({ configured: true })
  })
})

describe('AI proxy', () => {
  const req = (over: Partial<AiRequest> = {}): AiRequest => ({
    mode: 'chat',
    companionId: 'grumpy',
    language: { adultEnabled: false, profanityLevel: 'none', roastIntensity: 'medium', intensity: 'balanced', revision: 0 },
    context: { nowLocal: '2026-11-24T12:00', weekday: 'Tue', tz: 'Europe/Istanbul', level: 2, quests: [], completedToday: [], calendar: null, memory: [], recentTurns: [], messages: [], replyingTo: null, documents: [] },
    message: 'Plan my afternoon',
    ...over,
  })
  it('validates output and drops unknown or invalid actions (no adult-mode tool exists)', async () => {
    const r = await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req()), token: await token() })
    expect(r.status).toBe(200)
    const resp = r.body.response as { actions: Array<{ type: string }>; droppedActions: number }
    expect(resp.actions.map((a) => a.type)).toEqual(['propose_calendar_event'])
    expect(resp.droppedActions).toBe(2)
  })
  it('rejects malformed requests and oversized payloads', async () => {
    const t = await token()
    expect((await call('/api/ai/chat', { method: 'POST', body: JSON.stringify({ ...req(), companionId: 'hal9000' }), token: t })).status).toBe(400)
    expect((await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req({ message: 'x'.repeat(600) })), token: t })).status).toBe(400)
    expect((await call('/api/ai/chat', { method: 'POST', body: 'x'.repeat(60_000), token: t })).status).toBe(413)
    expect((await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req({ mode: 'voice' })), token: t })).status).toBe(400)
  })
  it('enforces the global daily budget', async () => {
    const t = await token()
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req()), token: t })).status)
    expect(statuses).toEqual([200, 200, 200, 429])
  })
  it('returns 503 when no AI provider is configured (client shows labelled local fallback)', async () => {
    setRuntimeForTests({ cfg, ai: null })
    expect((await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req()), token: await token() })).body.error).toBe('ai_not_configured')
  })
  it('reports configured providers without secrets and rejects an unconfigured provider choice', async () => {
    const st = await call('/api/status')
    expect(st.body.ai).toEqual({ configured: true, model: 'fake-model', default: 'gemini', providers: [{ id: 'gemini', model: 'fake-model', voice: 'native' }] })
    expect(JSON.stringify(st.body)).not.toMatch(/key|secret/i)
    const t = await token()
    const r = await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req({ provider: 'anthropic' })), token: t })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('provider_not_configured')
    const ok = await call('/api/ai/chat', { method: 'POST', body: JSON.stringify(req({ provider: 'gemini' })), token: t })
    expect(ok.body.provider).toBe('gemini')
    expect(ok.body.routed).toBe(false)
  })
})

describe('Calendar link flow and actions (contract fake)', () => {
  it('links via external browser with PKCE + state, then reads minimized events', async () => {
    const t = await token()
    const cal = await connectCalendar(t)
    google.addEvent({ id: 'meet1', summary: 'Design review', start: { dateTime: iso(NOW + 15 * 60_000) }, end: { dateTime: iso(NOW + 45 * 60_000) }, attendees: [{ email: 'x@y.z' }], description: 'secret notes' })
    const r = await call(`/api/calendar/events?from=${NOW}&to=${NOW + 86400_000}`, { token: t, cal })
    expect(r.status).toBe(200)
    const events = r.body.events as Array<Record<string, unknown>>
    expect(events).toHaveLength(1)
    expect(events[0]!.title).toBe('Design review')
    expect(JSON.stringify(events)).not.toContain('secret notes')
    expect(JSON.stringify(events)).not.toContain('x@y.z')
  })

  it('wrong poll secret cannot redeem someone else\'s link', async () => {
    const t = await token()
    const start = await call('/api/calendar/link/start', { method: 'POST', body: '{}', token: t })
    const r = await call('/api/calendar/link/poll', { method: 'POST', body: JSON.stringify({ linkId: start.body.linkId, pollSecret: 'x'.repeat(32) }), token: t })
    expect(r.status).toBe(403)
  })

  it('denied consent or missing scope connects nothing', async () => {
    const t = await token()
    google.grantedScope = 'openid'
    const start = await call('/api/calendar/link/start', { method: 'POST', body: '{}', token: t })
    const redirect = await call(`/api/auth/google/start?code=${start.body.userCode}`)
    const authUrl = new URL(redirect.headers.get('location')!)
    const code = google.issueCode(authUrl.searchParams.get('code_challenge')!)
    const cb = await call(`/api/auth/google/callback?code=${code}&state=${authUrl.searchParams.get('state')}`)
    expect(cb.status).toBe(400)
    const poll = await call('/api/calendar/link/poll', { method: 'POST', body: JSON.stringify({ linkId: start.body.linkId, pollSecret: start.body.pollSecret }), token: t })
    expect(poll.body.status).toBe('denied')
    google.grantedScope = 'https://www.googleapis.com/auth/calendar.events.owned'
  })

  it('creates an event once, verifies it, and never duplicates on retry', async () => {
    const t = await token()
    const cal = await connectCalendar(t)
    const body = { proposalId: 'prop_AbCdEfGh12345', title: 'Focus: slides', start: NOW + 3600_000, end: NOW + 5400_000, timeZone: 'Europe/Istanbul' }
    const r1 = await call('/api/calendar/events', { method: 'POST', body: JSON.stringify(body), token: t, cal })
    expect(r1.status).toBe(200)
    expect(r1.body.verified).toBe(true)
    const r2 = await call('/api/calendar/events', { method: 'POST', body: JSON.stringify(body), token: t, cal })
    expect(r2.body.reconciled).toBe(true)
    expect(google.insertCalls).toBe(1)
    expect([...google.events.values()].filter((e) => e.summary === 'Focus: slides')).toHaveLength(1)
    const ev = [...google.events.values()].find((e) => e.summary === 'Focus: slides')!
    expect(ev.attendees).toBeUndefined()
  })

  it('reconciles an uncertain outcome (provider wrote, then errored) without duplicating', async () => {
    const t = await token()
    const cal = await connectCalendar(t)
    google.insertCalls = 0
    google.failNextInsertAfterWrite = true
    const body = { proposalId: 'prop_Uncertain0001', title: 'Uncertain', start: NOW + 7200_000, end: NOW + 9000_000, timeZone: 'UTC' }
    const r1 = await call('/api/calendar/events', { method: 'POST', body: JSON.stringify(body), token: t, cal })
    expect(r1.status).toBe(502) // never claims success on a provider error
    const r2 = await call('/api/calendar/events', { method: 'POST', body: JSON.stringify(body), token: t, cal })
    expect(r2.status).toBe(200)
    expect(r2.body.reconciled).toBe(true)
    expect([...google.events.values()].filter((e) => e.summary === 'Uncertain')).toHaveLength(1)
  })

  it('reschedules with etag protection and rejects stale proposals', async () => {
    const t = await token()
    const cal = await connectCalendar(t)
    google.addEvent({ id: 'mine1', summary: 'Gym', start: { dateTime: iso(NOW + 3600_000) }, end: { dateTime: iso(NOW + 7200_000) } })
    const list = await call(`/api/calendar/events?from=${NOW}&to=${NOW + 86400_000}`, { token: t, cal })
    const etag = (list.body.events as Array<{ id: string; etag: string }>).find((e) => e.id === 'mine1')!.etag
    // someone edits the event after the proposal was made
    google.events.get('mine1')!.etag = '"changed"'
    const stale = await call('/api/calendar/events', { method: 'PATCH', body: JSON.stringify({ proposalId: 'prop_Resched00001', eventId: 'mine1', expectedEtag: etag, start: NOW + 10800_000, end: NOW + 14400_000, timeZone: 'UTC' }), token: t, cal })
    expect(stale.status).toBe(409)
    const ok = await call('/api/calendar/events', { method: 'PATCH', body: JSON.stringify({ proposalId: 'prop_Resched00002', eventId: 'mine1', expectedEtag: '"changed"', start: NOW + 10800_000, end: NOW + 14400_000, timeZone: 'UTC' }), token: t, cal })
    expect(ok.status).toBe(200)
    expect(Date.parse(google.events.get('mine1')!.start.dateTime)).toBe(NOW + 10800_000)
  })

  it('maps provider errors (403/429/5xx) and invalid input without claiming success', async () => {
    const t = await token()
    const cal = await connectCalendar(t)
    for (const [status, code] of [
      [403, 'calendar_permission_missing'],
      [429, 'calendar_rate_limited'],
      [503, 'calendar_unavailable'],
    ] as const) {
      google.forceStatus = status
      const r = await call(`/api/calendar/events?from=${NOW}&to=${NOW + 3600_000}`, { token: t, cal })
      expect(r.body.error).toBe(code)
    }
    google.forceStatus = null
    const bad = await call('/api/calendar/events', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_BadDuration1', title: 'x', start: NOW + 7200_000, end: NOW + 3600_000, timeZone: 'UTC' }), token: t, cal })
    expect(bad.body.error).toBe('invalid_duration')
  })

  it('expired/revoked token → session expired; disconnect revokes', async () => {
    const t = await token()
    const cal = await connectCalendar(t)
    const d = await call('/api/calendar/disconnect', { method: 'POST', body: '{}', token: t, cal })
    expect(d.body.revoked).toBe(true)
    const after = await call(`/api/calendar/events?from=${NOW}&to=${NOW + 3600_000}`, { token: t, cal })
    expect(after.status).toBe(401)
    expect(after.body.error).toBe('calendar_session_expired')
  })
})

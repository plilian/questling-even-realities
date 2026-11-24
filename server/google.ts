import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CALENDAR_SCOPE, type ServerConfig } from './config'
import { HttpError, randomId } from './security'
import type { CalendarEvent } from '../src/shared/calendar'

/**
 * Google Calendar adapter + external-browser OAuth link flow.
 * - Auth code + PKCE (S256) + single-use state bound to a pairing record.
 * - Tokens live ONLY in this process's memory, bound to an opaque session handle.
 * - access_type=online: no refresh token; sessions expire with the access token.
 * Nothing is persisted; a restart clears every pairing and session.
 */

const LINK_TTL_MS = 10 * 60_000
const MAX_LINKS = 500
const MAX_SESSIONS = 500

interface Link {
  linkId: string
  pollSecret: string
  userCode: string
  createdAt: number
  expiresAt: number
  state: string | null
  verifier: string | null
  stateUsed: boolean
  tokens: { accessToken: string; expiresAt: number; scope: string } | null
  error: string | null
}

interface Session {
  handle: string
  accessToken: string
  expiresAt: number
  scope: string
  /** idempotency: proposalId -> verified result */
  writes: Map<string, CalendarEvent>
}

const links = new Map<string, Link>()
const codes = new Map<string, string>() // userCode -> linkId
const states = new Map<string, string>() // state -> linkId
const sessions = new Map<string, Session>()

function sweep(now = Date.now()) {
  for (const [id, l] of links) if (l.expiresAt < now) {
    links.delete(id)
    codes.delete(l.userCode)
    if (l.state) states.delete(l.state)
  }
  for (const [h, s] of sessions) if (s.expiresAt < now) sessions.delete(h)
}

export function resetGoogleStateForTests() {
  links.clear()
  codes.clear()
  states.clear()
  sessions.clear()
}

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'
function userCode(): string {
  const bytes = Buffer.from(randomId(8), 'base64url')
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

export function calendarConfigured(cfg: ServerConfig): boolean {
  return !!(cfg.googleClientId && cfg.googleClientSecret)
}

export function startLink(cfg: ServerConfig, now = Date.now()) {
  if (!calendarConfigured(cfg)) throw new HttpError(503, 'calendar_not_configured')
  sweep(now)
  if (links.size >= MAX_LINKS) throw new HttpError(429, 'too_many_pending_links')
  let code = userCode()
  while (codes.has(code)) code = userCode()
  const link: Link = { linkId: randomId(18), pollSecret: randomId(24), userCode: code, createdAt: now, expiresAt: now + LINK_TTL_MS, state: null, verifier: null, stateUsed: false, tokens: null, error: null }
  links.set(link.linkId, link)
  codes.set(code, link.linkId)
  return { linkId: link.linkId, pollSecret: link.pollSecret, userCode: code, linkUrl: `${cfg.appBaseUrl}/link`, expiresAt: link.expiresAt }
}

export function normalizeCode(input: string): string {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : ''
}

/** Build the Google authorization URL for a user code entered in a full browser. */
export function authorizeUrl(cfg: ServerConfig, rawCode: string, now = Date.now()): string {
  sweep(now)
  const linkId = codes.get(normalizeCode(rawCode))
  const link = linkId ? links.get(linkId) : undefined
  if (!link || link.expiresAt < now || link.tokens) throw new HttpError(404, 'link_code_invalid_or_expired')
  // a fresh state/verifier per attempt; previous state invalidated
  if (link.state) states.delete(link.state)
  link.state = randomId(24)
  link.verifier = randomId(48)
  link.stateUsed = false
  states.set(link.state, link.linkId)
  const challenge = createHash('sha256').update(link.verifier).digest('base64url')
  const u = new URL(cfg.google.authUrl)
  u.searchParams.set('client_id', cfg.googleClientId!)
  u.searchParams.set('redirect_uri', cfg.googleRedirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', CALENDAR_SCOPE)
  u.searchParams.set('access_type', 'online')
  u.searchParams.set('include_granted_scopes', 'false')
  u.searchParams.set('prompt', 'consent')
  u.searchParams.set('state', link.state)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  return u.toString()
}

const TokenSchema = z.object({ access_token: z.string().min(10), expires_in: z.number().int().positive(), scope: z.string().default(''), token_type: z.string() })

export async function handleCallback(cfg: ServerConfig, params: URLSearchParams, now = Date.now()): Promise<{ ok: boolean; message: string }> {
  const state = params.get('state') ?? ''
  const linkId = states.get(state)
  const link = linkId ? links.get(linkId) : undefined
  if (!link || link.state !== state || link.stateUsed || link.expiresAt < now) return { ok: false, message: 'This link has expired or was already used. Start again from Questling.' }
  link.stateUsed = true
  states.delete(state)
  if (params.get('error')) {
    link.error = 'access_denied'
    return { ok: false, message: 'Access was not granted. Nothing was connected.' }
  }
  const code = params.get('code')
  if (!code || !link.verifier) return { ok: false, message: 'Missing authorization code.' }
  const body = new URLSearchParams({
    code,
    client_id: cfg.googleClientId!,
    client_secret: cfg.googleClientSecret!,
    redirect_uri: cfg.googleRedirectUri,
    grant_type: 'authorization_code',
    code_verifier: link.verifier,
  })
  let resp: Response
  try {
    resp = await fetch(cfg.google.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) })
  } catch {
    link.error = 'token_exchange_failed'
    return { ok: false, message: 'Could not reach Google. Please try again.' }
  }
  const tok = TokenSchema.safeParse(await resp.json().catch(() => null))
  link.verifier = null
  if (!resp.ok || !tok.success) {
    link.error = 'token_exchange_failed'
    return { ok: false, message: 'Google did not accept the authorization. Please try again.' }
  }
  const granted = tok.data.scope.split(' ')
  if (!granted.includes(CALENDAR_SCOPE)) {
    link.error = 'scope_missing'
    void revoke(cfg, tok.data.access_token)
    return { ok: false, message: 'Calendar permission was not granted, so nothing was connected.' }
  }
  link.tokens = { accessToken: tok.data.access_token, expiresAt: now + tok.data.expires_in * 1000 - 60_000, scope: tok.data.scope }
  return { ok: true, message: 'Calendar connected. Return to Questling — it will finish linking automatically.' }
}

/** Single-use redemption of a completed link by the originating client (bound by pollSecret). */
export function pollLink(linkId: string, pollSecret: string, now = Date.now()):
  | { status: 'pending' | 'expired' | 'denied' }
  | { status: 'connected'; sessionHandle: string; expiresAt: number; scope: string } {
  sweep(now)
  const link = links.get(linkId)
  if (!link) return { status: 'expired' }
  if (link.pollSecret.length !== pollSecret.length || link.pollSecret !== pollSecret) throw new HttpError(403, 'poll_secret_mismatch')
  if (link.error) {
    links.delete(linkId)
    codes.delete(link.userCode)
    return { status: 'denied' }
  }
  if (!link.tokens) return { status: 'pending' }
  if (sessions.size >= MAX_SESSIONS) throw new HttpError(429, 'too_many_sessions')
  const handle = randomId(32)
  sessions.set(handle, { handle, accessToken: link.tokens.accessToken, expiresAt: link.tokens.expiresAt, scope: link.tokens.scope, writes: new Map() })
  links.delete(linkId)
  codes.delete(link.userCode)
  return { status: 'connected', sessionHandle: handle, expiresAt: link.tokens.expiresAt, scope: CALENDAR_SCOPE }
}

export function getSession(handle: string | undefined, now = Date.now()): Session {
  if (!handle) throw new HttpError(401, 'calendar_not_connected')
  const s = sessions.get(handle)
  if (!s) throw new HttpError(401, 'calendar_session_expired')
  if (s.expiresAt < now) {
    sessions.delete(handle)
    throw new HttpError(401, 'calendar_session_expired')
  }
  return s
}

async function revoke(cfg: ServerConfig, token: string): Promise<boolean> {
  try {
    const r = await fetch(cfg.google.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(8000) })
    return r.ok
  } catch {
    return false
  }
}

export async function disconnect(cfg: ServerConfig, handle: string | undefined): Promise<{ revoked: boolean }> {
  const s = handle ? sessions.get(handle) : undefined
  if (!s) return { revoked: false }
  sessions.delete(s.handle)
  return { revoked: await revoke(cfg, s.accessToken) }
}

// ---------------- Calendar API ----------------

const GEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  transparency: z.string().optional(),
  etag: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
})

function normalize(e: z.infer<typeof GEventSchema>, calendarId: string): CalendarEvent | null {
  const allDay = !!e.start?.date && !e.start?.dateTime
  const start = e.start?.dateTime ? Date.parse(e.start.dateTime) : e.start?.date ? Date.parse(`${e.start.date}T00:00:00Z`) : NaN
  const end = e.end?.dateTime ? Date.parse(e.end.dateTime) : e.end?.date ? Date.parse(`${e.end.date}T00:00:00Z`) : NaN
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const status = e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed'
  return {
    id: e.id,
    calendarId,
    title: (e.summary ?? '(no title)').slice(0, 200),
    start,
    end,
    allDay,
    status,
    transparent: e.transparency === 'transparent',
    timeZone: e.start?.timeZone,
    etag: e.etag,
    createdByQuestling: e.extendedProperties?.private?.questling === '1',
  }
}

async function gfetch(cfg: ServerConfig, s: Session, path: string, init: RequestInit = {}): Promise<Response> {
  let r: Response
  try {
    r = await fetch(`${cfg.google.calendarBase}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${s.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HttpError(504, 'calendar_timeout')
  }
  if (r.status === 401) {
    sessions.delete(s.handle)
    throw new HttpError(401, 'calendar_session_expired')
  }
  if (r.status === 403) throw new HttpError(403, 'calendar_permission_missing')
  if (r.status === 429) throw new HttpError(429, 'calendar_rate_limited')
  if (r.status >= 500) throw new HttpError(502, 'calendar_unavailable')
  return r
}

export async function listEvents(cfg: ServerConfig, s: Session, from: number, to: number): Promise<CalendarEvent[]> {
  if (!(to > from) || to - from > 14 * 86400_000) throw new HttpError(400, 'invalid_window')
  const q = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
    // data minimization: no attendees, descriptions, locations, conference data
    fields: 'items(id,status,summary,transparency,etag,start,end,extendedProperties/private)',
  })
  const r = await gfetch(cfg, s, `/calendars/primary/events?${q}`)
  if (!r.ok) throw new HttpError(502, 'calendar_bad_response')
  const body = z.object({ items: z.array(z.unknown()).default([]) }).safeParse(await r.json().catch(() => null))
  if (!body.success) throw new HttpError(502, 'calendar_malformed_response')
  const out: CalendarEvent[] = []
  for (const it of body.data.items) {
    const p = GEventSchema.safeParse(it)
    if (!p.success) continue
    const n = normalize(p.data, 'primary')
    if (n) out.push(n)
  }
  return out
}

/** Calendar event ids must be base32hex [a-v0-9], 5–1024 chars. Derived deterministically from the proposal id. */
export function eventIdForProposal(proposalId: string): string {
  return 'qst' + createHash('sha256').update(proposalId).digest('hex').slice(0, 40)
}

export const CreateEventSchema = z.object({
  proposalId: z.string().regex(/^prop_[A-Za-z0-9]{8,40}$/),
  title: z.string().trim().min(1).max(100),
  start: z.number().int(),
  end: z.number().int(),
  timeZone: z.string().min(1).max(64),
})

async function getEvent(cfg: ServerConfig, s: Session, id: string): Promise<CalendarEvent | null> {
  const r = await gfetch(cfg, s, `/calendars/primary/events/${encodeURIComponent(id)}?fields=id,status,summary,transparency,etag,start,end,extendedProperties/private`)
  if (r.status === 404 || r.status === 410) return null
  if (!r.ok) throw new HttpError(502, 'calendar_bad_response')
  const p = GEventSchema.safeParse(await r.json().catch(() => null))
  return p.success ? normalize(p.data, 'primary') : null
}

export async function createEvent(cfg: ServerConfig, s: Session, input: z.infer<typeof CreateEventSchema>, now = Date.now()): Promise<{ event: CalendarEvent; reconciled: boolean }> {
  if (!(input.end > input.start)) throw new HttpError(400, 'invalid_duration')
  if (input.end - input.start > 8 * 3600_000) throw new HttpError(400, 'duration_too_long')
  if (input.start < now - 5 * 60_000 || input.start > now + 60 * 86400_000) throw new HttpError(400, 'start_out_of_range')
  const prior = s.writes.get(input.proposalId)
  if (prior) return { event: prior, reconciled: true }
  const id = eventIdForProposal(input.proposalId)
  const body = {
    id,
    summary: input.title,
    start: { dateTime: new Date(input.start).toISOString(), timeZone: input.timeZone },
    end: { dateTime: new Date(input.end).toISOString(), timeZone: input.timeZone },
    // no attendees are ever added; app marker for reconciliation
    extendedProperties: { private: { questling: '1' } },
    reminders: { useDefault: true },
  }
  const r = await gfetch(cfg, s, `/calendars/primary/events?sendUpdates=none`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let reconciled = false
  if (r.status === 409) reconciled = true // already created by an earlier attempt — reconcile, never duplicate
  else if (!r.ok) throw new HttpError(502, 'calendar_create_failed')
  // Verify by reading the event back from the provider.
  const verified = await getEvent(cfg, s, id)
  if (!verified || verified.status === 'cancelled') throw new HttpError(502, 'calendar_create_unverified')
  if (verified.start !== input.start || verified.end !== input.end) {
    if (!reconciled) throw new HttpError(502, 'calendar_create_mismatch')
  }
  s.writes.set(input.proposalId, verified)
  return { event: verified, reconciled }
}

export const UpdateEventSchema = z.object({
  proposalId: z.string().regex(/^prop_[A-Za-z0-9]{8,40}$/),
  eventId: z.string().min(1).max(1024),
  expectedEtag: z.string().max(200).optional(),
  start: z.number().int(),
  end: z.number().int(),
  timeZone: z.string().min(1).max(64),
})

export async function updateEvent(cfg: ServerConfig, s: Session, input: z.infer<typeof UpdateEventSchema>, now = Date.now()) {
  if (!(input.end > input.start)) throw new HttpError(400, 'invalid_duration')
  if (input.start < now - 5 * 60_000) throw new HttpError(400, 'start_in_past')
  const prior = s.writes.get(input.proposalId)
  if (prior) return { event: prior, reconciled: true }
  const current = await getEvent(cfg, s, input.eventId)
  if (!current) throw new HttpError(404, 'event_not_found')
  if (input.expectedEtag && current.etag && current.etag !== input.expectedEtag) throw new HttpError(409, 'event_changed_since_proposal')
  const body = {
    start: { dateTime: new Date(input.start).toISOString(), timeZone: input.timeZone },
    end: { dateTime: new Date(input.end).toISOString(), timeZone: input.timeZone },
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (current.etag) headers['if-match'] = current.etag
  const r = await gfetch(cfg, s, `/calendars/primary/events/${encodeURIComponent(input.eventId)}?sendUpdates=none`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  if (r.status === 412) throw new HttpError(409, 'event_changed_since_proposal')
  if (!r.ok) throw new HttpError(502, 'calendar_update_failed')
  const verified = await getEvent(cfg, s, input.eventId)
  if (!verified || verified.start !== input.start || verified.end !== input.end) throw new HttpError(502, 'calendar_update_unverified')
  s.writes.set(input.proposalId, verified)
  return { event: verified, reconciled: false }
}

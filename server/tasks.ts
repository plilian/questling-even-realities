import { createHash } from 'node:crypto'
import { z } from 'zod'
import { excerpt, keywords, matchScore, type NoteHit } from '../src/shared/notes'
import { GMAIL_METADATA_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_TASKS_SCOPE, type ServerConfig } from './config'
import { HttpError, randomId } from './security'
import { parseDue, type ExternalTask, type TaskProviderId, type TaskSource } from '../src/shared/tasks'
import type { InboxItem, MessageProviderId } from '../src/shared/messages'
import type { TelegramState } from './telegram'

/** Every account Questling can link through the shared /link page besides Calendar. */
export type LinkProviderId = TaskProviderId | MessageProviderId
const LABELS: Record<LinkProviderId, string> = { todoist: 'Todoist', notion: 'Notion', google_tasks: 'Google Tasks', gmail: 'Gmail', slack: 'Slack', telegram: 'Telegram', github: 'GitHub' }
const GOOGLE_LINKS: readonly LinkProviderId[] = ['google_tasks', 'gmail']

/**
 * Task integrations: Todoist, Notion and Google Tasks.
 *
 * Same security model as Calendar:
 *  - external-browser link with a short user code, single-use state (+ PKCE where the provider supports it),
 *  - access tokens live ONLY in this process's memory, bound to an opaque session handle (max 12 h),
 *  - refresh tokens are never requested or kept; a restart clears everything,
 *  - reads are minimized (id, title, due, done, list name); the only write is "mark done", and only
 *    after the user confirms it in the app; every write is read back and verified.
 */

const LINK_TTL_MS = 10 * 60_000
const SESSION_MAX_MS = 12 * 3600_000
const MAX_LINKS = 500
const MAX_SESSIONS = 500

interface Link {
  linkId: string
  provider: LinkProviderId
  pollSecret: string
  userCode: string
  expiresAt: number
  state: string | null
  verifier: string | null
  stateUsed: boolean
  token: { accessToken: string; expiresAt: number; label: string; canSend: boolean; userId?: string; botUsername?: string } | null
  error: string | null
}

interface NotionShape {
  dataSourceId: string
  name: string
  titleProp: string
  done: { prop: string; type: 'checkbox' } | { prop: string; type: 'status'; doneName: string; doneNames: string[] }
  dueProp: string | null
}

export interface TaskSession {
  handle: string
  provider: LinkProviderId
  accessToken: string
  expiresAt: number
  label: string
  writes: Map<string, ExternalTask>
  notion?: NotionShape
  /** messages: whether a send/write scope was granted, own user id (Slack), reply idempotency */
  canSend: boolean
  userId?: string
  sent: Map<string, { id: string; to: string; at: number }>
  names: Map<string, string>
  /** Telegram: the user's own bot, its update offset and a small in-memory message buffer */
  telegram?: TelegramState
}

const links = new Map<string, Link>()
const codes = new Map<string, string>()
const states = new Map<string, string>()
const sessions = new Map<string, TaskSession>()

export function resetTaskStateForTests() {
  links.clear()
  codes.clear()
  states.clear()
  sessions.clear()
}

function sweep(now = Date.now()) {
  for (const [id, l] of links)
    if (l.expiresAt < now) {
      links.delete(id)
      codes.delete(l.userCode)
      if (l.state) states.delete(l.state)
    }
  for (const [h, s] of sessions) if (s.expiresAt < now) sessions.delete(h)
}

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'
function userCode(): string {
  const bytes = Buffer.from(randomId(8), 'base64url')
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}
function normalizeCode(input: string): string {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : ''
}

export function taskProvidersConfigured(cfg: ServerConfig): Record<TaskProviderId, boolean> {
  return {
    todoist: !!(cfg.todoist.clientId && cfg.todoist.clientSecret),
    notion: !!(cfg.notion.clientId && cfg.notion.clientSecret),
    google_tasks: cfg.googleTasksEnabled && !!(cfg.googleClientId && cfg.googleClientSecret),
  }
}

export function messageProvidersConfigured(cfg: ServerConfig): Record<MessageProviderId, boolean> {
  return {
    gmail: cfg.gmailEnabled && !!(cfg.googleClientId && cfg.googleClientSecret),
    slack: !!(cfg.slack.clientId && cfg.slack.clientSecret),
    // Telegram needs no OAuth app: each user brings their own bot token on the /link page
    telegram: cfg.telegram.enabled,
    github: cfg.github.enabled,
  }
}

function linkConfigured(cfg: ServerConfig, provider: LinkProviderId): boolean {
  return provider === 'gmail' || provider === 'slack' || provider === 'telegram' || provider === 'github' ? messageProvidersConfigured(cfg)[provider] : taskProvidersConfigured(cfg)[provider]
}

export function redirectUri(cfg: ServerConfig, provider: LinkProviderId): string {
  // Google Tasks and Gmail reuse the Calendar redirect URI, so no extra Google Cloud setup is needed.
  return GOOGLE_LINKS.includes(provider) ? cfg.googleRedirectUri : `${cfg.appBaseUrl}/api/auth/${provider}/callback`
}

// ---------------------------------------------------------------- link flow

export function startTaskLink(cfg: ServerConfig, provider: LinkProviderId, now = Date.now()) {
  if (!linkConfigured(cfg, provider)) throw new HttpError(503, 'integration_not_configured')
  sweep(now)
  if (links.size >= MAX_LINKS) throw new HttpError(429, 'too_many_pending_links')
  let code = userCode()
  while (codes.has(code)) code = userCode()
  const link: Link = { linkId: randomId(18), provider, pollSecret: randomId(24), userCode: code, expiresAt: now + LINK_TTL_MS, state: null, verifier: null, stateUsed: false, token: null, error: null }
  links.set(link.linkId, link)
  codes.set(code, link.linkId)
  return { linkId: link.linkId, pollSecret: link.pollSecret, userCode: code, linkUrl: `${cfg.appBaseUrl}/link`, expiresAt: link.expiresAt }
}

export function isTaskCode(raw: string): boolean {
  return codes.has(normalizeCode(raw))
}

/** The provider a pending user code belongs to (the /link page shows a token form for Telegram). */
export function linkProviderForCode(raw: string, now = Date.now()): LinkProviderId | null {
  sweep(now)
  const id = codes.get(normalizeCode(raw))
  const link = id ? links.get(id) : undefined
  return link && !link.token && link.expiresAt >= now ? link.provider : null
}

/** Completes a link that needs no OAuth redirect (Telegram bot token pasted on the /link page). */
export function completeDirectLink(raw: string, provider: LinkProviderId, token: NonNullable<Link['token']>, now = Date.now()): boolean {
  sweep(now)
  const id = codes.get(normalizeCode(raw))
  const link = id ? links.get(id) : undefined
  if (!link || link.provider !== provider || link.token || link.expiresAt < now) return false
  link.token = { ...token, expiresAt: Math.min(token.expiresAt, now + SESSION_MAX_MS) }
  return true
}
export function isTaskState(state: string | null): boolean {
  return !!state && states.has(state)
}

/** Which provider a pending OAuth state belongs to (Google Tasks and Gmail share a redirect URI). */
export function providerForState(state: string | null): LinkProviderId | null {
  const id = state ? states.get(state) : undefined
  return id ? (links.get(id)?.provider ?? null) : null
}

export function taskAuthorizeUrl(cfg: ServerConfig, rawCode: string, now = Date.now()): string {
  sweep(now)
  const linkId = codes.get(normalizeCode(rawCode))
  const link = linkId ? links.get(linkId) : undefined
  if (!link || link.expiresAt < now || link.token) throw new HttpError(404, 'link_code_invalid_or_expired')
  if (link.state) states.delete(link.state)
  link.state = randomId(24)
  link.verifier = randomId(48)
  link.stateUsed = false
  states.set(link.state, link.linkId)
  if (link.provider === 'google_tasks' || link.provider === 'gmail') {
    const u = new URL(cfg.google.authUrl)
    u.searchParams.set('client_id', cfg.googleClientId!)
    u.searchParams.set('redirect_uri', redirectUri(cfg, link.provider))
    u.searchParams.set('response_type', 'code')
    // Gmail: headers only (no message bodies) + send; never modify, delete or read full mail
    u.searchParams.set('scope', link.provider === 'gmail' ? `${GMAIL_METADATA_SCOPE} ${GMAIL_SEND_SCOPE}` : GOOGLE_TASKS_SCOPE)
    u.searchParams.set('access_type', 'online')
    u.searchParams.set('include_granted_scopes', 'false')
    u.searchParams.set('prompt', 'consent')
    u.searchParams.set('state', link.state)
    u.searchParams.set('code_challenge', createHash('sha256').update(link.verifier).digest('base64url'))
    u.searchParams.set('code_challenge_method', 'S256')
    return u.toString()
  }
  if (link.provider === 'slack') {
    const u = new URL(cfg.slack.authUrl)
    u.searchParams.set('client_id', cfg.slack.clientId!)
    // user token: find mentions of you, post replies you confirm, and resolve names
    u.searchParams.set('user_scope', 'search:read,chat:write,users:read')
    u.searchParams.set('redirect_uri', redirectUri(cfg, 'slack'))
    u.searchParams.set('state', link.state)
    return u.toString()
  }
  if (link.provider === 'todoist') {
    const u = new URL(cfg.todoist.authUrl)
    u.searchParams.set('client_id', cfg.todoist.clientId!)
    // least privilege that still allows "mark done"
    u.searchParams.set('scope', 'data:read_write')
    u.searchParams.set('state', link.state)
    return u.toString()
  }
  const u = new URL(cfg.notion.authUrl)
  u.searchParams.set('client_id', cfg.notion.clientId!)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('owner', 'user')
  u.searchParams.set('redirect_uri', redirectUri(cfg, 'notion'))
  u.searchParams.set('state', link.state)
  return u.toString()
}

const GoogleToken = z.object({ access_token: z.string().min(10), expires_in: z.number().int().positive(), scope: z.string().default('') })
const TodoistToken = z.object({ access_token: z.string().min(10), token_type: z.string().optional() })
const NotionToken = z.object({ access_token: z.string().min(10), expires_in: z.number().int().positive().optional(), workspace_name: z.string().nullish() })

async function postForm(url: string, body: URLSearchParams, headers: Record<string, string> = {}): Promise<{ ok: boolean; json: unknown }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body, signal: AbortSignal.timeout(10_000) })
    return { ok: r.ok, json: await r.json().catch(() => null) }
  } catch {
    return { ok: false, json: null }
  }
}

function basic(id: string, secret: string) {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
}

const SlackToken = z.object({
  ok: z.literal(true),
  authed_user: z.object({ id: z.string(), scope: z.string().default(''), access_token: z.string().min(10), expires_in: z.number().int().positive().optional() }),
  team: z.object({ name: z.string().nullish() }).nullish(),
})

export async function handleTaskCallback(cfg: ServerConfig, provider: LinkProviderId, params: URLSearchParams, now = Date.now()): Promise<{ ok: boolean; message: string }> {
  const state = params.get('state') ?? ''
  const linkId = states.get(state)
  const link = linkId ? links.get(linkId) : undefined
  if (!link || link.provider !== provider || link.state !== state || link.stateUsed || link.expiresAt < now) return { ok: false, message: 'This link has expired or was already used. Start again from Questling.' }
  link.stateUsed = true
  states.delete(state)
  const label = LABELS[provider]
  if (params.get('error')) {
    link.error = 'access_denied'
    return { ok: false, message: 'Access was not granted. Nothing was connected.' }
  }
  const code = params.get('code')
  const verifier = link.verifier
  link.verifier = null
  if (!code || !verifier) return { ok: false, message: 'Missing authorization code.' }
  const cap = (ms: number) => Math.min(now + ms, now + SESSION_MAX_MS)
  if (provider === 'google_tasks' || provider === 'gmail') {
    const r = await postForm(cfg.google.tokenUrl, new URLSearchParams({ code, client_id: cfg.googleClientId!, client_secret: cfg.googleClientSecret!, redirect_uri: redirectUri(cfg, provider), grant_type: 'authorization_code', code_verifier: verifier }))
    const t = GoogleToken.safeParse(r.json)
    if (!r.ok || !t.success) return fail(link, 'Google did not accept the authorization. Please try again.')
    const granted = t.data.scope.split(' ')
    const needed = provider === 'gmail' ? GMAIL_METADATA_SCOPE : GOOGLE_TASKS_SCOPE
    if (!granted.includes(needed)) return fail(link, `${label} permission was not granted, so nothing was connected.`)
    const canSend = provider === 'gmail' ? granted.includes(GMAIL_SEND_SCOPE) : true
    link.token = { accessToken: t.data.access_token, expiresAt: cap(t.data.expires_in * 1000 - 60_000), label: provider === 'gmail' ? (canSend ? 'Gmail · Inbox' : 'Gmail · Inbox (read only)') : 'Google Tasks · My Tasks', canSend }
  } else if (provider === 'slack') {
    const r = await postForm(`${cfg.slack.apiBase}/oauth.v2.access`, new URLSearchParams({ client_id: cfg.slack.clientId!, client_secret: cfg.slack.clientSecret!, code, redirect_uri: redirectUri(cfg, 'slack') }))
    const t = SlackToken.safeParse(r.json)
    if (!r.ok || !t.success) return fail(link, 'Slack did not accept the authorization. Please try again.')
    const scopes = t.data.authed_user.scope.split(',')
    if (!scopes.includes('search:read')) return fail(link, 'Slack search permission was not granted, so nothing was connected.')
    const team = t.data.team?.name ? ` · ${t.data.team.name.slice(0, 40)}` : ''
    link.token = {
      accessToken: t.data.authed_user.access_token,
      expiresAt: cap(t.data.authed_user.expires_in ? t.data.authed_user.expires_in * 1000 - 60_000 : SESSION_MAX_MS),
      label: `Slack${team}`,
      canSend: scopes.includes('chat:write'),
      userId: t.data.authed_user.id,
    }
  } else if (provider === 'todoist') {
    const r = await postForm(cfg.todoist.tokenUrl, new URLSearchParams({ client_id: cfg.todoist.clientId!, client_secret: cfg.todoist.clientSecret!, code }))
    const t = TodoistToken.safeParse(r.json)
    if (!r.ok || !t.success) return fail(link, 'Todoist did not accept the authorization. Please try again.')
    link.token = { accessToken: t.data.access_token, expiresAt: cap(SESSION_MAX_MS), label: 'Todoist', canSend: true }
  } else {
    let resp: { ok: boolean; json: unknown }
    try {
      const r = await fetch(`${cfg.notion.apiBase}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: basic(cfg.notion.clientId!, cfg.notion.clientSecret!), 'notion-version': cfg.notion.version },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(cfg, 'notion') }),
        signal: AbortSignal.timeout(10_000),
      })
      resp = { ok: r.ok, json: await r.json().catch(() => null) }
    } catch {
      resp = { ok: false, json: null }
    }
    const t = NotionToken.safeParse(resp.json)
    if (!resp.ok || !t.success) return fail(link, 'Notion did not accept the authorization. Please try again.')
    link.token = { accessToken: t.data.access_token, expiresAt: cap(t.data.expires_in ? t.data.expires_in * 1000 - 60_000 : SESSION_MAX_MS), label: t.data.workspace_name ? `Notion · ${t.data.workspace_name.slice(0, 40)}` : 'Notion', canSend: true }
  }
  return { ok: true, message: `${label} connected. Return to Questling — it will finish linking automatically.` }
}

function fail(link: Link, message: string) {
  link.error = 'token_exchange_failed'
  return { ok: false, message }
}

export function pollTaskLink(linkId: string, pollSecret: string, now = Date.now()):
  | { status: 'pending' | 'expired' | 'denied' }
  | { status: 'connected'; sessionHandle: string; expiresAt: number; provider: LinkProviderId; label: string; canSend: boolean } {
  sweep(now)
  const link = links.get(linkId)
  if (!link) return { status: 'expired' }
  if (link.pollSecret.length !== pollSecret.length || link.pollSecret !== pollSecret) throw new HttpError(403, 'poll_secret_mismatch')
  if (link.error) {
    links.delete(linkId)
    codes.delete(link.userCode)
    return { status: 'denied' }
  }
  if (!link.token) return { status: 'pending' }
  if (sessions.size >= MAX_SESSIONS) throw new HttpError(429, 'too_many_sessions')
  const handle = randomId(32)
  sessions.set(handle, {
    handle,
    provider: link.provider,
    accessToken: link.token.accessToken,
    expiresAt: link.token.expiresAt,
    label: link.token.label,
    writes: new Map(),
    canSend: link.token.canSend,
    userId: link.token.userId,
    sent: new Map(),
    names: new Map(),
    ...(link.provider === 'telegram' ? { telegram: { botId: Number(link.token.userId), botUsername: link.token.botUsername ?? 'bot', offset: 0, items: new Map(), connections: new Map() } } : {}),
  })
  links.delete(linkId)
  codes.delete(link.userCode)
  return { status: 'connected', sessionHandle: handle, expiresAt: link.token.expiresAt, provider: link.provider, label: link.token.label, canSend: link.token.canSend }
}

export function getTaskSession(handle: string | undefined, now = Date.now()): TaskSession {
  if (!handle) throw new HttpError(401, 'tasks_not_connected')
  const s = sessions.get(handle)
  if (!s || s.expiresAt < now) {
    if (s) sessions.delete(handle)
    throw new HttpError(401, 'tasks_session_expired')
  }
  return s
}

export async function disconnectTasks(cfg: ServerConfig, handle: string | undefined): Promise<{ revoked: boolean }> {
  const s = handle ? sessions.get(handle) : undefined
  if (!s) return { revoked: false }
  sessions.delete(s.handle)
  // Telegram: the token is the user's own bot; Questling forgets it (revoke it in @BotFather → /revoke if wanted)
  if (s.provider === 'telegram' || s.provider === 'github') return { revoked: false }
  try {
    if (s.provider === 'slack') {
      const r = await fetch(`${cfg.slack.apiBase}/auth.revoke`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '', signal: AbortSignal.timeout(8000) })
      const b = (await r.json().catch(() => null)) as { ok?: boolean } | null
      return { revoked: r.ok && !!b?.ok }
    }
    if (s.provider === 'google_tasks' || s.provider === 'gmail') {
      const r = await fetch(cfg.google.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: s.accessToken }), signal: AbortSignal.timeout(8000) })
      return { revoked: r.ok }
    }
    if (s.provider === 'notion') {
      const r = await fetch(`${cfg.notion.apiBase}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: basic(cfg.notion.clientId!, cfg.notion.clientSecret!), 'notion-version': cfg.notion.version },
        body: JSON.stringify({ token: s.accessToken }),
        signal: AbortSignal.timeout(8000),
      })
      return { revoked: r.ok }
    }
    // Todoist API v1: DELETE /access_tokens (as in Doist's official client). Server-to-Todoist only; never logged.
    const q = new URLSearchParams({ client_id: cfg.todoist.clientId!, client_secret: cfg.todoist.clientSecret!, access_token: s.accessToken })
    const r = await fetch(`${cfg.todoist.apiBase}/access_tokens?${q}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) })
    return { revoked: r.ok }
  } catch {
    return { revoked: false }
  }
}

// ---------------------------------------------------------------- provider HTTP

export async function pfetch(s: TaskSession, url: string, init: RequestInit & { extraHeaders?: Record<string, string> } = {}): Promise<Response> {
  let r: Response
  try {
    r = await fetch(url, {
      method: init.method,
      body: init.body,
      headers: { accept: 'application/json', authorization: `Bearer ${s.accessToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.extraHeaders ?? {}) },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HttpError(504, 'tasks_timeout')
  }
  if (r.status === 401) {
    sessions.delete(s.handle)
    throw new HttpError(401, 'tasks_session_expired')
  }
  if (r.status === 403) throw new HttpError(403, 'tasks_permission_missing')
  if (r.status === 429) throw new HttpError(429, 'tasks_rate_limited')
  if (r.status >= 500) throw new HttpError(502, 'tasks_unavailable')
  return r
}

async function body<T>(r: Response, schema: z.ZodType<T>, code = 'tasks_malformed_response'): Promise<T> {
  const p = schema.safeParse(await r.json().catch(() => null))
  if (!p.success) throw new HttpError(502, code)
  return p.data
}

const MAX_TASKS = 60

// ---- Todoist (API v1)

const TodoistTask = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  content: z.string(),
  checked: z.boolean().optional(),
  is_completed: z.boolean().optional(),
  due: z.object({ date: z.string(), datetime: z.string().nullish(), is_recurring: z.boolean().optional() }).nullish(),
})
type TodoistTaskT = z.infer<typeof TodoistTask>

function fromTodoist(t: TodoistTaskT): ExternalTask {
  const d = parseDue(t.due?.datetime || t.due?.date)
  return { id: t.id, title: t.content.slice(0, 200), ...d, done: !!(t.checked ?? t.is_completed), recurring: !!t.due?.is_recurring }
}

async function todoistList(cfg: ServerConfig, s: TaskSession): Promise<ExternalTask[]> {
  const r = await pfetch(s, `${cfg.todoist.apiBase}/tasks?limit=100`)
  if (!r.ok) throw new HttpError(502, 'tasks_bad_response')
  const b = await body(r, z.union([z.object({ results: z.array(z.unknown()) }), z.array(z.unknown())]))
  const items = Array.isArray(b) ? b : b.results
  return items.flatMap((it) => {
    const p = TodoistTask.safeParse(it)
    return p.success ? [fromTodoist(p.data)] : []
  })
}

async function todoistComplete(cfg: ServerConfig, s: TaskSession, taskId: string, proposalId: string): Promise<{ task: ExternalTask; note: string | null }> {
  const before = await pfetch(s, `${cfg.todoist.apiBase}/tasks/${encodeURIComponent(taskId)}`)
  if (before.status === 404) throw new HttpError(404, 'task_not_found')
  const prior = fromTodoist(await body(before, TodoistTask))
  if (prior.done) return { task: prior, note: 'Already done in Todoist.' }
  const r = await pfetch(s, `${cfg.todoist.apiBase}/tasks/${encodeURIComponent(taskId)}/close`, { method: 'POST', extraHeaders: { 'x-request-id': proposalId } })
  if (!r.ok) throw new HttpError(502, 'task_complete_failed')
  // verify: a closed task reads back checked (or is no longer active); a recurring one moves to its next date
  const after = await pfetch(s, `${cfg.todoist.apiBase}/tasks/${encodeURIComponent(taskId)}`)
  if (after.status === 404) return { task: { ...prior, done: true }, note: null }
  const t = fromTodoist(await body(after, TodoistTask))
  if (t.done) return { task: t, note: null }
  if (prior.recurring && t.due !== prior.due) return { task: t, note: 'Recurring task — this occurrence is done; the next one is scheduled.' }
  throw new HttpError(502, 'task_complete_unverified')
}

// ---- Google Tasks (default list)

const GTask = z.object({ id: z.string(), title: z.string().default(''), status: z.string().default('needsAction'), due: z.string().nullish(), deleted: z.boolean().optional(), hidden: z.boolean().optional() })
function fromGTask(t: z.infer<typeof GTask>): ExternalTask {
  // Google Tasks keeps only the date of "due"; the time part is always midnight UTC and must be ignored.
  const d = parseDue(t.due ? t.due.slice(0, 10) : null)
  return { id: t.id, title: (t.title || '(untitled)').slice(0, 200), ...d, done: t.status === 'completed', recurring: false, list: 'My Tasks' }
}

async function gtasksList(cfg: ServerConfig, s: TaskSession): Promise<ExternalTask[]> {
  const q = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100', fields: 'items(id,title,status,due,deleted,hidden)' })
  const r = await pfetch(s, `${cfg.googleTasksBase}/lists/@default/tasks?${q}`)
  if (!r.ok) throw new HttpError(502, 'tasks_bad_response')
  const b = await body(r, z.object({ items: z.array(z.unknown()).default([]) }))
  return b.items.flatMap((it) => {
    const p = GTask.safeParse(it)
    return p.success && !p.data.deleted ? [fromGTask(p.data)] : []
  })
}

async function gtasksComplete(cfg: ServerConfig, s: TaskSession, taskId: string): Promise<{ task: ExternalTask; note: string | null }> {
  const url = `${cfg.googleTasksBase}/lists/@default/tasks/${encodeURIComponent(taskId)}`
  const before = await pfetch(s, url)
  if (before.status === 404) throw new HttpError(404, 'task_not_found')
  const prior = fromGTask(await body(before, GTask))
  if (prior.done) return { task: prior, note: 'Already done in Google Tasks.' }
  const r = await pfetch(s, url, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) })
  if (!r.ok) throw new HttpError(502, 'task_complete_failed')
  const after = await pfetch(s, url)
  const t = fromGTask(await body(after, GTask))
  if (!t.done) throw new HttpError(502, 'task_complete_unverified')
  return { task: t, note: null }
}

// ---- Notion (API 2025-09-03: data sources)

const RichText = z.array(z.object({ plain_text: z.string().default('') })).default([])
const PropSchema = z.object({ type: z.string() }).passthrough()
const DataSource = z.object({ id: z.string(), title: RichText, properties: z.record(z.string(), PropSchema).default({}) })

function notionHeaders(cfg: ServerConfig) {
  return { 'notion-version': cfg.notion.version }
}

/** Work out which properties mean title / done / due. Returns null if the data source can't hold tasks. */
export function notionShape(ds: z.infer<typeof DataSource>): NotionShape | null {
  const entries = Object.entries(ds.properties)
  const title = entries.find(([, p]) => p.type === 'title')?.[0]
  if (!title) return null
  const name = ds.title.map((t) => t.plain_text).join('').slice(0, 120) || 'Untitled'
  const due = entries.find(([n, p]) => p.type === 'date' && /due|date|deadline|when/i.test(n))?.[0] ?? entries.find(([, p]) => p.type === 'date')?.[0] ?? null
  const checkbox = entries.find(([n, p]) => p.type === 'checkbox' && /done|complete|finished|check/i.test(n)) ?? entries.find(([, p]) => p.type === 'checkbox')
  if (checkbox) return { dataSourceId: ds.id, name, titleProp: title, done: { prop: checkbox[0], type: 'checkbox' }, dueProp: due }
  const status = entries.find(([, p]) => p.type === 'status')
  if (status) {
    const st = z
      .object({ status: z.object({ options: z.array(z.object({ id: z.string(), name: z.string() })).default([]), groups: z.array(z.object({ name: z.string(), option_ids: z.array(z.string()).default([]) })).default([]) }) })
      .safeParse(status[1])
    if (st.success) {
      const group = st.data.status.groups.find((g) => /complete|done/i.test(g.name))
      const doneNames = st.data.status.options.filter((o) => group?.option_ids.includes(o.id) || /^(done|complete|completed)$/i.test(o.name)).map((o) => o.name)
      if (doneNames.length) return { dataSourceId: ds.id, name, titleProp: title, done: { prop: status[0], type: 'status', doneName: doneNames[0]!, doneNames }, dueProp: due }
    }
  }
  return null
}

async function notionSources(cfg: ServerConfig, s: TaskSession): Promise<{ sources: TaskSource[]; shapes: Map<string, NotionShape | null> }> {
  const r = await pfetch(s, `${cfg.notion.apiBase}/search`, { method: 'POST', body: JSON.stringify({ filter: { property: 'object', value: 'data_source' }, page_size: 20 }), extraHeaders: notionHeaders(cfg) })
  if (!r.ok) throw new HttpError(502, 'tasks_bad_response')
  const b = await body(r, z.object({ results: z.array(z.unknown()).default([]) }))
  const shapes = new Map<string, NotionShape | null>()
  const sources: TaskSource[] = []
  for (const it of b.results) {
    const p = DataSource.safeParse(it)
    if (!p.success) continue
    const shape = notionShape(p.data)
    shapes.set(p.data.id, shape)
    sources.push({ id: p.data.id, name: shape?.name ?? (p.data.title.map((t) => t.plain_text).join('').slice(0, 120) || 'Untitled'), writable: !!shape })
  }
  return { sources, shapes }
}

const NotionPage = z.object({ id: z.string(), in_trash: z.boolean().optional(), archived: z.boolean().optional(), properties: z.record(z.string(), PropSchema).default({}) })

function fromNotion(page: z.infer<typeof NotionPage>, shape: NotionShape): ExternalTask {
  const props = page.properties
  const titleProp = props[shape.titleProp] as { title?: Array<{ plain_text?: string }> } | undefined
  const title = (titleProp?.title ?? []).map((t) => t.plain_text ?? '').join('').slice(0, 200) || 'Untitled'
  const doneProp = props[shape.done.prop] as { checkbox?: boolean; status?: { name?: string } | null } | undefined
  const done = shape.done.type === 'checkbox' ? !!doneProp?.checkbox : !!doneProp?.status?.name && shape.done.doneNames.includes(doneProp.status.name)
  const dueProp = shape.dueProp ? (props[shape.dueProp] as { date?: { start?: string } | null } | undefined) : undefined
  return { id: page.id, title, ...parseDue(dueProp?.date?.start ?? null), done, recurring: false, list: shape.name }
}

async function notionList(cfg: ServerConfig, s: TaskSession, sourceId: string | null): Promise<{ tasks: ExternalTask[]; sources: TaskSource[]; selected: string | null }> {
  const { sources, shapes } = await notionSources(cfg, s)
  const pick = (sourceId && shapes.get(sourceId)) || (s.notion && shapes.get(s.notion.dataSourceId)) || [...shapes.values()].find(Boolean) || null
  if (!pick) {
    s.notion = undefined
    return { tasks: [], sources, selected: null }
  }
  s.notion = pick
  const filter = pick.done.type === 'checkbox' ? { property: pick.done.prop, checkbox: { equals: false } } : { and: pick.done.doneNames.map((n) => ({ property: pick.done.prop, status: { does_not_equal: n } })) }
  const r = await pfetch(s, `${cfg.notion.apiBase}/data_sources/${encodeURIComponent(pick.dataSourceId)}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100, filter }), extraHeaders: notionHeaders(cfg) })
  if (!r.ok) throw new HttpError(502, 'tasks_bad_response')
  const b = await body(r, z.object({ results: z.array(z.unknown()).default([]) }))
  const tasks = b.results.flatMap((it) => {
    const p = NotionPage.safeParse(it)
    return p.success && !p.data.in_trash && !p.data.archived ? [fromNotion(p.data, pick)] : []
  })
  return { tasks, sources, selected: pick.dataSourceId }
}

async function notionComplete(cfg: ServerConfig, s: TaskSession, taskId: string): Promise<{ task: ExternalTask; note: string | null }> {
  const shape = s.notion
  if (!shape) throw new HttpError(409, 'notion_source_not_selected')
  const url = `${cfg.notion.apiBase}/pages/${encodeURIComponent(taskId)}`
  const before = await pfetch(s, url, { extraHeaders: notionHeaders(cfg) })
  if (before.status === 404) throw new HttpError(404, 'task_not_found')
  const prior = fromNotion(await body(before, NotionPage), shape)
  if (prior.done) return { task: prior, note: 'Already done in Notion.' }
  const value = shape.done.type === 'checkbox' ? { checkbox: true } : { status: { name: shape.done.doneName } }
  const r = await pfetch(s, url, { method: 'PATCH', body: JSON.stringify({ properties: { [shape.done.prop]: value } }), extraHeaders: notionHeaders(cfg) })
  if (!r.ok) throw new HttpError(502, 'task_complete_failed')
  const after = await pfetch(s, url, { extraHeaders: notionHeaders(cfg) })
  const t = fromNotion(await body(after, NotionPage), shape)
  if (!t.done) throw new HttpError(502, 'task_complete_unverified')
  return { task: t, note: null }
}

// ---- Notion notes ("Ask my notes"): pages shared with the connection, titles + short excerpts only

const NotionSearchPage = z
  .object({ object: z.string(), id: z.string(), last_edited_time: z.string().optional(), properties: z.record(z.string(), z.object({ type: z.string(), title: RichText.optional() }).passthrough()).default({}) })
  .passthrough()
type NotionSearchPageT = z.infer<typeof NotionSearchPage>
const NotionBlock = z.object({ type: z.string() }).passthrough()
const TEXT_BLOCKS = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'callout', 'toggle', 'code'])

function pageTitle(p: NotionSearchPageT): string {
  for (const v of Object.values(p.properties)) if (v.type === 'title') return (v.title ?? []).map((t) => t.plain_text).join('').trim() || 'Untitled'
  return 'Untitled'
}
const edited = (p: NotionSearchPageT) => Date.parse(p.last_edited_time ?? '') || 0

async function notionSearchPages(cfg: ServerConfig, s: TaskSession, query: string): Promise<NotionSearchPageT[]> {
  const r = await pfetch(s, `${cfg.notion.apiBase}/search`, {
    method: 'POST',
    body: JSON.stringify({ ...(query ? { query } : {}), filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 8 }),
    extraHeaders: notionHeaders(cfg),
  })
  const b = await body(r, z.object({ results: z.array(z.unknown()).default([]) }))
  const out: NotionSearchPageT[] = []
  for (const x of b.results) {
    const p = NotionSearchPage.safeParse(x)
    if (p.success && p.data.object === 'page') out.push(p.data)
  }
  return out
}

async function notionPageLines(cfg: ServerConfig, s: TaskSession, id: string): Promise<string[]> {
  const r = await pfetch(s, `${cfg.notion.apiBase}/blocks/${encodeURIComponent(id)}/children?page_size=80`, { extraHeaders: notionHeaders(cfg) })
  const b = await body(r, z.object({ results: z.array(z.unknown()).default([]) }))
  const lines: string[] = []
  for (const x of b.results) {
    const blk = NotionBlock.safeParse(x)
    if (!blk.success || !TEXT_BLOCKS.has(blk.data.type)) continue
    const inner = (blk.data as Record<string, unknown>)[blk.data.type] as { rich_text?: Array<{ plain_text?: string }>; checked?: boolean } | undefined
    const text = (inner?.rich_text ?? []).map((t) => t.plain_text ?? '').join('').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const type = blk.data.type
    const prefix = type.startsWith('heading') ? '# ' : type === 'to_do' ? (inner?.checked ? '[x] ' : '[ ] ') : type.endsWith('list_item') ? '- ' : ''
    lines.push((prefix + text).slice(0, 300))
  }
  return lines
}

export const NotesSearchSchema = z.object({ q: z.string().trim().min(2).max(200) })

/**
 * Finds the Notion pages (shared with this connection) that answer a question. Notion's search
 * matches titles, so it searches the question's keywords plus the most recently edited pages,
 * reads up to five candidates and returns at most three: title + an excerpt around the keywords.
 */
export async function searchNotes(cfg: ServerConfig, s: TaskSession, q: string): Promise<NoteHit[]> {
  requireKind(s, 'tasks')
  if (s.provider !== 'notion') throw new HttpError(400, 'notes_need_notion')
  const kws = keywords(q)
  const found = new Map<string, NotionSearchPageT>()
  for (const query of [...kws.slice(0, 2), '']) {
    for (const p of await notionSearchPages(cfg, s, query)) if (!found.has(p.id)) found.set(p.id, p)
    if (found.size >= 12) break
  }
  const pages = [...found.values()].sort((a, b) => matchScore(pageTitle(b), '', kws) - matchScore(pageTitle(a), '', kws) || edited(b) - edited(a))
  const scored: Array<{ p: NotionSearchPageT; title: string; lines: string[]; score: number }> = []
  for (const p of pages.slice(0, 5)) {
    const title = pageTitle(p).slice(0, 120)
    const lines = await notionPageLines(cfg, s, p.id)
    scored.push({ p, title, lines, score: matchScore(title, lines.join('\n'), kws) })
  }
  const hits = kws.length ? scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score) : scored
  return hits.slice(0, 3).map((x) => ({ id: x.p.id.slice(0, 64), title: x.title, text: excerpt(x.lines, kws, 1200), editedAt: edited(x.p) || null }))
}

// ---------------------------------------------------------------- public operations

export function requireKind(s: TaskSession, kind: 'tasks' | 'messages'): void {
  const isMsg = s.provider === 'gmail' || s.provider === 'slack' || s.provider === 'telegram' || s.provider === 'github'
  if (isMsg !== (kind === 'messages')) throw new HttpError(400, 'wrong_connection_kind')
}

export async function listTasks(cfg: ServerConfig, s: TaskSession, sourceId: string | null): Promise<{ tasks: ExternalTask[]; sources: TaskSource[]; selected: string | null; label: string }> {
  requireKind(s, 'tasks')
  let out: { tasks: ExternalTask[]; sources: TaskSource[]; selected: string | null }
  if (s.provider === 'todoist') out = { tasks: await todoistList(cfg, s), sources: [], selected: null }
  else if (s.provider === 'google_tasks') out = { tasks: await gtasksList(cfg, s), sources: [], selected: null }
  else out = await notionList(cfg, s, sourceId)
  const open = out.tasks.filter((t) => !t.done)
  // due first (soonest), then undated; cap the payload
  open.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))
  return { ...out, tasks: open.slice(0, MAX_TASKS), label: s.provider === 'notion' && s.notion ? `Notion · ${s.notion.name}` : s.label }
}

export const CompleteTaskSchema = z.object({
  proposalId: z.string().regex(/^prop_[A-Za-z0-9]{8,40}$/),
  taskId: z.string().min(1).max(256),
})

export async function completeTask(cfg: ServerConfig, s: TaskSession, input: z.infer<typeof CompleteTaskSchema>): Promise<{ task: ExternalTask; reconciled: boolean; note: string | null }> {
  requireKind(s, 'tasks')
  const prior = s.writes.get(input.proposalId)
  if (prior) return { task: prior, reconciled: true, note: null }
  const r = s.provider === 'todoist' ? await todoistComplete(cfg, s, input.taskId, input.proposalId) : s.provider === 'google_tasks' ? await gtasksComplete(cfg, s, input.taskId) : await notionComplete(cfg, s, input.taskId)
  s.writes.set(input.proposalId, r.task)
  return { task: r.task, reconciled: false, note: r.note }
}

export type { InboxItem }

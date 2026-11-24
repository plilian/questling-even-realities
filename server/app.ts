import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AiRequestSchema, type AiProviderId } from '../src/shared/ai'
import { config, type ServerConfig } from './config'
import type { AiProvider } from './gemini'
import { buildProviders, defaultProviderId, providerStatus, resolveProvider } from './providers'
import {
  CreateEventSchema,
  UpdateEventSchema,
  authorizeUrl,
  calendarConfigured,
  createEvent,
  disconnect,
  getSession,
  handleCallback,
  listEvents,
  normalizeCode,
  pollLink,
  startLink,
  updateEvent,
} from './google'
import { githubPage, linkPage, resultPage, telegramPage } from './pages'
import { GITHUB_TOKEN_RE, inspectGithubToken } from './github'
import { CompleteTaskSchema, completeDirectLink, completeTask, disconnectTasks, getTaskSession, handleTaskCallback, isTaskCode, linkProviderForCode, listTasks, messageProvidersConfigured, pollTaskLink, providerForState, requireKind, startTaskLink, taskAuthorizeUrl, taskProvidersConfigured } from './tasks'
import { inspectBot, TELEGRAM_TOKEN_RE } from './telegram'
import { MarkReadSchema, ReplySchema, listInbox, markMessageRead, replyToMessage } from './messages'
import { MESSAGE_PROVIDER_IDS } from '../src/shared/messages'
import { TASK_PROVIDER_IDS } from '../src/shared/tasks'
import {
  DailyBudget,
  HttpError,
  RateLimiter,
  applyCors,
  bearer,
  issueAccessToken,
  json,
  logRequest,
  readForm,
  readJson,
  safeEqual,
  securityHeaders,
  verifyAccessToken,
} from './security'

/**
 * Minimal stateless API for Questling. No database, no accounts, no stored
 * conversations, no payload logging. Every /api route except /api/status and
 * /api/session requires a short-lived access token.
 */

interface Runtime {
  cfg: ServerConfig
  providers: Map<AiProviderId, AiProvider>
  defaultAi: AiProviderId | null
  aiLimiter: RateLimiter
  ipLimiter: RateLimiter
  sessionLimiter: RateLimiter
  budget: DailyBudget
}

let runtime: Runtime | null = null

export function getRuntime(): Runtime {
  if (!runtime) {
    const cfg = config()
    const providers = buildProviders(cfg)
    runtime = {
      cfg,
      providers,
      defaultAi: defaultProviderId(providers, cfg.aiDefaultProvider),
      aiLimiter: new RateLimiter(cfg.aiRatePerMinute, 60_000),
      ipLimiter: new RateLimiter(120, 60_000),
      sessionLimiter: new RateLimiter(10, 60_000),
      budget: new DailyBudget(cfg.aiDailyBudget),
    }
  }
  return runtime
}

export function setRuntimeForTests(r: Partial<Runtime> & { cfg: ServerConfig; ai?: AiProvider | AiProvider[] | null }) {
  const { ai, ...rest } = r
  const providers = r.providers ?? new Map((ai ? (Array.isArray(ai) ? ai : [ai]) : []).map((p) => [p.id, p] as const))
  runtime = {
    aiLimiter: new RateLimiter(r.cfg.aiRatePerMinute, 60_000),
    ipLimiter: new RateLimiter(1000, 60_000),
    sessionLimiter: new RateLimiter(100, 60_000),
    budget: new DailyBudget(r.cfg.aiDailyBudget),
    ...rest,
    providers,
    defaultAi: r.defaultAi ?? defaultProviderId(providers, r.cfg.aiDefaultProvider),
  }
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

function requireAccess(rt: Runtime, req: IncomingMessage): string {
  const sid = verifyAccessToken(rt.cfg, bearer(req))
  if (!sid) throw new HttpError(401, 'access_token_required')
  return sid
}

const SessionReq = z.object({ accessCode: z.string().max(128).optional() })
const PollReq = z.object({ linkId: z.string().min(10).max(64), pollSecret: z.string().min(10).max(64) })
const TaskLinkReq = z.object({ provider: z.enum([...TASK_PROVIDER_IDS, ...MESSAGE_PROVIDER_IDS]) })

function htmlPage(res: ServerResponse, status: number, html: string) {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
  return void res.end(html)
}

function htmlResult(res: ServerResponse, r: { ok: boolean; message: string }) {
  res.statusCode = r.ok ? 200 : 400
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  return void res.end(resultPage(r.ok, r.message))
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now()
  const rt = getRuntime()
  const { cfg } = rt
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname
  securityHeaders(res)
  try {
    if (applyCors(req, res, cfg)) return
    if (!rt.ipLimiter.allow(clientIp(req))) throw new HttpError(429, 'rate_limited')

    // ---- public ----
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true })
    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, {
        ok: true,
        ai: {
          configured: rt.providers.size > 0,
          model: rt.defaultAi ? rt.providers.get(rt.defaultAi)!.model : null,
          default: rt.defaultAi,
          providers: providerStatus(rt.providers),
        },
        calendar: { configured: calendarConfigured(cfg) },
        tasks: taskProvidersConfigured(cfg),
        messages: messageProvidersConfigured(cfg),
        access: { codeRequired: cfg.accessCodes.length > 0 || cfg.production },
      })
    }
    if (req.method === 'POST' && path === '/api/session') {
      if (!rt.sessionLimiter.allow(clientIp(req))) throw new HttpError(429, 'rate_limited')
      const body = SessionReq.parse(await readJson(req, 2048))
      const needCode = cfg.accessCodes.length > 0 || cfg.production
      if (needCode) {
        if (!cfg.accessCodes.length) throw new HttpError(503, 'access_codes_not_configured')
        const ok = !!body.accessCode && cfg.accessCodes.some((c) => safeEqual(c, body.accessCode!))
        if (!ok) throw new HttpError(403, 'invalid_access_code')
      }
      const t = issueAccessToken(cfg)
      return json(res, 200, { ok: true, token: t.token, expiresAt: t.expiresAt })
    }

    // ---- external-browser OAuth pages (full browser, not the WebView) ----
    if (req.method === 'GET' && path === '/link') {
      const code = url.searchParams.get('code')
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
      const anyConfigured = calendarConfigured(cfg) || Object.values(taskProvidersConfigured(cfg)).some(Boolean) || Object.values(messageProvidersConfigured(cfg)).some(Boolean)
      return void res.end(linkPage(code ? normalizeCode(code) : '', anyConfigured))
    }
    if (req.method === 'GET' && (path === '/api/auth/start' || path === '/api/auth/google/start')) {
      // one link page for every integration: the user code decides which provider's consent screen opens
      const code = url.searchParams.get('code') ?? ''
      if (linkProviderForCode(code) === 'telegram') return htmlPage(res, 200, telegramPage(normalizeCode(code)))
      if (linkProviderForCode(code) === 'github') return htmlPage(res, 200, githubPage(normalizeCode(code)))
      const target = isTaskCode(code) ? taskAuthorizeUrl(cfg, code) : authorizeUrl(cfg, code)
      res.statusCode = 302
      res.setHeader('location', target)
      res.setHeader('cache-control', 'no-store')
      return void res.end()
    }
    if (req.method === 'GET' && path === '/api/auth/google/callback') {
      // Google Tasks shares the Calendar redirect URI; the single-use state says which flow it belongs to
      const linked = providerForState(url.searchParams.get('state'))
      if (linked) return htmlResult(res, await handleTaskCallback(cfg, linked, url.searchParams))
      return htmlResult(res, await handleCallback(cfg, url.searchParams))
    }
    if (req.method === 'POST' && path === '/api/auth/telegram') {
      if (!rt.sessionLimiter.allow(clientIp(req))) throw new HttpError(429, 'rate_limited')
      const form = await readForm(req, 2048)
      const code = form.get('code') ?? ''
      const token = (form.get('token') ?? '').trim()
      if (linkProviderForCode(code) !== 'telegram') return htmlResult(res, { ok: false, message: 'This link code has expired. Start again from Questling.' })
      if (!TELEGRAM_TOKEN_RE.test(token)) return htmlPage(res, 400, telegramPage(normalizeCode(code), 'That does not look like a bot token (it has the form 123456789:AA…).'))
      try {
        const bot = await inspectBot(cfg, token)
        const ok = completeDirectLink(code, 'telegram', { accessToken: token, expiresAt: Date.now() + 12 * 3600_000, label: `Telegram · @${bot.username}`, canSend: true, userId: String(bot.botId), botUsername: bot.username })
        if (!ok) return htmlResult(res, { ok: false, message: 'This link code has expired. Start again from Questling.' })
        return htmlResult(res, { ok: true, message: `Telegram connected as @${bot.username}. Return to Questling — it will finish linking automatically.${bot.businessReady ? '' : ' Tip: turn on Business Mode for the bot in BotFather if you want your private chats too.'}` })
      } catch (e) {
        const c = e instanceof HttpError ? e.code : 'telegram_error'
        const msg = c === 'telegram_token_invalid' ? 'Telegram did not accept that token. Copy it again from @BotFather.' : c === 'telegram_webhook_set' ? 'This bot already sends its updates to a webhook. Use a new bot just for Questling.' : 'Could not reach Telegram. Please try again.'
        return htmlPage(res, 400, telegramPage(normalizeCode(code), msg))
      }
    }
    if (req.method === 'POST' && path === '/api/auth/github') {
      if (!rt.sessionLimiter.allow(clientIp(req))) throw new HttpError(429, 'rate_limited')
      const form = await readForm(req, 2048)
      const code = form.get('code') ?? ''
      const token = (form.get('token') ?? '').trim()
      if (linkProviderForCode(code) !== 'github') return htmlResult(res, { ok: false, message: 'This link code has expired. Start again from Questling.' })
      if (!GITHUB_TOKEN_RE.test(token)) return htmlPage(res, 400, githubPage(normalizeCode(code), 'That does not look like a classic personal access token (it starts with ghp_).'))
      try {
        const me = await inspectGithubToken(cfg, token)
        const ok = completeDirectLink(code, 'github', { accessToken: token, expiresAt: Date.now() + 12 * 3600_000, label: `GitHub · @${me.login}`, canSend: false })
        if (!ok) return htmlResult(res, { ok: false, message: 'This link code has expired. Start again from Questling.' })
        return htmlResult(res, { ok: true, message: `GitHub connected as @${me.login}. Return to Questling — it will finish linking automatically.` })
      } catch (e) {
        const c = e instanceof HttpError ? e.code : 'github_error'
        const msg = c === 'github_token_invalid' ? 'GitHub did not accept that token.' : c === 'github_scope_missing' ? 'That token has no “notifications” scope. Create one with only that scope.' : 'Could not reach GitHub. Please try again.'
        return htmlPage(res, 400, githubPage(normalizeCode(code), msg))
      }
    }
    const cb = path.match(/^\/api\/auth\/(todoist|notion|slack)\/callback$/)
    if (req.method === 'GET' && cb) {
      return htmlResult(res, await handleTaskCallback(cfg, cb[1] as 'todoist' | 'notion' | 'slack', url.searchParams))
    }

    // ---- authenticated API ----
    if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found')
    const sid = requireAccess(rt, req)

    if (req.method === 'POST' && (path === '/api/ai/chat' || path === '/api/ai/voice')) {
      if (!rt.providers.size) throw new HttpError(503, 'ai_not_configured')
      if (!rt.aiLimiter.allow(sid)) throw new HttpError(429, 'rate_limited')
      const max = path.endsWith('voice') ? 760_000 : 48_000
      const parsed = AiRequestSchema.safeParse(await readJson(req, max))
      if (!parsed.success) throw new HttpError(400, 'invalid_request')
      const body = parsed.data
      if (path.endsWith('voice') !== (body.mode === 'voice')) throw new HttpError(400, 'mode_mismatch')
      if (body.mode === 'voice' && !body.audio) throw new HttpError(400, 'audio_required')
      if (body.mode === 'chat' && !body.message?.trim()) throw new HttpError(400, 'message_required')
      const pick = resolveProvider(rt.providers, rt.defaultAi, body.provider, body.mode)
      if (!pick.ok) throw new HttpError(pick.error === 'provider_not_configured' ? 400 : 503, pick.error)
      if (!rt.budget.take()) throw new HttpError(429, 'daily_budget_exhausted')
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), body.mode === 'voice' ? 25_000 : 18_000)
      try {
        const r = await pick.provider.generate(body, ctrl.signal)
        if (!r.ok) {
          const status = r.error === 'rate_limited' ? 429 : r.error === 'timeout' ? 504 : r.error === 'refused' ? 422 : 502
          throw new HttpError(status, `ai_${r.error}`)
        }
        return json(res, 200, { ok: true, response: r.response, provider: pick.provider.id, model: pick.provider.model, routed: pick.routed })
      } finally {
        clearTimeout(timer)
      }
    }

    if (req.method === 'POST' && path === '/api/calendar/link/start') {
      return json(res, 200, { ok: true, ...startLink(cfg) })
    }
    if (req.method === 'POST' && path === '/api/calendar/link/poll') {
      const b = PollReq.parse(await readJson(req, 1024))
      return json(res, 200, { ok: true, ...pollLink(b.linkId, b.pollSecret) })
    }
    const calHandle = req.headers['x-lq-calendar'] as string | undefined
    if (req.method === 'GET' && path === '/api/calendar/events') {
      const s = getSession(calHandle)
      const from = Number(url.searchParams.get('from'))
      const to = Number(url.searchParams.get('to'))
      const events = await listEvents(cfg, s, from, to)
      return json(res, 200, { ok: true, events, fetchedAt: Date.now() })
    }
    if (req.method === 'POST' && path === '/api/calendar/events') {
      const s = getSession(calHandle)
      const b = CreateEventSchema.safeParse(await readJson(req, 4096))
      if (!b.success) throw new HttpError(400, 'invalid_event')
      const r = await createEvent(cfg, s, b.data)
      return json(res, 200, { ok: true, verified: true, ...r })
    }
    if (req.method === 'PATCH' && path === '/api/calendar/events') {
      const s = getSession(calHandle)
      const b = UpdateEventSchema.safeParse(await readJson(req, 4096))
      if (!b.success) throw new HttpError(400, 'invalid_event')
      const r = await updateEvent(cfg, s, b.data)
      return json(res, 200, { ok: true, verified: true, ...r })
    }
    // ---- task integrations (Todoist, Notion, Google Tasks)
    if (req.method === 'POST' && (path === '/api/tasks/link/start' || path === '/api/connect/start')) {
      const b = TaskLinkReq.parse(await readJson(req, 512))
      return json(res, 200, { ok: true, ...startTaskLink(cfg, b.provider) })
    }
    if (req.method === 'POST' && (path === '/api/tasks/link/poll' || path === '/api/connect/poll')) {
      const b = PollReq.parse(await readJson(req, 1024))
      return json(res, 200, { ok: true, ...pollTaskLink(b.linkId, b.pollSecret) })
    }
    const taskHandle = (req.headers['x-lq-tasks'] ?? req.headers['x-lq-link']) as string | undefined
    // ---- mail & chat (Gmail, Slack)
    if (req.method === 'GET' && path === '/api/messages') {
      const s = getTaskSession(taskHandle)
      const ack = (url.searchParams.get('ack') ?? '').split(',').filter((x) => /^-?\d{1,20}:\d{1,12}$/.test(x)).slice(0, 20)
      const r = await listInbox(cfg, s, ack)
      return json(res, 200, { ok: true, provider: s.provider, ...r, fetchedAt: Date.now() })
    }
    if (req.method === 'POST' && path === '/api/messages/read') {
      const s = getTaskSession(taskHandle)
      const b = MarkReadSchema.safeParse(await readJson(req, 1024))
      if (!b.success) throw new HttpError(400, 'invalid_request')
      const r = await markMessageRead(cfg, s, b.data)
      return json(res, 200, { ok: true, verified: true, provider: s.provider, ...r })
    }
    if (req.method === 'POST' && path === '/api/messages/reply') {
      const s = getTaskSession(taskHandle)
      requireKind(s, 'messages')
      const b = ReplySchema.safeParse(await readJson(req, 4096))
      if (!b.success) throw new HttpError(400, 'invalid_request')
      const r = await replyToMessage(cfg, s, b.data)
      return json(res, 200, { ok: true, verified: true, provider: s.provider, ...r })
    }
    if (req.method === 'GET' && path === '/api/tasks') {
      const s = getTaskSession(taskHandle)
      const source = url.searchParams.get('source')
      const r = await listTasks(cfg, s, source && /^[A-Za-z0-9-]{8,64}$/.test(source) ? source : null)
      return json(res, 200, { ok: true, provider: s.provider, ...r, fetchedAt: Date.now() })
    }
    if (req.method === 'POST' && path === '/api/tasks/complete') {
      const s = getTaskSession(taskHandle)
      const b = CompleteTaskSchema.safeParse(await readJson(req, 1024))
      if (!b.success) throw new HttpError(400, 'invalid_request')
      const r = await completeTask(cfg, s, b.data)
      return json(res, 200, { ok: true, verified: true, provider: s.provider, ...r })
    }
    if (req.method === 'POST' && (path === '/api/tasks/disconnect' || path === '/api/messages/disconnect' || path === '/api/connect/disconnect')) {
      return json(res, 200, { ok: true, ...(await disconnectTasks(cfg, taskHandle)) })
    }
    if (req.method === 'POST' && path === '/api/calendar/disconnect') {
      const r = await disconnect(cfg, calHandle)
      return json(res, 200, { ok: true, ...r })
    }
    throw new HttpError(404, 'not_found')
  } catch (err) {
    if (err instanceof HttpError) json(res, err.status, { ok: false, error: err.code })
    else if (err instanceof z.ZodError) json(res, 400, { ok: false, error: 'invalid_request' })
    else {
      console.error('[api] unexpected error:', (err as Error)?.name ?? 'Error')
      json(res, 500, { ok: false, error: 'internal_error' })
    }
  } finally {
    logRequest(req.method ?? '?', path, res.statusCode, Date.now() - started)
  }
}

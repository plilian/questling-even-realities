import { z } from 'zod'
import type { ServerConfig } from './config'
import { HttpError } from './security'
import type { TaskSession } from './tasks'
import type { InboxItem } from '../src/shared/messages'

/**
 * GitHub notifications — review requests, mentions and
 * assignments as heads-ups. GitHub's notifications endpoints only accept a personal access token
 * (classic), so the user pastes one with ONLY the `notifications` scope on the /link page (never in
 * the app). Read: participating notification threads (repo, subject title, reason). The only write is
 * “mark as read”, after the user confirms, verified by reading the thread back.
 */
export const GITHUB_TOKEN_RE = /^(ghp_[A-Za-z0-9]{30,255}|gho_[A-Za-z0-9]{30,255})$/
const API_VERSION = '2026-03-10'
const WANTED = new Set(['review_requested', 'mention', 'team_mention', 'assign', 'approval_requested'])
const REASON: Record<string, string> = {
  review_requested: 'Review requested',
  mention: 'Mentioned you',
  team_mention: 'Mentioned your team',
  assign: 'Assigned to you',
  approval_requested: 'Approval requested',
}

const Thread = z
  .object({
    id: z.string(),
    unread: z.boolean(),
    reason: z.string(),
    updated_at: z.string(),
    subject: z.object({ title: z.string(), type: z.string() }).passthrough(),
    repository: z.object({ full_name: z.string() }).passthrough(),
  })
  .passthrough()

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

async function gh(cfg: ServerConfig, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  let r: Response
  try {
    r = await fetch(`${cfg.github.apiBase}${path}`, {
      ...init,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': API_VERSION, 'user-agent': 'Questling', ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HttpError(502, 'github_unreachable')
  }
  if (r.status === 401) throw new HttpError(401, 'tasks_session_expired')
  if (r.status === 403 || r.status === 429) throw new HttpError(429, 'rate_limited')
  return r
}

/** Checks a pasted token: it must work and carry the notifications (or repo) scope. */
export async function inspectGithubToken(cfg: ServerConfig, token: string): Promise<{ login: string }> {
  if (!GITHUB_TOKEN_RE.test(token)) throw new HttpError(400, 'github_token_invalid')
  let r: Response
  try {
    r = await fetch(`${cfg.github.apiBase}/user`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': API_VERSION, 'user-agent': 'Questling' }, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new HttpError(502, 'github_unreachable')
  }
  if (r.status === 401) throw new HttpError(401, 'github_token_invalid')
  const scopes = (r.headers.get('x-oauth-scopes') ?? '').split(',').map((x) => x.trim())
  if (!scopes.includes('notifications') && !scopes.includes('repo')) throw new HttpError(403, 'github_scope_missing')
  const u = z.object({ login: z.string() }).passthrough().safeParse(await r.json().catch(() => null))
  if (!u.success) throw new HttpError(502, 'github_malformed_response')
  return { login: u.data.login }
}

export async function githubList(cfg: ServerConfig, s: TaskSession): Promise<InboxItem[]> {
  const r = await gh(cfg, s.accessToken, '/notifications?participating=true&per_page=30')
  if (!r.ok) throw new HttpError(502, 'github_error')
  const list = z.array(z.unknown()).catch([]).parse(await r.json().catch(() => []))
  const out: InboxItem[] = []
  for (const raw of list) {
    const t = Thread.safeParse(raw)
    if (!t.success || !t.data.unread || !WANTED.has(t.data.reason) || !/^\d{1,20}$/.test(t.data.id)) continue
    out.push({
      id: t.data.id,
      provider: 'github',
      from: 'GitHub',
      title: clip(t.data.subject.title, 160),
      preview: clip(`${REASON[t.data.reason] ?? t.data.reason} · ${t.data.subject.type.replace(/([a-z])([A-Z])/g, '$1 $2')}`, 220),
      where: clip(t.data.repository.full_name, 60),
      at: Date.parse(t.data.updated_at) || Date.now(),
      important: true,
      canReply: false,
    })
  }
  return out
}

/** The only write: mark one thread as read, then read it back. */
export async function githubMarkRead(cfg: ServerConfig, s: TaskSession, threadId: string): Promise<void> {
  if (!/^\d{1,20}$/.test(threadId)) throw new HttpError(400, 'invalid_message_id')
  const w = await gh(cfg, s.accessToken, `/notifications/threads/${threadId}`, { method: 'PATCH' })
  if (w.status === 404) throw new HttpError(404, 'message_not_found')
  if (w.status !== 205 && !w.ok) throw new HttpError(502, 'github_error')
  const back = await gh(cfg, s.accessToken, `/notifications/threads/${threadId}`)
  const t = Thread.safeParse(await back.json().catch(() => null))
  if (!back.ok || !t.success || t.data.unread) throw new HttpError(502, 'write_unverified')
}

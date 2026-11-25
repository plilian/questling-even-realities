import { z } from 'zod'
import type { ServerConfig } from './config'
import { HttpError } from './security'
import { pfetch, requireKind, type TaskSession } from './tasks'
import { REPLY_MAX, type Capture, type InboxItem } from '../src/shared/messages'
import { containsProfanity } from '../src/companion/policy'
import { telegramDigest, telegramList, telegramReply } from './telegram'
import type { DigestChannel } from '../src/shared/notes'
import { githubList, githubMarkRead } from './github'

/**
 * Mail & chat adapters.
 *
 * Gmail — scopes gmail.metadata (headers + labels, never bodies) and gmail.send (send only).
 *   Reads unread INBOX messages: sender display name, subject, time, IMPORTANT label. Email
 *   addresses stay on the server; replies are addressed server-side from the original headers.
 * Slack — user scopes search:read, chat:write, users:read. Reads recent messages that mention
 *   the user; replies go into the same thread.
 * Telegram — the user's own bot (server/telegram.ts).
 * Every reply needs the user's confirmation in the app, is idempotent per proposal, is kept clean
 * (no profanity is ever sent on the user's behalf, whatever the companion's language mode) and is
 * verified with the provider before success is shown.
 */

const MAX_ITEMS = 10

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
/** Header values must never carry CR/LF (header injection). */
function headerSafe(s: string) {
  return s.replace(/[\r\n]+/g, ' ').trim()
}

// ---------------------------------------------------------------- Gmail

const GHeader = z.object({ name: z.string(), value: z.string() })
const GMessage = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().optional(),
  payload: z.object({ headers: z.array(GHeader).default([]) }).default({ headers: [] }),
})
type GMessageT = z.infer<typeof GMessage>
const header = (m: GMessageT, name: string) => m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/** `"Sam Lee" <sam@x.com>` → `Sam Lee`; `sam@x.com` → `sam`. Addresses never leave the server. */
export function displayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/)
  if (m && m[1]!.trim()) return clip(m[1]!, 80)
  const addr = from.match(/<?([^<>\s@]+)@[^<>\s]+>?/)
  return clip(addr ? addr[1]! : from || 'Someone', 80)
}

async function gmailGet(cfg: ServerConfig, s: TaskSession, id: string, headers: string[]): Promise<GMessageT | null> {
  const q = new URLSearchParams({ format: 'metadata' })
  for (const h of headers) q.append('metadataHeaders', h)
  const r = await pfetch(s, `${cfg.gmailBase}/users/me/messages/${encodeURIComponent(id)}?${q}`)
  if (r.status === 404) return null
  if (!r.ok) throw new HttpError(502, 'messages_bad_response')
  const p = GMessage.safeParse(await r.json().catch(() => null))
  return p.success ? p.data : null
}

async function gmailList(cfg: ServerConfig, s: TaskSession): Promise<InboxItem[]> {
  const q = new URLSearchParams({ maxResults: String(MAX_ITEMS) })
  q.append('labelIds', 'INBOX')
  q.append('labelIds', 'UNREAD')
  const r = await pfetch(s, `${cfg.gmailBase}/users/me/messages?${q}`)
  if (!r.ok) throw new HttpError(502, 'messages_bad_response')
  const list = z.object({ messages: z.array(z.object({ id: z.string() })).default([]) }).safeParse(await r.json().catch(() => null))
  if (!list.success) throw new HttpError(502, 'messages_malformed_response')
  const out: InboxItem[] = []
  for (const { id } of list.data.messages.slice(0, MAX_ITEMS)) {
    const m = await gmailGet(cfg, s, id, ['From', 'Subject', 'Date'])
    if (!m) continue
    const at = Number(m.internalDate) || Date.parse(header(m, 'Date')) || Date.now()
    out.push({
      id: m.id,
      provider: 'gmail',
      from: displayName(header(m, 'From')),
      title: clip(header(m, 'Subject') || '(no subject)', 160),
      preview: '',
      where: 'Inbox',
      at,
      important: m.labelIds.includes('IMPORTANT'),
      canReply: s.canSend,
    })
  }
  return out
}

function b64url(s: string) {
  return Buffer.from(s, 'utf8').toString('base64url')
}
function encodeWord(s: string) {
  // RFC 2047 so any language survives in the subject line
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

/** Exactly one bare address from a From/Reply-To header (no display names, groups or extra recipients). */
export function pickAddress(h: string): string | null {
  const m = h.match(/<([^<>\s@]+@[^<>\s@]+)>/) ?? h.match(/([^\s<>,;:"()]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/)
  return m ? m[1]! : null
}

/** Build the RFC 2822 reply. Exported for tests. */
export function buildGmailReply(orig: { from: string; replyTo: string; subject: string; messageId: string; references: string }, body: string): string {
  const to = pickAddress(orig.replyTo) ?? pickAddress(orig.from)
  if (!to) throw new HttpError(422, 'reply_address_missing')
  const subj = headerSafe(orig.subject)
  const subject = /^re:/i.test(subj) ? subj : `Re: ${subj || '(no subject)'}`
  const mid = headerSafe(orig.messageId)
  const refs = headerSafe(`${orig.references} ${mid}`.trim())
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeWord(subject)}`,
    ...(mid ? [`In-Reply-To: ${mid}`, `References: ${refs}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ]
  return lines.join('\r\n')
}

async function gmailReply(cfg: ServerConfig, s: TaskSession, messageId: string, body: string): Promise<{ id: string; to: string; at: number }> {
  const orig = await gmailGet(cfg, s, messageId, ['From', 'Reply-To', 'Subject', 'Message-ID', 'References'])
  if (!orig) throw new HttpError(404, 'message_not_found')
  const raw = buildGmailReply({ from: header(orig, 'From'), replyTo: header(orig, 'Reply-To'), subject: header(orig, 'Subject'), messageId: header(orig, 'Message-ID'), references: header(orig, 'References') }, body)
  const r = await pfetch(s, `${cfg.gmailBase}/users/me/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64url(raw), threadId: orig.threadId }) })
  if (!r.ok) throw new HttpError(502, 'message_send_failed')
  const sent = z.object({ id: z.string() }).safeParse(await r.json().catch(() => null))
  if (!sent.success) throw new HttpError(502, 'message_send_unverified')
  // verify: the message exists in the mailbox with the SENT label
  const check = await gmailGet(cfg, s, sent.data.id, ['To'])
  if (!check || !check.labelIds.includes('SENT')) throw new HttpError(502, 'message_send_unverified')
  return { id: sent.data.id, to: displayName(header(orig, 'Reply-To') || header(orig, 'From')), at: Date.now() }
}

// ---------------------------------------------------------------- Slack

const SlackMatch = z.object({
  ts: z.string(),
  text: z.string().default(''),
  user: z.string().optional(),
  username: z.string().optional(),
  channel: z.object({ id: z.string(), name: z.string().optional(), is_im: z.boolean().optional(), is_mpim: z.boolean().optional(), is_private: z.boolean().optional() }),
})

async function slackCall(cfg: ServerConfig, s: TaskSession, method: string, params: Record<string, string>, post = false): Promise<Record<string, unknown>> {
  const q = new URLSearchParams(params)
  const r = post
    ? await pfetch(s, `${cfg.slack.apiBase}/${method}`, { method: 'POST', body: JSON.stringify(params) })
    : await pfetch(s, `${cfg.slack.apiBase}/${method}?${q}`)
  const b = (await r.json().catch(() => null)) as Record<string, unknown> | null
  if (!r.ok || !b) throw new HttpError(502, 'messages_bad_response')
  if (b.ok !== true) {
    const err = String(b.error ?? 'error')
    if (err === 'invalid_auth' || err === 'token_revoked' || err === 'token_expired' || err === 'not_authed') throw new HttpError(401, 'tasks_session_expired')
    if (err === 'missing_scope') throw new HttpError(403, 'tasks_permission_missing')
    if (err === 'ratelimited') throw new HttpError(429, 'tasks_rate_limited')
    throw new HttpError(502, `slack_${err.replace(/[^a-z_]/g, '').slice(0, 40)}`)
  }
  return b
}

async function slackName(cfg: ServerConfig, s: TaskSession, uid: string): Promise<string> {
  const cached = s.names.get(uid)
  if (cached) return cached
  let name = 'someone'
  try {
    const b = await slackCall(cfg, s, 'users.info', { user: uid })
    const u = b.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined
    name = u?.profile?.display_name || u?.real_name || u?.name || name
  } catch {
    /* names are cosmetic */
  }
  if (s.names.size < 500) s.names.set(uid, clip(name, 60))
  return clip(name, 60)
}

/** Slack mrkdwn → plain text: <@U1> → @name, <#C1|general> → #general, <url|label> → label. */
export async function slackPlain(text: string, resolve: (uid: string) => Promise<string>): Promise<string> {
  let out = text
  for (const m of [...new Set(text.match(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g) ?? [])]) {
    const uid = m.match(/<@([UW][A-Z0-9]+)/)![1]!
    out = out.split(m).join(`@${await resolve(uid)}`)
  }
  return out
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

async function slackList(cfg: ServerConfig, s: TaskSession): Promise<InboxItem[]> {
  if (!s.userId) throw new HttpError(500, 'slack_user_unknown')
  const b = await slackCall(cfg, s, 'search.messages', { query: `<@${s.userId}>`, sort: 'timestamp', sort_dir: 'desc', count: String(MAX_ITEMS) })
  const matches = z.object({ matches: z.array(z.unknown()).default([]) }).safeParse(b.messages)
  if (!matches.success) throw new HttpError(502, 'messages_malformed_response')
  const since = Date.now() - 3 * 86400_000
  const out: InboxItem[] = []
  for (const it of matches.data.matches) {
    const p = SlackMatch.safeParse(it)
    if (!p.success) continue
    const m = p.data
    if (m.user && m.user === s.userId) continue
    const at = Math.round(Number(m.ts) * 1000)
    if (!Number.isFinite(at) || at < since) continue
    const from = m.user ? await slackName(cfg, s, m.user) : clip(m.username || 'someone', 60)
    const where = m.channel.is_im ? 'Direct message' : m.channel.is_mpim ? 'Group DM' : `#${clip(m.channel.name ?? 'channel', 50)}`
    out.push({
      id: `${m.channel.id}:${m.ts}`,
      provider: 'slack',
      from,
      title: `${from} in ${where}`,
      preview: clip(await slackPlain(m.text, (u) => slackName(cfg, s, u)), 220),
      where,
      at,
      important: true,
      canReply: s.canSend,
    })
  }
  return out
}

async function slackReply(cfg: ServerConfig, s: TaskSession, messageId: string, body: string): Promise<{ id: string; to: string; at: number }> {
  const [channel, ts] = messageId.split(':')
  if (!channel || !ts || !/^[A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(ts)) throw new HttpError(400, 'invalid_message_id')
  const b = await slackCall(cfg, s, 'chat.postMessage', { channel, text: body, thread_ts: ts }, true)
  const posted = z.object({ ts: z.string(), channel: z.string(), message: z.object({ text: z.string().optional() }).optional() }).safeParse(b)
  // verified by the provider: Slack returns the stored message; it must match what the user approved
  if (!posted.success || posted.data.channel !== channel || (posted.data.message?.text !== undefined && posted.data.message.text !== body)) throw new HttpError(502, 'message_send_unverified')
  return { id: `${channel}:${posted.data.ts}`, to: 'thread', at: Math.round(Number(posted.data.ts) * 1000) }
}

// ---------------------------------------------------------------- public

export async function listInbox(cfg: ServerConfig, s: TaskSession, ack: string[] = []): Promise<{ items: InboxItem[]; label: string; canReply: boolean; captures?: Capture[] }> {
  requireKind(s, 'messages')
  if (s.provider === 'telegram') {
    const t = await telegramList(cfg, s, Date.now(), ack)
    return { items: t.items.slice(0, MAX_ITEMS), label: t.label, canReply: s.canSend, captures: t.captures }
  }
  if (s.provider === 'github') return { items: (await githubList(cfg, s)).slice(0, MAX_ITEMS), label: s.label, canReply: false }
  const items = s.provider === 'gmail' ? await gmailList(cfg, s) : await slackList(cfg, s)
  items.sort((a, b) => b.at - a.at)
  return { items: items.slice(0, MAX_ITEMS), label: s.label, canReply: s.canSend }
}

export const ReplySchema = z.object({
  proposalId: z.string().regex(/^prop_[A-Za-z0-9]{8,40}$/),
  messageId: z.string().min(1).max(256),
  body: z.string().trim().min(1).max(REPLY_MAX),
})

export const MarkReadSchema = z.object({ proposalId: z.string().regex(/^prop_[A-Za-z0-9]{8,40}$/), messageId: z.string().min(1).max(64) })
/** GitHub only: mark a notification thread read (confirm-first, verified, idempotent). */
/** Channel digest (Telegram only): recent posts of the channels and groups your bot can read. */
export async function messageDigest(cfg: ServerConfig, s: TaskSession): Promise<DigestChannel[]> {
  requireKind(s, 'messages')
  if (s.provider !== 'telegram') throw new HttpError(400, 'digest_needs_telegram')
  return telegramDigest(cfg, s)
}

export async function markMessageRead(cfg: ServerConfig, s: TaskSession, input: z.infer<typeof MarkReadSchema>): Promise<{ reconciled: boolean }> {
  requireKind(s, 'messages')
  if (s.provider !== 'github') throw new HttpError(400, 'not_supported')
  if (s.sent.has(input.proposalId)) return { reconciled: true }
  await githubMarkRead(cfg, s, input.messageId)
  s.sent.set(input.proposalId, { id: input.messageId, to: 'read', at: Date.now() })
  return { reconciled: false }
}

export async function replyToMessage(cfg: ServerConfig, s: TaskSession, input: z.infer<typeof ReplySchema>): Promise<{ sent: { id: string; to: string; at: number }; reconciled: boolean }> {
  requireKind(s, 'messages')
  if (!s.canSend || s.provider === 'github') throw new HttpError(403, 'reply_permission_missing')
  // Outgoing messages speak for the user: always clean, regardless of the 18+ companion mode.
  if (containsProfanity(input.body)) throw new HttpError(422, 'outgoing_message_must_be_clean')
  const prior = s.sent.get(input.proposalId)
  if (prior) return { sent: prior, reconciled: true }
  const sent = s.provider === 'gmail' ? await gmailReply(cfg, s, input.messageId, input.body) : s.provider === 'telegram' ? await telegramReply(cfg, s, input.messageId, input.body) : await slackReply(cfg, s, input.messageId, input.body)
  s.sent.set(input.proposalId, sent)
  return { sent, reconciled: false }
}

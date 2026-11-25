import { z } from 'zod'
import type { ServerConfig } from './config'
import { HttpError } from './security'
import type { TaskSession } from './tasks'
import type { Capture, InboxItem } from '../src/shared/messages'
import type { DigestChannel } from '../src/shared/notes'

/**
 * Telegram through the user's OWN bot — no Questling-wide bot, no stored accounts.
 *
 *  - The user creates a bot with @BotFather and pastes its token on the external-browser /link page
 *    (never inside the glasses app). The token lives only in this process's memory for ≤ 12 h.
 *  - Bot mode (no setup beyond the token): direct messages to the bot, and group messages that
 *    @mention the bot or reply to it. Replies are sent by the bot.
 *  - Business mode (Bot API "business connections", no Premium needed since May 2026): when the user
 *    connects the bot under Telegram → Settings → Telegram Business → Chatbots with “reply” rights,
 *    the bot receives the user's own private chats and can reply AS the user within 24 h of an
 *    incoming message. Telegram's own settings decide which chats the bot may see.
 *  - Updates are pulled on demand with getUpdates (no webhook, no background job) and kept in a
 *    small in-memory buffer (≤ 50 messages, ≤ 3 days) because Telegram does not keep them after
 *    they are confirmed. Nothing is written to disk.
 *  - Telegram's Bot API puts the token in the request path; it is only ever sent to the Telegram
 *    API base, never logged, never returned to the client.
 */

export const TELEGRAM_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/
const BUFFER_MAX = 50
const KEEP_MS = 3 * 86400_000
const BUSINESS_REPLY_WINDOW_MS = 24 * 3600_000
const ALLOWED_UPDATES = ['message', 'channel_post', 'business_connection', 'business_message']
/** channel digest: channels where the bot is an admin, groups it is in — memory only, bounded */
const FEED_CHATS = 20
const FEED_POSTS = 30
const FEED_KEEP_MS = 2 * 86400_000

export interface TgItem {
  item: InboxItem
  chatId: number
  messageId: number
  businessConnectionId: string | null
}
export interface TgConnection {
  userId: number
  canReply: boolean
  enabled: boolean
}
export interface TelegramState {
  botId: number
  botUsername: string
  offset: number
  items: Map<string, TgItem>
  connections: Map<string, TgConnection>
  /** “/quest …” notes sent to the bot, kept until the app acknowledges them */
  captures?: Map<string, Capture>
  /** recent posts of channels and groups the bot can read, for the digest */
  feed?: Map<number, { title: string; kind: 'channel' | 'group'; posts: Array<{ id: number; text: string; at: number }> }>
}
const CAPTURE_RE = /^\/(quest|todo|q)(@\w+)?\s+([\s\S]{1,200})$/i

const TgUser = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().default(''), last_name: z.string().optional(), username: z.string().optional() }).passthrough()
const TgChat = z.object({ id: z.number(), type: z.string(), title: z.string().optional(), username: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional() }).passthrough()
const TgMessage = z
  .object({
    message_id: z.number(),
    date: z.number(),
    chat: TgChat,
    from: TgUser.optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    business_connection_id: z.string().optional(),
    reply_to_message: z.object({ from: TgUser.optional() }).passthrough().optional(),
  })
  .passthrough()
type TgMessageT = z.infer<typeof TgMessage>
const TgBusinessConnection = z
  .object({
    id: z.string(),
    user: TgUser,
    date: z.number(),
    is_enabled: z.boolean(),
    rights: z.object({ can_reply: z.boolean().optional() }).passthrough().optional(),
    /** pre-9.0 field, still accepted */
    can_reply: z.boolean().optional(),
  })
  .passthrough()
const TgUpdate = z.object({ update_id: z.number(), message: TgMessage.optional(), channel_post: TgMessage.optional(), business_message: TgMessage.optional(), business_connection: TgBusinessConnection.optional() }).passthrough()
const TgEnvelope = z.object({ ok: z.boolean(), result: z.unknown().optional(), error_code: z.number().optional(), description: z.string().optional() })

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
function name(u: { first_name?: string; last_name?: string; username?: string } | undefined, fallback = 'Someone'): string {
  const n = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()
  return clip(n || (u?.username ? `@${u.username}` : fallback), 80)
}

/** One Bot API call. Errors are mapped to stable codes; Telegram's description is never echoed (it can quote input). */
export async function tgCall(cfg: ServerConfig, token: string, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  if (!TELEGRAM_TOKEN_RE.test(token)) throw new HttpError(400, 'telegram_token_invalid')
  let r: Response
  try {
    r = await fetch(`${cfg.telegram.apiBase}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new HttpError(502, 'telegram_unreachable')
  }
  const env = TgEnvelope.safeParse(await r.json().catch(() => null))
  if (env.success && env.data.ok) return env.data.result
  const code = env.success ? (env.data.error_code ?? r.status) : r.status
  if (code === 401 || code === 404) throw new HttpError(401, 'telegram_token_invalid')
  if (code === 409) throw new HttpError(409, 'telegram_conflict')
  if (code === 403) throw new HttpError(403, 'telegram_forbidden')
  if (code === 429) throw new HttpError(429, 'rate_limited')
  if (code === 400) throw new HttpError(400, 'telegram_rejected')
  throw new HttpError(502, 'telegram_error')
}

/** Validates a pasted bot token: the bot must exist and must not have a webhook (getUpdates would fail). */
export async function inspectBot(cfg: ServerConfig, token: string): Promise<{ botId: number; username: string; businessReady: boolean }> {
  const me = z
    .object({ id: z.number(), is_bot: z.boolean().optional(), username: z.string().optional(), can_connect_to_business: z.boolean().optional() })
    .passthrough()
    .safeParse(await tgCall(cfg, token, 'getMe'))
  if (!me.success || !me.data.username) throw new HttpError(502, 'telegram_malformed_response')
  const hook = z.object({ url: z.string().default('') }).passthrough().safeParse(await tgCall(cfg, token, 'getWebhookInfo'))
  if (hook.success && hook.data.url) throw new HttpError(409, 'telegram_webhook_set')
  return { botId: me.data.id, username: me.data.username, businessReady: me.data.can_connect_to_business === true }
}

function toItem(st: TelegramState, m: TgMessageT, business: TgConnection | null, now: number): TgItem | null {
  const text = m.text ?? m.caption ?? '[attachment]'
  const at = m.date * 1000
  if (now - at > KEEP_MS) return null
  const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup'
  const where = business ? 'Telegram' : isGroup ? clip(m.chat.title ?? 'Group', 60) : `@${st.botUsername}`.slice(0, 60)
  const preview = clip(text, 220)
  return {
    item: {
      id: `${m.chat.id}:${m.message_id}`,
      provider: 'telegram',
      from: name(m.from, m.chat.title ?? 'Someone'),
      title: clip(text.split('\n')[0] ?? text, 160),
      preview,
      where,
      at,
      important: true,
      canReply: business ? business.enabled && business.canReply && now - at < BUSINESS_REPLY_WINDOW_MS : true,
    },
    chatId: m.chat.id,
    messageId: m.message_id,
    businessConnectionId: business ? (m.business_connection_id ?? null) : null,
  }
}

function mentionsBot(st: TelegramState, m: TgMessageT): boolean {
  const t = `${m.text ?? ''} ${m.caption ?? ''}`.toLowerCase()
  return t.includes(`@${st.botUsername.toLowerCase()}`) || m.reply_to_message?.from?.id === st.botId
}

async function connectionFor(cfg: ServerConfig, s: TaskSession, st: TelegramState, id: string): Promise<TgConnection | null> {
  const known = st.connections.get(id)
  if (known) return known
  try {
    const c = TgBusinessConnection.safeParse(await tgCall(cfg, s.accessToken, 'getBusinessConnection', { business_connection_id: id }))
    if (!c.success) return null
    const conn = { userId: c.data.user.id, canReply: !!(c.data.rights?.can_reply ?? c.data.can_reply), enabled: c.data.is_enabled }
    st.connections.set(id, conn)
    return conn
  } catch {
    return null
  }
}

function addToFeed(st: TelegramState, m: TgMessageT, kind: 'channel' | 'group', now: number) {
  const text = (m.text ?? m.caption ?? '').trim()
  const at = m.date * 1000
  if (!text || now - at > FEED_KEEP_MS) return
  st.feed ??= new Map()
  let chat = st.feed.get(m.chat.id)
  if (!chat) {
    if (st.feed.size >= FEED_CHATS) {
      // drop the quietest chat (oldest latest post)
      const oldest = [...st.feed.entries()].sort((x, y) => (x[1].posts[0]?.at ?? 0) - (y[1].posts[0]?.at ?? 0))[0]
      if (oldest) st.feed.delete(oldest[0])
    }
    chat = { title: clip(m.chat.title ?? m.chat.username ?? 'Channel', 80), kind, posts: [] }
    st.feed.set(m.chat.id, chat)
  }
  if (chat.posts.some((p) => p.id === m.message_id)) return
  chat.posts.unshift({ id: m.message_id, text: clip(text, 300), at })
  chat.posts.sort((x, y) => y.at - x.at)
  chat.posts.length = Math.min(chat.posts.length, FEED_POSTS)
}

/** Pulls new updates from Telegram into the in-memory buffers (inbox, captures, digest feed). */
async function pull(cfg: ServerConfig, s: TaskSession, st: TelegramState, now: number) {
  const raw = await tgCall(cfg, s.accessToken, 'getUpdates', { offset: st.offset, timeout: 0, limit: 100, allowed_updates: ALLOWED_UPDATES })
  const updates = z.array(z.unknown()).catch([]).parse(raw)
  for (const u0 of updates) {
    const u = TgUpdate.safeParse(u0)
    if (!u.success) continue
    st.offset = Math.max(st.offset, u.data.update_id + 1)
    const bc = u.data.business_connection
    if (bc) {
      st.connections.set(bc.id, { userId: bc.user.id, canReply: !!(bc.rights?.can_reply ?? bc.can_reply), enabled: bc.is_enabled })
      if (!bc.is_enabled) for (const [k, v] of st.items) if (v.businessConnectionId === bc.id) st.items.delete(k)
      continue
    }
    const bm = u.data.business_message
    if (bm && bm.business_connection_id) {
      const conn = await connectionFor(cfg, s, st, bm.business_connection_id)
      if (!conn || !conn.enabled) continue
      if (bm.from?.id === conn.userId) {
        // the user answered in Telegram itself: that chat no longer needs them
        for (const [k, v] of st.items) if (v.chatId === bm.chat.id && v.item.at <= bm.date * 1000) st.items.delete(k)
        continue
      }
      if (bm.chat.type !== 'private') continue
      const it = toItem(st, bm, conn, now)
      if (it) st.items.set(it.item.id, it)
      continue
    }
    const cp = u.data.channel_post
    if (cp) {
      addToFeed(st, cp, 'channel', now)
      continue
    }
    const m = u.data.message
    if (m && m.from?.id !== st.botId) {
      const isPrivate = m.chat.type === 'private'
      // capture: “/quest Call the bank” in a DM to the bot becomes a quest suggestion (never a write by itself)
      const cap = isPrivate && m.text ? CAPTURE_RE.exec(m.text.trim()) : null
      if (cap) {
        st.captures ??= new Map()
        if (st.captures.size < 20) st.captures.set(`${m.chat.id}:${m.message_id}`, { id: `${m.chat.id}:${m.message_id}`, text: clip(cap[3]!, 200), from: name(m.from), at: m.date * 1000 })
        continue
      }
      if (!isPrivate) addToFeed(st, m, 'group', now)
      if (!isPrivate && !mentionsBot(st, m)) continue
      const it = toItem(st, m, null, now)
      if (it) st.items.set(it.item.id, it)
    }
  }
  for (const [id, chat] of st.feed ?? []) {
    chat.posts = chat.posts.filter((p) => now - p.at <= FEED_KEEP_MS)
    if (!chat.posts.length) st.feed!.delete(id)
  }
}

/** Pulls new updates into the buffer and returns the current inbox (newest first) and pending captures. */
export async function telegramList(cfg: ServerConfig, s: TaskSession, now = Date.now(), ack: string[] = []): Promise<{ items: InboxItem[]; label: string; captures: Capture[] }> {
  const st = s.telegram
  if (!st) throw new HttpError(400, 'wrong_connection_kind')
  for (const id of ack) st.captures?.delete(id)
  await pull(cfg, s, st, now)
  // bounded, expiring buffer
  for (const [k, v] of st.items) if (now - v.item.at > KEEP_MS) st.items.delete(k)
  const sorted = [...st.items.values()].sort((a, b) => b.item.at - a.item.at)
  for (const v of sorted.slice(BUFFER_MAX)) st.items.delete(v.item.id)
  // refresh the 24-hour business reply window on every read
  const items = sorted.slice(0, BUFFER_MAX).map((v) => {
    if (!v.businessConnectionId) return v.item
    const c = st.connections.get(v.businessConnectionId)
    return { ...v.item, canReply: !!c && c.enabled && c.canReply && now - v.item.at < BUSINESS_REPLY_WINDOW_MS }
  })
  const business = [...st.connections.values()].some((c) => c.enabled)
  for (const [k, c] of st.captures ?? []) if (now - c.at > KEEP_MS) st.captures!.delete(k)
  return { items, label: `Telegram · @${st.botUsername}${business ? ' · Business' : ''}`, captures: [...(st.captures?.values() ?? [])].sort((a, b) => a.at - b.at) }
}

export async function telegramReply(cfg: ServerConfig, s: TaskSession, messageId: string, body: string, now = Date.now()): Promise<{ id: string; to: string; at: number }> {
  const st = s.telegram
  if (!st) throw new HttpError(400, 'wrong_connection_kind')
  if (!/^-?\d{1,20}:\d{1,12}$/.test(messageId)) throw new HttpError(400, 'invalid_message_id')
  const it = st.items.get(messageId)
  if (!it) throw new HttpError(404, 'message_not_found')
  if (it.businessConnectionId) {
    const c = st.connections.get(it.businessConnectionId)
    if (!c || !c.enabled || !c.canReply) throw new HttpError(403, 'reply_permission_missing')
    if (now - it.item.at >= BUSINESS_REPLY_WINDOW_MS) throw new HttpError(403, 'telegram_reply_window_closed')
  }
  const sent = TgMessage.safeParse(
    await tgCall(cfg, s.accessToken, 'sendMessage', {
      chat_id: it.chatId,
      text: body,
      reply_parameters: { message_id: it.messageId, allow_sending_without_reply: true },
      ...(it.businessConnectionId ? { business_connection_id: it.businessConnectionId } : {}),
    }),
  )
  // verified by the provider: Telegram returns the stored message; it must be in the same chat with the approved text
  if (!sent.success || sent.data.chat.id !== it.chatId || (sent.data.text !== undefined && sent.data.text !== body)) throw new HttpError(502, 'message_send_unverified')
  st.items.delete(messageId)
  return { id: `${it.chatId}:${sent.data.message_id}`, to: it.item.from, at: sent.data.date * 1000 }
}

/** Channel digest: the channels and groups the bot can read, latest post first (up to 10 posts each). */
export async function telegramDigest(cfg: ServerConfig, s: TaskSession, now = Date.now()): Promise<DigestChannel[]> {
  const st = s.telegram
  if (!st) throw new HttpError(400, 'wrong_connection_kind')
  await pull(cfg, s, st, now)
  return [...(st.feed?.entries() ?? [])]
    .sort((a, b) => (b[1].posts[0]?.at ?? 0) - (a[1].posts[0]?.at ?? 0))
    .map(([id, c]) => ({ id: String(id), title: c.title, kind: c.kind, posts: c.posts.slice(0, 10).map((p) => ({ text: p.text, at: p.at })) }))
}
